import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Agent, createServer } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { TeamHost, TeamConnection, parseTeamInvite } from '../core/project/transport.js';
import { TeamDiscovery } from '../core/project/discovery.js';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import { ProjectReplica } from '../core/project/replica.js';
import { b64, hash, unb64 } from '../core/common.js';
import type { ProjectEvent, SnapshotManifest, TeamInvite, TeamStatus } from '../shared/project.js';

function directory() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-project-network-'));
  return {
    root,
    remove() {
      assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'cairn-project-network-')));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
async function fixture() {
  const dir = directory();
  fs.writeFileSync(path.join(dir.root, 'note.txt'), 'start\n');
  const store = new ProjectStore({ root: dir.root, mode: 'authority' });
  new RecoveryService(store);
  const host = await TeamHost.start({ store, name: 'Test team', port: 0 });
  const clients: TeamConnection[] = [];
  return {
    store,
    host,
    root: dir.root,
    async connect(role: 'owner' | 'editor' | 'viewer', name: string = role) {
      const invite = host.invite(role),
        client = new TeamConnection({ invite, clientId: randomUUID(), name });
      clients.push(client);
      await client.connect();
      return { client, invite };
    },
    async close() {
      for (const c of clients) c.close();
      await host.stop();
      store.close();
      dir.remove();
    },
  };
}
async function eventually(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition not reached');
    await delay(20);
  }
}
const code = (expected: string) => (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected);

class RawConnection {
  readonly socket: WebSocket;
  readonly messages: any[] = [];
  private agent: Agent;
  constructor(invite: TeamInvite, autoPong = true) {
    const servername = `cairn-${invite.teamId}`;
    this.agent = new Agent({
      ca: invite.certificate,
      servername,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, cert) =>
        checkServerIdentity(servername, cert) ??
        (hash(cert.raw) === invite.fingerprint ? undefined : new Error('pin mismatch')),
    });
    const options = { agent: this.agent, servername, autoPong };
    this.socket = new WebSocket(invite.address, options);
    this.socket.on('error', () => {});
    this.socket.on('message', (raw) => this.messages.push(JSON.parse(raw.toString())));
  }
  async open() {
    await once(this.socket, 'open');
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
  sendBatch(messages: unknown[]) {
    // One TLS write delivers multiple masked WebSocket frames in the same receiver turn.
    const frames = messages.map((message) => {
      const payload = Buffer.from(JSON.stringify(message));
      assert.ok(payload.length < 65536);
      const extended = payload.length >= 126,
        header = Buffer.alloc(extended ? 8 : 6);
      header[0] = 0x81;
      header[1] = 0x80 | (extended ? 126 : payload.length);
      if (extended) header.writeUInt16BE(payload.length, 2);
      header.fill(0x37, extended ? 4 : 2);
      for (let i = 0; i < payload.length; i++) payload[i] ^= 0x37;
      return Buffer.concat([header, payload]);
    });
    (this.socket as unknown as { _socket: { write(bytes: Uint8Array): boolean } })._socket.write(
      Buffer.concat(frames),
    );
  }
  hello(invite: TeamInvite, extra: Record<string, unknown> = {}) {
    this.send({
      type: 'hello',
      version: 2,
      teamId: invite.teamId,
      projectId: invite.projectId,
      memberId: invite.memberId,
      token: invite.token,
      clientId: randomUUID(),
      name: 'Raw member',
      ...extra,
    });
  }
  async next(predicate: (m: any) => boolean) {
    await eventually(() => this.messages.some(predicate));
    return this.messages.splice(this.messages.findIndex(predicate), 1)[0];
  }
  close() {
    this.socket.terminate();
    this.agent.destroy();
  }
}

test('team WSS discloses no project data before authentication and rejects wrong versions', async () => {
  const f = await fixture();
  try {
    const invite = f.host.invite('viewer');
    for (const method of [
      'snapshot',
      'blob',
      'events',
      'barrier',
      'query',
      'members',
      'command',
      'revoke',
    ]) {
      const raw = new RawConnection(invite);
      try {
        await raw.open();
        raw.send({ type: 'request', id: randomUUID(), method, args: {} });
        const response = await raw.next((m) => m.type === 'response');
        assert.equal(response.ok, false);
        assert.equal(response.error.code, 'AUTH_REQUIRED');
        assert.equal(
          raw.messages.some((m) => ['event', 'welcome', 'status', 'awareness'].includes(m.type)),
          false,
        );
      } finally {
        raw.close();
      }
    }
    const raw = new RawConnection(invite);
    try {
      await raw.open();
      raw.hello(invite, { version: 1 });
      assert.equal((await raw.next((m) => m.type === 'error')).code, 'VERSION_MISMATCH');
    } finally {
      raw.close();
    }
    const invalid = new TeamConnection({
      invite: { ...invite, token: 'invalid-token-value-000000' },
      clientId: randomUUID(),
      name: 'Bad token',
    });
    try {
      await assert.rejects(invalid.connect(), code('AUTH_FAILED'));
    } finally {
      invalid.close();
    }
  } finally {
    await f.close();
  }
});

