import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { CairnClient } from '../core/client.js';
import { CairnServer } from '../core/server.js';
import { hash } from '../core/common.js';
import type { ClientSnapshot } from '../shared/types.js';

/** Raw TCP forwarding leaves TLS authentication and WSS control frames end-to-end.
 * Blackhole mode discards bytes without FIN, RST, fake replies, or TLS termination. */
class TcpBlackhole {
  readonly sessions: { downstream: Socket; upstream: Socket }[] = [];
  blackhole = false;
  private readonly listener: Server;
  private constructor(upstreamPort: number) {
    this.listener = createServer((downstream) => {
      const upstream = connect({ host: '127.0.0.1', port: upstreamPort });
      this.sessions.push({ downstream, upstream });
      downstream.on('data', (bytes) => {
        if (!this.blackhole) upstream.write(bytes);
      });
      upstream.on('data', (bytes) => {
        if (!this.blackhole) downstream.write(bytes);
      });
      downstream.on('error', () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
      downstream.on('close', () => upstream.destroy());
      upstream.on('close', () => downstream.destroy());
    });
  }
  static async start(upstreamPort: number): Promise<TcpBlackhole> {
    const relay = new TcpBlackhole(upstreamPort);
    await new Promise<void>((resolve, reject) => {
      relay.listener.once('error', reject);
      relay.listener.listen(0, '127.0.0.1', resolve);
    });
    return relay;
  }
  get port(): number {
    const address = this.listener.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  }
  async close(): Promise<void> {
    for (const session of this.sessions) {
      session.downstream.destroy();
      session.upstream.destroy();
    }
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
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

async function eventually(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Liveness state did not reach expected value');
    await delay(10);
  }
}

test(
  'TCP blackhole leaves sockets open but client heartbeat expires and durable outbox reconnects',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'cairn-next-liveness-'));
    let server: CairnServer | undefined;
    let relay: TcpBlackhole | undefined;
    let client: CairnClient | undefined;
    try {
      server = await CairnServer.start({
        root: path.join(directory, 'host'),
        port: 0,
        host: '127.0.0.1',
      });
      relay = await TcpBlackhole.start(server.status().port);
      const invite = server.invite('editor', `wss://127.0.0.1:${relay.port}/cairn`);
      const localRoot = path.join(directory, 'client');
      client = new CairnClient({ directory: localRoot, invite, name: 'Liveness editor' });
      await client.connect();
      append(client, 'acknowledged baseline\n');
      await eventually(() => client!.snapshot().pending === 0 && server!.status().revision === 1);
      assert.equal(client.snapshot().connection, 'online');

      const started = Date.now();
      const relaySession = relay.sessions[0]!;
      relay.blackhole = true;
      let expired: ClientSnapshot | undefined;
      let elapsed = 0;
      client.on('state', (state: ClientSnapshot) => {
        if (state.error?.code === 'HEARTBEAT_TIMEOUT') {
          expired = state;
          elapsed = Date.now() - started;
        }
      });
      append(client, 'durable while network is unresponsive\n');
      assert.equal(client.snapshot().pending, 1);
      await delay(11000);
      // This is not a clean close test: both TCP ends still exist while bytes disappear.
      assert.equal(relaySession.downstream.destroyed, false);
      assert.equal(relaySession.upstream.destroyed, false);
      assert.equal(client.snapshot().connection, 'online');
      assert.equal(server.status().revision, 1);
      await eventually(() => !!expired, 8000);
      assert.ok(expired);
      assert.equal(expired.connection, 'offline');
      assert.equal(expired.pending, 1);
      assert.equal(expired.localSaved, true);
      assert.equal(expired.confirmedRevision, null);
      assert.match(expired.error!.message, /응답이 확인되지/);
      assert.ok(elapsed >= 14000 && elapsed <= 18000, `heartbeat latency ${elapsed} ms`);
      t.diagnostic(`Unresponsive end-to-end TLS link detected in ${elapsed} ms`);

      const db = new DatabaseSync(path.join(localRoot, '.cairn-next-client', 'client.sqlite'), {
        readOnly: true,
      });
      try {
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM outbox WHERE state='pending'").get()!.count,
          1,
        );
        const pending = db.prepare('SELECT binary_update FROM outbox').get()!;
        assert.ok((pending.binary_update as Uint8Array).byteLength > 0);
      } finally {
        db.close();
      }
      assert.equal(
        fs.readFileSync(path.join(localRoot, 'collaboration.txt'), 'utf8'),
        expired.text,
      );

      relay.blackhole = false;
      // No explicit connect call: the existing bounded reconnect path must recover.
      await eventually(
        () =>
          client!.snapshot().connection === 'online' &&
          client!.snapshot().pending === 0 &&
          server!.status().revision === 2,
      );
      assert.equal(client.snapshot().text, expired.text);
      assert.equal(server.status().hash, hash(expired.text));
      assert.ok(relay.sessions.length >= 2);

      client.close();
      client = undefined;
      // A closed client must not leave a reconnect task running.
      const sessionsAfterClose = relay.sessions.length;
      await delay(600);
      assert.equal(relay.sessions.length, sessionsAfterClose);
    } finally {
      client?.close();
      await relay?.close();
      await server?.stop();
      assert.equal(path.dirname(directory), fs.realpathSync.native(tmpdir()));
      assert.ok(path.basename(directory).startsWith('cairn-next-liveness-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
