import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, createServer, type Server as HttpsServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { CairnClient } from '../core/client.js';
import { CairnServer } from '../core/server.js';
import { hash } from '../core/common.js';
import type { Invite } from '../shared/types.js';

function temporary() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-next-reliability-'));
  return {
    root,
    remove() {
      assert.equal(path.dirname(root), fs.realpathSync.native(tmpdir()));
      assert.ok(path.basename(root).startsWith('cairn-next-reliability-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
function inspect(directory: string) {
  const db = new DatabaseSync(path.join(directory, '.cairn-next-client', 'client.sqlite'), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        'SELECT state,server_state,initialized,server_revision,server_hash FROM document WHERE id=1',
      )
      .get()!;
    return {
      state: Buffer.from(row.state as Uint8Array).toString('base64'),
      serverState: Buffer.from(row.server_state as Uint8Array).toString('base64'),
      initialized: row.initialized,
      revision: row.server_revision,
      serverHash: row.server_hash,
      metadata: db.prepare('SELECT value FROM metadata WHERE id=1').get()!.value,
      outbox: db
        .prepare(
          'SELECT op_id,hex(binary_update) AS binary_update,state,reason FROM outbox ORDER BY seq',
        )
        .all(),
      receipts: db.prepare('SELECT op_id,revision,hash FROM receipts ORDER BY revision').all(),
    };
  } finally {
    db.close();
  }
}
function append(client: CairnClient, value: string): void {
  const doc = client.doc;
  try {
    let update: Uint8Array | undefined;
    doc.on('update', (bytes) => {
      update = bytes;
    });
    const content = doc.getText('content');
    content.insert(content.length, value);
    assert.ok(update);
    client.applyLocalUpdate(update);
  } finally {
    doc.destroy();
  }
}
async function eventually(read: () => boolean, label: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!read()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test(
  'revoked offline member keeps exact durable local changes and outbox after refused reauthentication',
  { timeout: 20000 },
  async () => {
    const fixture = temporary();
    const hostRoot = path.join(fixture.root, 'host');
    const localRoot = path.join(fixture.root, 'client');
    let server: CairnServer | undefined;
    let client: CairnClient | undefined;
    try {
      fs.mkdirSync(hostRoot);
      fs.writeFileSync(path.join(hostRoot, 'collaboration.txt'), 'server baseline\n');
      server = await CairnServer.start({ root: hostRoot, host: '127.0.0.1', port: 0 });
      const invite = server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`);
      client = new CairnClient({ directory: localRoot, invite, name: 'Offline editor' });
      await client.connect();
      client.disconnect();
      append(client, 'LOCAL WORK AFTER DISCONNECT\n');
      const before = client.snapshot();
      const beforeDb = inspect(localRoot);
      assert.equal(before.pending, 1);
      assert.equal(before.rejected, 0);
      assert.equal(before.localSaved, true);
      server.revoke(invite.memberId);
      await assert.rejects(client.connect(), { code: 'AUTH_FAILED' });
      assert.equal(client.snapshot().connection, 'error');
      assert.equal(client.snapshot().text, before.text);
      assert.equal(client.snapshot().pending, 1);
      assert.equal(client.snapshot().confirmedRevision, null);
      assert.deepEqual(inspect(localRoot), beforeDb);
      assert.equal(fs.readFileSync(path.join(localRoot, 'collaboration.txt'), 'utf8'), before.text);
      assert.equal(server.status().revision, 0);
      assert.equal(server.status().hash, hash('server baseline\n'));
      const oldId = client.clientId;
      client.close();
      client = undefined;
      client = new CairnClient({ directory: localRoot, invite, name: 'Offline editor' });
      assert.equal(client.clientId, oldId);
      assert.equal(client.snapshot().text, before.text);
      assert.equal(client.snapshot().pending, 1);
      assert.deepEqual(inspect(localRoot), beforeDb);
      await assert.rejects(client.connect(), { code: 'AUTH_FAILED' });
      assert.deepEqual(inspect(localRoot), beforeDb);
    } finally {
      client?.close();
      await server?.stop();
      fixture.remove();
    }
  },
);

interface DelayedSession {
  downstream: WebSocket;
  upstream: WebSocket;
  queued: string[];
  welcomed: boolean;
  released: boolean;
  dropped: number;
}
/** A real TLS/WSS relay delays genuine authenticated server packets. It never
 * fabricates welcome, document state, authorization, or persistence outcomes. */
class WelcomeGate {
  readonly sessions: DelayedSession[] = [];
  private https: HttpsServer;
  private websocket: WebSocketServer;
  private agent: Agent;
  private constructor(invite: Invite, key: string) {
    this.agent = new Agent({
      ca: invite.certificate,
      rejectUnauthorized: true,
      servername: `cairn-${invite.serverId}`,
      minVersion: 'TLSv1.2',
    });
    this.https = createServer({ cert: invite.certificate, key, minVersion: 'TLSv1.2' });
    this.websocket = new WebSocketServer({
      server: this.https,
      path: '/cairn',
      perMessageDeflate: false,
    });
    this.websocket.on('connection', (downstream) => {
      const transportOptions = {
        agent: this.agent,
        servername: `cairn-${invite.serverId}`,
        perMessageDeflate: false,
      };
      const upstream = new WebSocket(invite.address, transportOptions);
      const session: DelayedSession = {
        downstream,
        upstream,
        queued: [],
        welcomed: false,
        released: false,
        dropped: 0,
      };
      this.sessions.push(session);
      const outbound: string[] = [];
      downstream.on('error', () => {});
      upstream.on('error', () => {});
      downstream.on('message', (bytes) => {
        const text = bytes.toString();
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else outbound.push(text);
      });
      upstream.on('open', () => {
        for (const message of outbound) upstream.send(message);
        outbound.length = 0;
      });
      upstream.on('message', (bytes) => {
        const message = bytes.toString();
        if (JSON.parse(message).type === 'welcome') session.welcomed = true;
        if (session.released) {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(message);
          else session.dropped++;
        } else session.queued.push(message);
      });
    });
  }
  static async start(invite: Invite, key: string) {
    const gate = new WelcomeGate(invite, key);
    await new Promise<void>((resolve, reject) => {
      gate.https.once('error', reject);
      gate.https.listen(0, '127.0.0.1', resolve);
    });
    return gate;
  }
  get address() {
    const address = this.https.address();
    assert.ok(address && typeof address === 'object');
    return `wss://127.0.0.1:${address.port}/cairn`;
  }
  async welcome(index: number) {
    await eventually(
      () => this.sessions[index]?.welcomed === true,
      'genuine authenticated welcome reaches delayed relay',
    );
  }
  release(index: number) {
    const session = this.sessions[index]!;
    session.released = true;
    for (const message of session.queued) {
      if (session.downstream.readyState === WebSocket.OPEN) session.downstream.send(message);
      else session.dropped++;
    }
    session.queued.length = 0;
  }
  async close() {
    for (const session of this.sessions) {
      session.downstream.terminate();
      session.upstream.terminate();
    }
    this.agent.destroy();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve) => this.https.close(() => resolve()));
  }
}

test(
  'cancelled authenticated join cannot initialize from delayed welcome or complete a later attempt',
  { timeout: 20000 },
  async () => {
    const fixture = temporary();
    const hostRoot = path.join(fixture.root, 'host');
    const localRoot = path.join(fixture.root, 'client');
    let server: CairnServer | undefined;
    let client: CairnClient | undefined;
    let gate: WelcomeGate | undefined;
    try {
      fs.mkdirSync(hostRoot);
      fs.writeFileSync(path.join(hostRoot, 'collaboration.txt'), 'authenticated project content\n');
      server = await CairnServer.start({ root: hostRoot, host: '127.0.0.1', port: 0 });
      const invite = server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`);
      const inspectHost = new DatabaseSync(path.join(hostRoot, '.cairn-next', 'server.sqlite'), {
        readOnly: true,
      });
      let key: string;
      try {
        key = inspectHost.prepare('SELECT private_key FROM project WHERE singleton=1').get()!
          .private_key as string;
      } finally {
        inspectHost.close();
      }
      gate = await WelcomeGate.start(invite, key);
      client = new CairnClient({
        directory: localRoot,
        invite: { ...invite, address: gate.address },
        name: 'Cancelled participant',
      });
      const initial = inspect(localRoot);
      const cancelled = assert.rejects(client.connect(), { code: 'CANCELLED' });
      await gate.welcome(0);
      assert.equal(client.snapshot().connection, 'connecting');
      assert.equal(client.snapshot().initialized, false);
      assert.equal(fs.existsSync(path.join(localRoot, 'collaboration.txt')), false);
      client.disconnect();
      await cancelled;
      await eventually(
        () => gate!.sessions[0]!.downstream.readyState === WebSocket.CLOSED,
        'cancelled transport closes',
      );
      assert.equal(client.snapshot().connection, 'offline');
      assert.deepEqual(inspect(localRoot), initial);

      // A fresh attempt is pending while the prior authenticated response is released.
      const replacement = client.connect();
      await gate.welcome(1);
      gate.release(0);
      assert.ok(
        gate.sessions[0]!.dropped > 0,
        'previous real response is discarded at the cancelled connection',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(client.snapshot().connection, 'connecting');
      assert.equal(client.snapshot().initialized, false);
      assert.deepEqual(inspect(localRoot), initial);
      gate.release(1);
      await replacement;
      assert.equal(client.snapshot().connection, 'online');
      assert.equal(client.snapshot().initialized, true);
      assert.equal(client.snapshot().text, 'authenticated project content\n');
      assert.equal(
        fs.readFileSync(path.join(localRoot, 'collaboration.txt'), 'utf8'),
        'authenticated project content\n',
      );
      assert.equal(client.snapshot().pending, 0);
    } finally {
      client?.close();
      await gate?.close();
      await server?.stop();
      fixture.remove();
    }
  },
);

test(
  'joining a different real project with an existing cache refuses identity change and preserves database bytes',
  { timeout: 20000 },
  async () => {
    const fixture = temporary();
    const localRoot = path.join(fixture.root, 'client');
    let first: CairnServer | undefined;
    let second: CairnServer | undefined;
    let client: CairnClient | undefined;
    try {
      first = await CairnServer.start({
        root: path.join(fixture.root, 'first-host'),
        host: '127.0.0.1',
        port: 0,
      });
      second = await CairnServer.start({
        root: path.join(fixture.root, 'second-host'),
        host: '127.0.0.1',
        port: 0,
      });
      const firstInvite = first.invite('editor', `wss://127.0.0.1:${first.status().port}/cairn`);
      const secondInvite = second.invite('editor', `wss://127.0.0.1:${second.status().port}/cairn`);
      assert.notEqual(firstInvite.projectId, secondInvite.projectId);
      client = new CairnClient({
        directory: localRoot,
        invite: firstInvite,
        name: 'Project owner',
      });
      await client.connect();
      client.disconnect();
      append(client, 'UNSENT FIRST PROJECT CONTENT');
      const before = client.snapshot();
      const beforeRows = inspect(localRoot);
      client.close();
      client = undefined;
      const database = path.join(localRoot, '.cairn-next-client', 'client.sqlite');
      const beforeDbHash = hash(fs.readFileSync(database));
      const beforeFileHash = hash(fs.readFileSync(path.join(localRoot, 'collaboration.txt')));
      assert.throws(
        () =>
          new CairnClient({ directory: localRoot, invite: secondInvite, name: 'Project owner' }),
        { code: 'IDENTITY_MISMATCH' },
      );
      assert.equal(
        hash(fs.readFileSync(database)),
        beforeDbHash,
        'failed project switch preserves SQLite file bytes',
      );
      assert.equal(
        hash(fs.readFileSync(path.join(localRoot, 'collaboration.txt'))),
        beforeFileHash,
      );
      assert.deepEqual(inspect(localRoot), beforeRows);
      client = new CairnClient({
        directory: localRoot,
        invite: firstInvite,
        name: 'Project owner',
      });
      assert.equal(client.snapshot().text, before.text);
      assert.equal(client.snapshot().pending, 1);
      assert.equal(client.snapshot().projectId, firstInvite.projectId);
      assert.deepEqual(inspect(localRoot), beforeRows);
      assert.equal(first.status().revision, 0);
      assert.equal(second.status().revision, 0);
    } finally {
      client?.close();
      await first?.stop();
      await second?.stop();
      fixture.remove();
    }
  },
);