test('real WSS enforces roles, bounded RPCs, durable command deduplication and chunk hashes', async () => {
  const f = await fixture();
  try {
    const owner = await f.connect('owner'),
      editor = await f.connect('editor'),
      viewer = await f.connect('viewer');
    assert.equal(owner.invite.memberId, f.store.ownerId);
    const command = {
      opId: randomUUID(),
      kind: 'create' as const,
      path: 'new.txt',
      nodeKind: 'text' as const,
      data: b64(Buffer.from('durable\n')),
    };
    const before = f.store.revision();
    const first = await editor.client.request<ProjectEvent>('command', { command });
    assert.equal(first.revision, before + 1);
    assert.equal(f.store.revision(), first.revision);
    assert.equal(f.store.eventsSince(before).length, 1);
    const duplicate = await editor.client.request<ProjectEvent>('command', { command });
    assert.deepEqual(duplicate, first);
    assert.equal(f.store.revision(), first.revision);
    await assert.rejects(
      editor.client.request('command', {
        command: { ...command, data: b64(Buffer.from('different')) },
      }),
      code('OP_ID_COLLISION'),
    );
    await assert.rejects(
      viewer.client.request('command', {
        command: { ...command, opId: randomUUID(), path: 'forbidden.txt' },
      }),
      code('READ_ONLY'),
    );
    for (const protectedCommand of [
      { kind: 'settings', strictClaims: true },
      {
        kind: 'checkpoint-restore',
        checkpointId: randomUUID(),
        expectedRevision: f.store.revision(),
      },
      { kind: 'rescan' },
    ])
      await assert.rejects(
        editor.client.request('command', { command: { opId: randomUUID(), ...protectedCommand } }),
        code('OWNER_REQUIRED'),
      );
    await assert.rejects(
      owner.client.request('command', { command: { opId: randomUUID(), kind: 'claim-expire' } }),
      code('INVALID_MESSAGE'),
    );
    await assert.rejects(
      owner.client.request('query', { query: { kind: 'sql', sql: 'SELECT * FROM team_grants' } }),
      code('INVALID_MESSAGE'),
    );
    await assert.rejects(
      owner.client.request('upload', { hash: '0'.repeat(64), data: '' }),
      code('INVALID_METHOD'),
    );
    const manifest = await viewer.client.request<SnapshotManifest>('snapshot');
    assert.equal(manifest.manifestHash, f.store.manifestHash());
    const file = manifest.files.find((file) => file.path === 'new.txt')!;
    const blob = await viewer.client.request<{
      hash: string;
      offset: number;
      total: number;
      data: string;
    }>('blob', { hash: file.hash, offset: 0, length: 2 });
    assert.equal(blob.total, 8);
    assert.equal(Buffer.from(unb64(blob.data)).toString(), 'du');
    await assert.rejects(
      viewer.client.request('blob', { hash: file.hash, offset: 0, length: 256 * 1024 + 1 }),
      code('INVALID_MESSAGE'),
    );
    await assert.rejects(
      viewer.client.request('blob', { hash: '../../secrets', offset: 0, length: 2 }),
      code('INVALID_MESSAGE'),
    );
    const members = await owner.client.request<unknown>('members');
    assert.equal(JSON.stringify(members).includes('token'), false);
    assert.equal(JSON.stringify(members).includes(owner.invite.token), false);
    await eventually(() => fs.existsSync(path.join(f.root, 'new.txt')));
    assert.equal(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'durable\n');
    const grants = new DatabaseSync(path.join(f.store.dataDir, 'team.sqlite'));
    grants
      .prepare("UPDATE team_grants SET role='viewer' WHERE member_id=?")
      .run(editor.invite.memberId);
    grants.close();
    await assert.rejects(
      editor.client.request('command', {
        command: { ...command, opId: randomUUID(), path: 'changed-role.txt' },
      }),
      code('READ_ONLY'),
    );
    const disconnected = once(editor.client, 'disconnect');
    await owner.client.request('revoke', { memberId: editor.invite.memberId });
    await disconnected;
    await assert.rejects(editor.client.request('snapshot'), code('OFFLINE'));
    const revoked = new TeamConnection({
      invite: editor.invite,
      clientId: randomUUID(),
      name: 'Revoked',
    });
    try {
      await assert.rejects(revoked.connect(), code('AUTH_FAILED'));
    } finally {
      revoked.close();
    }
  } finally {
    await f.close();
  }
});

