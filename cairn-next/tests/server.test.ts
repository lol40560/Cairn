import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { Agent } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, modifyAwarenessUpdate } from 'y-protocols/awareness';
import { CairnServer } from '../core/server.js';
import { b64, hash } from '../core/common.js';
import type { Invite, ServerMessage } from '../shared/types.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'cairn-next-server-'));
  return {
    directory,
    remove: () => {
      assert.ok(path.resolve(directory).startsWith(path.join(tmpdir(), 'cairn-next-server-')));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
class Wire {
  messages: ServerMessage[] = [];
  socket: WebSocket;
  waiters = new Set<() => void>();
  private agent: Agent;
  constructor(invite: Invite) {
    this.agent = new Agent({
      ca: invite.certificate,
      servername: `cairn-${invite.serverId}`,
      rejectUnauthorized: true,
      checkServerIdentity: (name, cert) => {
        const error = checkServerIdentity(name, cert);
        if (error) return error;
        if (hash(cert.raw) !== invite.fingerprint.replaceAll(':', '').toLowerCase())
          return new Error('pin mismatch');
      },
    });
    this.socket = new WebSocket(invite.address, { agent: this.agent });
    this.socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const wake of this.waiters) wake();
    });
  }
  async open() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
  hello(invite: Invite, extra: Record<string, unknown> = {}) {
    this.send({
      type: 'hello',
      version: 1,
      serverId: invite.serverId,
      projectId: invite.projectId,
      fileId: invite.fileId,
      generation: invite.generation,
      token: invite.token,
      clientId: randomUUID(),
      name: 'test',
      ...extra,
    });
  }
  async next<T extends ServerMessage['type']>(
    type: T,
    predicate?: (value: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 4000);
      const check = () => {
        const index = this.messages.findIndex(
          (m) =>
            m.type === type && (!predicate || predicate(m as Extract<ServerMessage, { type: T }>)),
        );
        if (index < 0) return;
        const value = this.messages.splice(index, 1)[0]!;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value as Extract<ServerMessage, { type: T }>);
      };
      this.waiters.add(check);
      check();
    });
  }
  close() {
    this.socket.terminate();
    this.agent.destroy();
  }
}
async function joined(server: CairnServer, role: 'owner' | 'editor' | 'viewer' = 'editor') {
  const invite = server.invite(role, `wss://127.0.0.1:${server.status().port}/cairn`);
  const wire = new Wire(invite);
  await wire.open();
  wire.hello(invite);
  const welcome = await wire.next('welcome');
  const doc = new Y.Doc();
  doc.getText('content');
  Y.applyUpdate(doc, Buffer.from(welcome.state, 'base64'));
  return { invite, wire, welcome, doc };
}
function insertion(doc: Y.Doc, text: string, index = 0) {
  let update: Uint8Array | undefined;
  const listener = (value: Uint8Array) => {
    update = value;
  };
  doc.on('update', listener);
  doc.getText('content').insert(index, text);
  doc.off('update', listener);
  assert.ok(update);
  return b64(update);
}
async function eventually(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('WSS durable operation, duplicate ID, restart identity and disk projection', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    fs.writeFileSync(path.join(f.directory, 'collaboration.txt'), 'base\n');
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const a = await joined(server);
    wires.push(a.wire);
    assert.equal(a.doc.getText('content').toString(), 'base\n');
    const update = insertion(a.doc, '한글 中文\n');
    const opId = randomUUID();
    const message = { type: 'update', opId, fileId: a.invite.fileId, generation: 1, update };
    a.wire.send(message);
    const ack = await a.wire.next('ack');
    assert.equal(ack.revision, 1);
    const read = new DatabaseSync(path.join(f.directory, '.cairn-next', 'server.sqlite'), {
      readOnly: true,
    });
    const row = read.prepare('SELECT revision,state,hash FROM project').get()!;
    assert.equal(row.revision, 1);
    const saved = new Y.Doc();
    saved.getText('content');
    Y.applyUpdate(saved, row.state as Uint8Array);
    assert.equal(saved.getText('content').toString(), '한글 中文\nbase\n');
    assert.equal(hash(saved.getText('content').toString()), row.hash);
    read.close();
    saved.destroy();
    a.wire.send(message);
    assert.equal((await a.wire.next('ack')).revision, 1);
    assert.equal(server.status().revision, 1);
    a.wire.send({ ...message, update: insertion(a.doc, 'different') });
    assert.equal((await a.wire.next('error')).code, 'OP_ID_COLLISION');
    await eventually(() => server!.status().projection === 'applied');
    assert.equal(
      fs.readFileSync(path.join(f.directory, 'collaboration.txt'), 'utf8'),
      '한글 中文\nbase\n',
    );
    const previous = server.status();
    a.wire.close();
    a.doc.destroy();
    await server.stop();
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    assert.equal(server.status().serverId, previous.serverId);
    assert.equal(server.status().fileId, previous.fileId);
    assert.equal(server.status().generation, previous.generation);
    assert.equal(server.status().revision, 1);
    const b = await joined(server);
    wires.push(b.wire);
    assert.equal(b.doc.getText('content').toString(), '한글 中文\nbase\n');
    assert.equal(
      new X509Certificate(b.invite.certificate).fingerprint256.replaceAll(':', '').toLowerCase(),
      b.invite.fingerprint,
    );
    b.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('authentication, protocol version, expiry, generation and viewer are enforced before writes', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const invite = server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`);
    for (const [extra, code] of [
      [{ token: 'wrong-token-123456789' }, 'AUTH_FAILED'],
      [{ version: 999 }, 'VERSION_MISMATCH'],
      [{ generation: 2 }, 'STALE_GENERATION'],
    ] as const) {
      const wire = new Wire(invite);
      wires.push(wire);
      await wire.open();
      wire.hello(invite, extra);
      assert.equal((await wire.next('error')).code, code);
      assert.equal(
        wire.messages.some((m) => m.type === 'welcome'),
        false,
      );
      wire.close();
    }
    const expired = server.invite('editor', invite.address, 1);
    await new Promise((r) => setTimeout(r, 5));
    const denied = new Wire(expired);
    wires.push(denied);
    await denied.open();
    denied.hello(expired);
    assert.equal((await denied.next('error')).code, 'INVITE_EXPIRED');
    const viewer = await joined(server, 'viewer');
    wires.push(viewer.wire);
    viewer.wire.send({
      type: 'update',
      opId: randomUUID(),
      fileId: invite.fileId,
      generation: 1,
      update: insertion(viewer.doc, 'forbidden'),
    });
    assert.equal((await viewer.wire.next('error')).code, 'READ_ONLY');
    assert.equal(server.status().revision, 0);
    assert.equal(fs.readFileSync(path.join(f.directory, 'collaboration.txt'), 'utf8'), '');
    viewer.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('single project owner, revoked live access and external disk changes are preserved', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    await assert.rejects(CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' }), {
      code: 'PROJECT_BUSY',
    });
    const a = await joined(server);
    wires.push(a.wire);
    fs.writeFileSync(path.join(f.directory, 'collaboration.txt'), 'external unsynced');
    a.wire.send({
      type: 'update',
      opId: randomUUID(),
      fileId: a.invite.fileId,
      generation: 1,
      update: insertion(a.doc, 'server version'),
    });
    await a.wire.next('ack');
    await eventually(() => server!.status().projection === 'blocked');
    assert.equal(
      fs.readFileSync(path.join(f.directory, 'collaboration.txt'), 'utf8'),
      'external unsynced',
    );
    const recovery = path.join(f.directory, '.cairn-next', 'recovery');
    assert.ok(
      fs
        .readdirSync(recovery)
        .some((name) => fs.readFileSync(path.join(recovery, name), 'utf8') === 'external unsynced'),
    );
    server.revoke(a.invite.memberId);
    assert.equal((await a.wire.next('error')).code, 'ACCESS_REVOKED');
    assert.equal(server.status().revision, 1);
    a.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('concurrent Yjs edits converge and confirmation requires matching connected peer hashes', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const a = await joined(server);
    const b = await joined(server);
    wires.push(a.wire, b.wire);
    a.wire.send({
      type: 'update',
      opId: randomUUID(),
      fileId: a.invite.fileId,
      generation: 1,
      update: insertion(a.doc, 'Alice'),
    });
    b.wire.send({
      type: 'update',
      opId: randomUUID(),
      fileId: b.invite.fileId,
      generation: 1,
      update: insertion(b.doc, 'Bob'),
    });
    await a.wire.next('ack');
    await b.wire.next('ack');
    for (const client of [a, b]) {
      for (let i = 0; i < 2; i++) {
        const message = await client.wire.next('update');
        Y.applyUpdate(client.doc, Buffer.from(message.update, 'base64'));
      }
    }
    assert.equal(a.doc.getText('content').toString(), b.doc.getText('content').toString());
    assert.ok(a.doc.getText('content').toString().includes('Alice'));
    assert.ok(a.doc.getText('content').toString().includes('Bob'));
    await eventually(() => server!.status().projection === 'applied');
    assert.equal(server.status().confirmedRevision, null);
    const revision = server.status().revision;
    const correct = server.status().hash;
    a.wire.send({ type: 'applied', revision, hash: correct, projection: 'applied' });
    b.wire.send({ type: 'applied', revision, hash: '0'.repeat(64), projection: 'applied' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.status().confirmedRevision, null);
    b.wire.send({ type: 'applied', revision, hash: correct, projection: 'applied' });
    await eventually(() => server!.status().confirmedRevision === revision);
    a.doc.destroy();
    b.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('failed durable transaction emits no ACK, rolls back op log and keeps memory at last committed state', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const a = await joined(server);
    wires.push(a.wire);
    const inspect = new DatabaseSync(path.join(f.directory, '.cairn-next', 'server.sqlite'));
    inspect.exec(
      "CREATE TRIGGER fail_save BEFORE UPDATE OF state ON project BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;",
    );
    const opId = randomUUID();
    const message = {
      type: 'update',
      opId,
      fileId: a.invite.fileId,
      generation: 1,
      update: insertion(a.doc, 'must not ACK'),
    };
    a.wire.send(message);
    assert.equal((await a.wire.next('error')).code, 'SERVER_SAVE_FAILED');
    assert.equal(
      a.wire.messages.some((m) => m.type === 'ack'),
      false,
    );
    assert.equal(server.status().revision, 0);
    assert.equal(inspect.prepare('SELECT count(*) AS n FROM operations').get()!.n, 0);
    const b = await joined(server);
    wires.push(b.wire);
    assert.equal(b.doc.getText('content').toString(), '');
    inspect.exec('DROP TRIGGER fail_save');
    inspect.close();
    a.wire.send(message);
    assert.equal((await a.wire.next('ack')).revision, 1);
    a.doc.destroy();
    b.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('watcher detects external write without new remote edits and own projection creates no new operations', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const a = await joined(server);
    wires.push(a.wire);
    a.wire.send({
      type: 'update',
      opId: randomUUID(),
      fileId: a.invite.fileId,
      generation: 1,
      update: insertion(a.doc, 'known'),
    });
    await a.wire.next('ack');
    await eventually(() => server!.status().projection === 'applied');
    fs.writeFileSync(path.join(f.directory, 'collaboration.txt'), 'external editor save');
    await eventually(() => server!.status().projection === 'blocked');
    assert.equal(server.status().revision, 1);
    assert.equal(
      fs.readFileSync(path.join(f.directory, 'collaboration.txt'), 'utf8'),
      'external editor save',
    );
    const read = new DatabaseSync(path.join(f.directory, '.cairn-next', 'server.sqlite'), {
      readOnly: true,
    });
    assert.equal(read.prepare('SELECT count(*) AS n FROM operations').get()!.n, 1);
    read.close();
    a.doc.destroy();
  } finally {
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});

test('awareness binds cursor identity to its connection and replaces untrusted user labels', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  const wires: Wire[] = [];
  let presence: Awareness | undefined;
  try {
    server = await CairnServer.start({ root: f.directory, port: 0, host: '127.0.0.1' });
    const a = await joined(server);
    const b = await joined(server);
    wires.push(a.wire, b.wire);
    presence = new Awareness(a.doc);
    presence.setLocalState({ user: { name: 'spoofed owner', color: 'unsafe' }, selection: null });
    const update = b64(encodeAwarenessUpdate(presence, [a.doc.clientID]));
    a.wire.send({ type: 'awareness', update });
    const relay = await b.wire.next('awareness');
    modifyAwarenessUpdate(Buffer.from(relay.update, 'base64'), (state) => {
      assert.equal(state.user.name, 'test');
      assert.match(state.user.color, /^#[a-f0-9]{6}$/);
      return state;
    });
    b.wire.send({ type: 'awareness', update });
    assert.equal((await b.wire.next('error')).code, 'AWARENESS_IN_USE');
    presence.setLocalState({ selection: { anchor: null, head: 'bad' } });
    a.wire.send({
      type: 'awareness',
      update: b64(encodeAwarenessUpdate(presence, [a.doc.clientID])),
    });
    assert.equal((await a.wire.next('error')).code, 'INVALID_AWARENESS');
    presence.destroy();
    presence = undefined;
    a.doc.destroy();
    b.doc.destroy();
  } finally {
    presence?.destroy();
    wires.forEach((w) => w.close());
    await server?.stop();
    f.remove();
  }
});