test('a full 16 MiB blob uses guarded commands and bounded verified download chunks', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect('editor');
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0xa5),
      expected = hash(bytes);
    const result = await client.request<ProjectEvent>('command', {
      command: {
        opId: randomUUID(),
        kind: 'create',
        path: 'large.bin',
        nodeKind: 'binary',
        data: b64(bytes),
      },
    });
    assert.equal(result.changes[0]!.after.hash, expected);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const chunk = await client.request<{
        data: string;
        total: number;
        offset: number;
        hash: string;
      }>('blob', { hash: expected, offset, length: 256 * 1024 });
      assert.equal(chunk.offset, offset);
      assert.equal(chunk.total, bytes.length);
      assert.equal(chunk.hash, expected);
      chunks.push(Buffer.from(unb64(chunk.data, 256 * 1024)));
    }
    assert.equal(hash(Buffer.concat(chunks)), expected);
    await assert.rejects(
      client.request('command', {
        command: {
          opId: randomUUID(),
          kind: 'create',
          path: 'oversize.bin',
          nodeKind: 'binary',
          data: b64(Buffer.alloc(bytes.length + 1)),
        },
      }),
      code('SIZE_LIMIT'),
    );
    assert.equal(
      f.store.files().some((file) => file.path === 'oversize.bin'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('confirmation requires exact issued barrier, local projection and every current peer', async () => {
  const f = await fixture();
  try {
    const a = await f.connect('owner');
    const current = { revision: f.store.revision(), manifestHash: f.store.manifestHash() };
    a.client.sendApplied({ ...current, projection: 'applied' });
    await delay(30);
    assert.equal(f.host.status().confirmedRevision, null);
    await a.client.request('barrier');
    a.client.sendApplied({ ...current, manifestHash: '0'.repeat(64), projection: 'applied' });
    await delay(30);
    assert.equal(f.host.status().confirmedRevision, null);
    a.client.sendApplied({ ...current, projection: 'applied' });
    await eventually(() => f.host.status().confirmedRevision === current.revision);
    const b = await f.connect('viewer');
    assert.equal(f.host.status().confirmedRevision, null);
    const barrier = await b.client.request<{ revision: number; manifestHash: string }>('barrier');
    b.client.sendApplied({ ...barrier, projection: 'applied' });
    await eventually(() => f.host.status().confirmedRevision === current.revision);
    await a.client.request('command', {
      command: { opId: randomUUID(), kind: 'create', path: 'next.txt', nodeKind: 'text', data: '' },
    });
    assert.equal(f.host.status().confirmedRevision, null);
    a.client.sendApplied({ ...current, projection: 'applied' });
    b.client.sendApplied({ ...current, projection: 'applied' });
    await delay(30);
    assert.equal(f.host.status().confirmedRevision, null);
  } finally {
    await f.close();
  }
});

test('a barrier following a committed command in the same WSS batch survives deferred broadcast', async () => {
  const f = await fixture(),
    invite = f.host.invite('editor'),
    raw = new RawConnection(invite);
  try {
    await raw.open();
    raw.hello(invite);
    await raw.next((message) => message.type === 'welcome');
    const commandId = randomUUID(),
      barrierId = randomUUID(),
      opId = randomUUID();
    raw.sendBatch([
      {
        type: 'request',
        id: commandId,
        method: 'command',
        args: {
          command: {
            opId,
            kind: 'create',
            path: 'batched.txt',
            nodeKind: 'text',
            data: b64(Buffer.from('batch commit\n')),
          },
        },
      },
      { type: 'request', id: barrierId, method: 'barrier', args: {} },
    ]);
    const command = await raw.next(
        (message) => message.type === 'response' && message.id === commandId,
      ),
      barrier = await raw.next(
        (message) => message.type === 'response' && message.id === barrierId,
      );
    assert.equal(command.ok, true);
    assert.equal(barrier.ok, true);
    assert.equal(barrier.result.revision, command.result.revision);
    assert.equal(barrier.result.manifestHash, command.result.manifestHash);
    // The deferred committed event has run; it must not erase a newer issued barrier.
    await raw.next((message) => message.type === 'event' && message.event.opId === opId);
    raw.send({ type: 'applied', ...barrier.result, projection: 'applied' });
    await eventually(() => f.host.status().confirmedRevision === barrier.result.revision);
    assert.equal(f.host.status().peers[0]?.projection, 'applied');
    assert.equal(fs.readFileSync(path.join(f.root, 'batched.txt'), 'utf8'), 'batch commit\n');
  } finally {
    raw.close();
    await f.close();
  }
});

test('file awareness binds authenticated names, rejects cursor spoofing and clears on selection/disconnect', async () => {
  const f = await fixture();
  const docs: Y.Doc[] = [],
    awareness: Awareness[] = [];
  try {
    const a = await f.connect('editor', 'Alice'),
      b = await f.connect('editor', 'Bob');
    const first = f.store.files().find((file) => file.kind === 'text')!;
    const created = await a.client.request<ProjectEvent>('command', {
      command: {
        opId: randomUUID(),
        kind: 'create',
        path: 'second.txt',
        nodeKind: 'text',
        data: '',
      },
    });
    const second = created.changes[0]!.after;
    const make = (name: string) => {
      const doc = new Y.Doc(),
        state = new Awareness(doc);
      docs.push(doc);
      awareness.push(state);
      state.setLocalState({ user: { name }, selection: null });
      return state;
    };
    const aa = make('FORGED'),
      bb = make('ALSO FORGED');
    const received: any[] = [];
    b.client.on('awareness', (envelope) => received.push(envelope));
    a.client.awareness({
      fileId: first.id,
      generation: first.generation,
      update: b64(encodeAwarenessUpdate(aa, [aa.clientID])),
    });
    b.client.awareness({
      fileId: first.id,
      generation: first.generation,
      update: b64(encodeAwarenessUpdate(bb, [bb.clientID])),
    });
    await eventually(() => received.length >= 2);
    const display = make('Observer');
    for (const envelope of received)
      applyAwarenessUpdate(display, unb64(envelope.update), 'remote');
    assert.equal(display.getStates().get(aa.clientID)?.user.name, 'Alice');
    const errors: any[] = [];
    b.client.on('error', (error) => errors.push(error));
    b.client.awareness({
      fileId: first.id,
      generation: first.generation,
      update: b64(encodeAwarenessUpdate(aa, [aa.clientID])),
    });
    await eventually(() => errors.some((error) => error.code === 'AWARENESS_IN_USE'));
    received.length = 0;
    a.client.awareness({
      fileId: second.id,
      generation: second.generation,
      update: b64(encodeAwarenessUpdate(aa, [aa.clientID])),
    });
    await eventually(() => received.some((envelope) => envelope.fileId === first.id));
    for (const envelope of received)
      applyAwarenessUpdate(display, unb64(envelope.update), 'remote');
    assert.equal(display.getStates().has(aa.clientID), false);
    a.client.awareness({
      fileId: first.id,
      generation: first.generation,
      update: b64(encodeAwarenessUpdate(aa, [aa.clientID])),
    });
    await delay(30);
    received.length = 0;
    a.client.close();
    await eventually(() => received.length > 0);
    for (const envelope of received)
      applyAwarenessUpdate(display, unb64(envelope.update), 'remote');
    assert.equal(display.getStates().has(aa.clientID), false);
  } finally {
    for (const state of awareness) state.destroy();
    for (const doc of docs) doc.destroy();
    await f.close();
  }
});

test('pinned TLS identity survives LAN toggles and restarts; closing rejects pending work', async () => {
  const f = await fixture();
  let restarted: TeamHost | undefined;
  try {
    const { client, invite } = await f.connect('owner');
    assert.equal(f.host.status().enabled, false);
    const identity = f.host.publicIdentity(),
      port = f.host.status().port;
    await f.host.setLan(true);
    assert.equal(f.host.status().enabled, true);
    assert.deepEqual(f.host.publicIdentity(), identity);
    assert.equal(f.host.status().port, port);
    await f.host.setLan(false);
    assert.equal(f.host.status().enabled, false);
    await f.host.stop();
    restarted = await TeamHost.start({ store: f.store, name: 'Renamed team', port });
    assert.equal(restarted.teamId, identity.teamId);
    assert.equal(restarted.fingerprint, identity.fingerprint);
    const reconnected = new TeamConnection({ invite, clientId: randomUUID(), name: 'Owner again' });
    try {
      await reconnected.connect();
      assert.equal(
        (await reconnected.request<SnapshotManifest>('snapshot')).projectId,
        f.store.projectId,
      );
      const pending = reconnected.request('snapshot');
      const rejected = assert.rejects(pending, code('CONNECTION_CLOSED'));
      reconnected.close();
      await rejected;
    } finally {
      reconnected.close();
    }
    assert.throws(
      () => parseTeamInvite(JSON.stringify({ ...invite, fingerprint: '0'.repeat(64) })),
      code('INVALID_CERTIFICATE'),
    );
    assert.throws(
      () => parseTeamInvite(JSON.stringify({ ...invite, address: `ws://127.0.0.1:${port}/team` })),
      code('INVALID_ADDRESS'),
    );
    assert.throws(
      () => parseTeamInvite(JSON.stringify({ ...invite, expiresAt: 1 })),
      code('INVITE_EXPIRED'),
    );
    const other = await fixture();
    try {
      const wrong = new TeamConnection({
        invite: { ...invite, address: other.host.invite('owner').address },
        clientId: randomUUID(),
        name: 'Wrong server',
      });
      try {
        await assert.rejects(wrong.connect());
      } finally {
        wrong.close();
      }
    } finally {
      await other.close();
    }
    client.close();
  } finally {
    await restarted?.stop();
    await f.close();
  }
});

test('discovery advert allowlist contains no authentication or content and direct WSS needs no discovery', async () => {
  const f = await fixture(),
    discovery = new TeamDiscovery();
  try {
    let advertised: any;
    let stopped = false;
    // Inject only the multicast adapter: assertions inspect exactly what would leave the process.
    (discovery as unknown as { bonjour: unknown }).bonjour = {
      publish(options: unknown) {
        advertised = options;
        return {
          on() {},
          stop() {
            stopped = true;
          },
        };
      },
      destroy() {},
    };
    await f.host.setLan(true);
    const status = {
      ...f.host.status(),
      token: 'MUST_NOT_BE_ADVERTISED',
      secret: 'private project content',
    };
    discovery.advertise(status, f.host.fingerprint);
    assert.deepEqual(Object.keys(advertised.txt).sort(), [
      'fingerprint',
      'name',
      'projectId',
      'teamId',
      'version',
    ]);
    assert.equal(JSON.stringify(advertised).includes('MUST_NOT_BE_ADVERTISED'), false);
    assert.equal(JSON.stringify(advertised).includes('private project content'), false);
    discovery.close();
    assert.equal(stopped, true);
    assert.deepEqual(discovery.list(), []);
    const { client } = await f.connect('viewer');
    assert.equal((await client.request<SnapshotManifest>('snapshot')).projectId, f.store.projectId);
  } finally {
    discovery.close();
    await f.close();
  }
});

test(
  'both heartbeat directions reject unrelated pong nonces and fail near the 15 second deadline',
  { timeout: 26000 },
  async () => {
    const f = await fixture(),
      invite = f.host.invite('viewer'),
      raw = new RawConnection(invite, false);
    const identityDb = new DatabaseSync(path.join(f.store.dataDir, 'team.sqlite'), {
      readOnly: true,
    });
    const identity = identityDb
      .prepare('SELECT private_key,certificate FROM team_identity WHERE singleton=1')
      .get() as { private_key: string; certificate: string };
    identityDb.close();
    const server = createServer({ key: identity.private_key, cert: identity.certificate });
    const wss = new WebSocketServer({ server, autoPong: false });
    let fakePeer: WebSocket | undefined,
      interval: NodeJS.Timeout | undefined,
      connection: TeamConnection | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const bound = server.address();
      assert.ok(bound && typeof bound === 'object');
      wss.on('connection', (socket) => {
        fakePeer = socket;
        socket.on('error', () => {});
        socket.on('message', (message) => {
          const input = JSON.parse(message.toString());
          if (input.type === 'hello')
            socket.send(
              JSON.stringify({ type: 'welcome', role: 'viewer', status: f.host.status() }),
            );
        });
      });
      connection = new TeamConnection({
        invite: { ...invite, address: `wss://127.0.0.1:${bound.port}/team` },
        clientId: randomUUID(),
        name: 'Heartbeat client',
      });
      await Promise.all([connection.connect(), raw.open()]);
      raw.hello(invite);
      await raw.next((m) => m.type === 'welcome');
      const start = Date.now(),
        clientEnd = once(connection, 'disconnect'),
        serverEnd = once(raw.socket, 'close');
      // Both endpoints receive frequent traffic, but none answers an issued random nonce.
      interval = setInterval(() => {
        if (raw.socket.readyState === WebSocket.OPEN) raw.socket.pong('unsolicited');
        if (fakePeer?.readyState === WebSocket.OPEN) fakePeer.pong('unsolicited');
      }, 300);
      const [[failure]] = await Promise.all([clientEnd, serverEnd]);
      assert.equal(failure.code, 'HEARTBEAT_TIMEOUT');
      assert.ok(Date.now() - start >= 14000);
      assert.ok(Date.now() - start < 22000);
    } finally {
      if (interval) clearInterval(interval);
      connection?.close();
      raw.close();
      fakePeer?.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  },
);

test('independent creator process exit ends the team and persisted identity permits restart', async () => {
  const dir = directory();
  const children: ChildProcess[] = [];
  let client: TeamConnection | undefined;
  const storeUrl = new URL('../core/project/store.js', import.meta.url).href,
    transportUrl = new URL('../core/project/transport.js', import.meta.url).href,
    recoveryUrl = new URL('../core/project/recovery.js', import.meta.url).href;
  const script = `const {ProjectStore}=await import(${JSON.stringify(storeUrl)});const {RecoveryService}=await import(${JSON.stringify(recoveryUrl)});const {TeamHost}=await import(${JSON.stringify(transportUrl)});process.on('message',async message=>{try{const store=new ProjectStore({root:message.root,mode:'authority'});new RecoveryService(store);const host=await TeamHost.start({store,name:'Process team',port:message.port??0});process.send({invite:host.invite('owner'),status:host.status()});}catch(e){process.send({error:e.code??'START_FAILED'});}});`;
  const start = async (port?: number) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    children.push(child);
    const reply = once(child, 'message');
    child.send!({ root: dir.root, port });
    const [result] = (await reply) as [{ invite: TeamInvite; status: TeamStatus; error?: string }];
    assert.equal(result.error, undefined);
    return { child, ...result };
  };
  try {
    const first = await start();
    client = new TeamConnection({
      invite: first.invite,
      clientId: randomUUID(),
      name: 'Process owner',
    });
    await client.connect();
    const command = {
      opId: randomUUID(),
      kind: 'create',
      path: 'saved.txt',
      nodeKind: 'text',
      data: b64(Buffer.from('survives creator exit')),
    };
    const committed = await client.request<ProjectEvent>('command', { command });
    const disconnected = once(client, 'disconnect'),
      exit = once(first.child, 'exit');
    first.child.kill();
    await exit;
    await disconnected;
    await assert.rejects(client.request('snapshot'), code('OFFLINE'));
    client.close();
    const second = await start(first.status.port);
    assert.equal(second.status.teamId, first.status.teamId);
    assert.equal(second.invite.fingerprint, first.invite.fingerprint);
    client = new TeamConnection({
      invite: first.invite,
      clientId: randomUUID(),
      name: 'Process owner',
    });
    await client.connect();
    const snapshot = await client.request<SnapshotManifest>('snapshot');
    assert.equal(snapshot.revision, committed.revision);
    assert.equal(
      snapshot.files.find((file) => file.path === 'saved.txt')?.hash,
      hash('survives creator exit'),
    );
    const duplicate = await client.request<ProjectEvent>('command', { command });
    assert.equal(duplicate.revision, committed.revision);
    assert.equal((await client.request<SnapshotManifest>('snapshot')).revision, committed.revision);
  } finally {
    client?.close();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill();
        await exit;
      }
    dir.remove();
  }
});

test('renewing an expired member preserves the exact workcopy identity and durable offline outbox', async () => {
  const f = await fixture(),
    workcopy = directory();
  let replica: ProjectReplica | undefined;
  try {
    const invite = f.host.invite('editor');
    replica = new ProjectReplica({
      root: workcopy.root,
      invite,
      name: 'Returning member',
      watch: false,
    });
    await replica.connect();
    const clientId = replica.clientId,
      file = replica.status().files.find((file) => file.path === 'note.txt')!,
      beforeRevision = f.store.revision();
    replica.disconnect();
    const document = new Y.Doc();
    let pendingState: string;
    try {
      Y.applyUpdate(document, unb64(replica.editorSnapshot(file.id).state));
      const before = Y.encodeStateVector(document);
      document
        .getText('content')
        .insert(document.getText('content').length, 'saved while offline\n');
      replica.applyLocalUpdate(file.id, file.generation, Y.encodeStateAsUpdate(document, before));
      pendingState = replica.editorSnapshot(file.id).state;
    } finally {
      document.destroy();
    }
    const outbox = replica.store.db
      .prepare("SELECT op_id,command FROM outbox WHERE state='pending'")
      .get() as { op_id: string; command: string };
    assert.ok(outbox);
    assert.equal(replica.status().pending, 1);
    assert.equal(
      fs.readFileSync(path.join(workcopy.root, 'note.txt'), 'utf8'),
      'start\nsaved while offline\n',
    );
    assert.equal(fs.readFileSync(path.join(f.root, 'note.txt'), 'utf8'), 'start\n');
    // Expire the authoritative grant without relying on a slow wall-clock sleep.
    const identityDb = new DatabaseSync(path.join(f.store.dataDir, 'team.sqlite'));
    identityDb
      .prepare('UPDATE team_grants SET expires_at=? WHERE token_hash=?')
      .run(Date.now() - 1, hash(invite.token));
    identityDb.close();
    const expired = new TeamConnection({ invite, clientId: randomUUID(), name: 'Old invitation' });
    try {
      await assert.rejects(expired.connect(), code('INVITE_EXPIRED'));
    } finally {
      expired.close();
    }
    const inventory = f.host.members().find((member) => member.memberId === invite.memberId)!;
    assert.equal(inventory.connected, false);
    assert.equal(inventory.revoked, false);
    assert.ok(inventory.expiresAt <= Date.now());
    assert.equal(inventory.name, 'Returning member');
    replica.close();
    replica = undefined;
    const renewed = f.host.invite('editor', invite.address, 86400_000, invite.memberId);
    assert.equal(renewed.memberId, invite.memberId);
    assert.equal(renewed.teamId, invite.teamId);
    assert.ok(renewed.token !== invite.token);
    const replaced = new TeamConnection({
      invite,
      clientId: randomUUID(),
      name: 'Replaced invitation',
    });
    try {
      await assert.rejects(replaced.connect(), code('AUTH_FAILED'));
    } finally {
      replaced.close();
    }
    replica = new ProjectReplica({
      root: workcopy.root,
      invite: renewed,
      name: 'Returning member',
      watch: false,
    });
    assert.equal(replica.clientId, clientId);
    assert.equal(replica.status().actorId, invite.memberId);
    assert.equal(replica.status().pending, 1);
    assert.equal(replica.editorSnapshot(file.id).state, pendingState);
    assert.deepEqual(
      replica.store.db.prepare("SELECT op_id,command FROM outbox WHERE state='pending'").get(),
      outbox,
    );
    await replica.connect();
    await eventually(
      () =>
        replica!.status().pending === 0 &&
        fs.readFileSync(path.join(f.root, 'note.txt'), 'utf8') === 'start\nsaved while offline\n',
    );
    assert.equal(replica.status().rejected, 0);
    assert.equal(
      replica.status().metadata.conflicts.filter((conflict) => conflict.status === 'open').length,
      0,
    );
    assert.equal(
      f.store.eventsSince(beforeRevision).filter((event) => event.opId === outbox.op_id).length,
      1,
    );
    assert.equal(
      f.store.eventsSince(beforeRevision).find((event) => event.opId === outbox.op_id)?.actor.id,
      invite.memberId,
    );
    const receipt = replica.store.db
      .prepare('SELECT op_id FROM receipts WHERE op_id=?')
      .get(outbox.op_id);
    assert.ok(receipt);
    assert.equal(replica.store.root, workcopy.root);
    assert.equal(
      f.host.members().filter((member) => member.memberId === invite.memberId).length,
      1,
    );
  } finally {
    replica?.close();
    workcopy.remove();
    await f.close();
  }
});

test('member renewal validates roles, evicts prior grants and preserves a public offline inventory', async () => {
  const f = await fixture();
  let restarted: TeamHost | undefined;
  const extra: TeamConnection[] = [];
  try {
    const owner = await f.connect('owner', 'Project owner'),
      editor = await f.connect('editor', 'Known member');
    assert.throws(
      () => f.host.invite('editor', undefined, 86400_000, randomUUID()),
      code('MEMBER_NOT_FOUND'),
    );
    assert.throws(
      () => f.host.invite('editor', undefined, 86400_000, 'invalid/member'),
      code('INVALID_MEMBER'),
    );
    assert.throws(
      () => f.host.invite('owner', undefined, 86400_000, editor.invite.memberId),
      code('OWNER_REQUIRED'),
    );
    assert.throws(
      () => f.host.invite('editor', undefined, 86400_000, owner.invite.memberId),
      code('OWNER_REQUIRED'),
    );
    assert.throws(
      () => f.host.invite('admin' as never, undefined, 86400_000, editor.invite.memberId),
      code('INVALID_INVITE'),
    );
    assert.throws(
      () => f.host.invite('viewer', undefined, 0, editor.invite.memberId),
      code('INVALID_INVITE'),
    );
    await editor.client.request('snapshot');
    const evicted = once(editor.client, 'disconnect');
    const viewerInvite = f.host.invite(
      'viewer',
      editor.invite.address,
      86400_000,
      editor.invite.memberId,
    );
    await evicted;
    assert.equal(
      f.host.members().filter((member) => member.memberId === editor.invite.memberId).length,
      1,
    );
    const pending = f.host.members().find((member) => member.memberId === editor.invite.memberId)!;
    assert.equal(pending.role, 'viewer');
    assert.equal(pending.name, 'Known member');
    assert.equal(pending.connected, false);
    assert.equal(pending.revoked, false);
    const old = new TeamConnection({
      invite: editor.invite,
      clientId: randomUUID(),
      name: 'Old token',
    });
    extra.push(old);
    await assert.rejects(old.connect(), code('AUTH_FAILED'));
    const viewer = new TeamConnection({
      invite: viewerInvite,
      clientId: randomUUID(),
      name: 'Different display name',
    });
    extra.push(viewer);
    await viewer.connect();
    assert.equal(
      f.host.status().peers.find((peer) => peer.memberId === editor.invite.memberId)?.name,
      'Different display name',
    );
    const spoofed = new RawConnection(viewerInvite);
    try {
      await spoofed.open();
      spoofed.hello(viewerInvite, { memberId: owner.invite.memberId, name: 'Forged owner name' });
      assert.equal((await spoofed.next((message) => message.type === 'error')).code, 'AUTH_FAILED');
      assert.equal(
        f.host.members().find((member) => member.memberId === owner.invite.memberId)?.name,
        'Project owner',
      );
      assert.equal(
        f.host.members().find((member) => member.memberId === editor.invite.memberId)?.name,
        'Different display name',
      );
    } finally {
      spoofed.close();
    }
    assert.equal(
      f.host.members().find((member) => member.memberId === editor.invite.memberId)?.connected,
      true,
    );
    await assert.rejects(
      viewer.request('command', {
        command: {
          opId: randomUUID(),
          kind: 'create',
          path: 'viewer-forbidden.txt',
          nodeKind: 'text',
          data: '',
        },
      }),
      code('READ_ONLY'),
    );
    await assert.rejects(
      viewer.request('invite', { memberId: editor.invite.memberId, role: 'editor' }),
      code('INVALID_METHOD'),
    );
    const rpcMembers = await owner.client.request<ReturnType<TeamHost['members']>>('members');
    assert.deepEqual(rpcMembers, f.host.members());
    for (const member of rpcMembers)
      assert.deepEqual(Object.keys(member).sort(), [
        'connected',
        'expiresAt',
        'memberId',
        'name',
        'revoked',
        'role',
      ]);
    const visible = JSON.stringify(f.host.status());
    for (const token of [owner.invite.token, editor.invite.token, viewerInvite.token])
      assert.ok(!visible.includes(token));
    assert.ok(!visible.includes('token_hash'));
    assert.ok(!visible.includes('private_key'));
    assert.ok(!visible.includes('certificate'));
    assert.deepEqual(f.host.status().members, f.host.members());
    const dropped = once(viewer, 'disconnect');
    f.host.revoke(editor.invite.memberId);
    await dropped;
    assert.equal(
      f.host.members().find((member) => member.memberId === editor.invite.memberId)?.revoked,
      true,
    );
    const port = f.host.status().port,
      teamId = f.host.teamId;
    await f.host.stop();
    restarted = await TeamHost.start({ store: f.store, name: 'Restarted inventory', port });
    assert.equal(restarted.teamId, teamId);
    const saved = restarted.members().find((member) => member.memberId === editor.invite.memberId)!;
    assert.equal(saved.name, 'Different display name');
    assert.equal(saved.role, 'viewer');
    assert.equal(saved.revoked, true);
    assert.equal(saved.connected, false);
    const restoredInvite = restarted.invite(
        'editor',
        editor.invite.address,
        86400_000,
        editor.invite.memberId,
      ),
      restored = new TeamConnection({
        invite: restoredInvite,
        clientId: randomUUID(),
        name: 'Known member',
      });
    extra.push(restored);
    await restored.connect();
    await restored.request('command', {
      command: {
        opId: randomUUID(),
        kind: 'create',
        path: 'renewed-editor.txt',
        nodeKind: 'text',
        data: '',
      },
    });
    assert.equal(
      restarted.members().find((member) => member.memberId === editor.invite.memberId)?.role,
      'editor',
    );
    assert.equal(
      restarted.members().find((member) => member.memberId === editor.invite.memberId)?.revoked,
      false,
    );
  } finally {
    for (const client of extra) client.close();
    await restarted?.stop();
    await f.close();
  }
});
