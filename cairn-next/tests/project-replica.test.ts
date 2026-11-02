import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import { TeamConnection, TeamHost } from '../core/project/transport.js';
import { ProjectReplica } from '../core/project/replica.js';
import { b64, hash, unb64 } from '../core/common.js';
import type { Actor, ProjectCommand, ProjectEvent, TeamInvite } from '../shared/project.js';
import type { ReplicaStatus } from '../shared/project.js';

async function until(fn: () => boolean, timeout = 10000): Promise<void> {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Replica state did not converge');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function fixture(
  files: Record<string, string | Uint8Array> = {
    'one.txt': 'base\n',
    'closed/two.txt': 'second\n',
  },
) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-project-replica-'));
  const authority = path.join(root, 'authority');
  fs.mkdirSync(authority);
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(authority, name)), { recursive: true });
    fs.writeFileSync(path.join(authority, name), bytes);
  }
  const store = new ProjectStore({ root: authority, mode: 'authority', name: 'Replica test' });
  new RecoveryService(store);
  const host = await TeamHost.start({ store, name: 'Replica test', port: 0, lan: false });
  const clients: ProjectReplica[] = [];
  const actor: Actor = { id: store.ownerId, name: 'Owner', role: 'owner', source: { kind: 'app' } };
  const invite = (role: 'owner' | 'editor' | 'viewer' = 'editor') =>
    host.invite(role, `wss://127.0.0.1:${host.status().port}/team`);
  return {
    root,
    store,
    host,
    actor,
    invite,
    client(name: string, invitation: TeamInvite = invite(), watch = false) {
      const replica = new ProjectReplica({
        root: path.join(root, name),
        invite: invitation,
        name,
        watch,
      });
      clients.push(replica);
      return replica;
    },
    async close() {
      for (const client of clients) client.close();
      await host.stop();
      store.close();
      assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'cairn-project-replica-')));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function insert(client: ProjectReplica, fileId: string, text: string, index = 0): void {
  const snapshot = client.editorSnapshot(fileId);
  const doc = new Y.Doc();
  doc.getText('content');
  Y.applyUpdate(doc, unb64(snapshot.state));
  let update: Uint8Array | undefined;
  doc.on('update', (value: Uint8Array) => {
    update = value;
  });
  doc.getText('content').insert(index, text);
  assert.ok(update);
  try {
    client.applyLocalUpdate(fileId, snapshot.generation, update);
  } finally {
    doc.destroy();
  }
}

test('replica persists binary Yjs and ordered outbox in one database, restores offline edits and syncs closed files', async () => {
  const f = await fixture();
  try {
    const invite = f.invite();
    let alice = f.client('Alice', invite);
    const bob = f.client('Bob');
    await Promise.all([alice.connect(), bob.connect()]);
    const first = f.store.files().find((file) => file.path === 'one.txt')!;
    const closed = f.store.files().find((file) => file.path === 'closed/two.txt')!;
    alice.select(first.id);
    bob.select(first.id);
    alice.disconnect();
    bob.disconnect();
    insert(alice, first.id, '한글 ');
    insert(alice, first.id, 'first ', 0);
    insert(bob, first.id, '中文 ');
    insert(bob, closed.id, 'closed ');
    assert.equal(alice.status().pending, 2);
    assert.equal(bob.status().pending, 2);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Alice', 'one.txt'), 'utf8'),
      alice.editorSnapshot(first.id).text,
    );
    const identity = alice.clientId;
    alice.close();
    alice = f.client('Alice', invite);
    assert.equal(alice.clientId, identity);
    assert.equal(alice.status().pending, 2);
    const persisted = alice.store.db
      .prepare('SELECT state FROM local_docs WHERE file_id=?')
      .get(first.id)!.state as Uint8Array;
    const restored = new Y.Doc();
    restored.getText('content');
    Y.applyUpdate(restored, persisted);
    assert.equal(restored.getText('content').toString(), alice.editorSnapshot(first.id).text);
    restored.destroy();
    assert.equal(
      JSON.stringify(alice.store.db.prepare('SELECT * FROM replica_settings').all()).includes(
        invite.token,
      ),
      false,
    );
    await Promise.all([alice.connect(), bob.connect()]);
    await until(
      () =>
        alice.status().pending === 0 &&
        bob.status().pending === 0 &&
        alice.store.manifestHash() === bob.store.manifestHash(),
    );
    assert.equal(alice.editorSnapshot(first.id).text, bob.editorSnapshot(first.id).text);
    assert.match(alice.editorSnapshot(first.id).text, /한글/);
    assert.match(alice.editorSnapshot(first.id).text, /中文/);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Alice', 'closed', 'two.txt'), 'utf8'),
      'closed second\n',
    );
    assert.equal(Number(alice.store.db.prepare('SELECT count(*) n FROM receipts').get()!.n), 2);
    assert.equal(Number(alice.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n), 0);
    // Host confirmation is broadcast asynchronously to each participant.
    await until(
      () =>
        f.host.status().confirmedRevision === f.store.revision() &&
        alice.status().confirmedRevision === f.store.revision(),
    );
    assert.equal(alice.status().confirmedRevision, f.store.revision());
  } finally {
    await f.close();
  }
});

test('generation replacement and deletion retain rejected binary state and local bytes without resurrection', async () => {
  const f = await fixture();
  try {
    const client = f.client('Offline');
    await client.connect();
    const file = f.store.files().find((file) => file.path === 'one.txt')!;
    const checkpoint = f.store.apply(
      { opId: randomUUID(), kind: 'checkpoint-create', name: 'Before' },
      f.actor,
    );
    client.disconnect();
    insert(client, file.id, 'offline ');
    const cp = String(checkpoint.result?.checkpointId);
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'checkpoint-restore',
        checkpointId: cp,
        expectedRevision: f.store.revision(),
      },
      f.actor,
    );
    await client.connect();
    await until(() => client.status().rejected === 1);
    const conflict = client.status().metadata.conflicts.find((c) => c.id.startsWith('local-'))!;
    assert.ok(conflict.localStateHash);
    assert.equal(Buffer.from(await client.blob(conflict.localHash!)).toString(), 'offline base\n');
    assert.equal(client.editorSnapshot(file.id).text, 'base\n');
    assert.ok(client.editorSnapshot(file.id).generation > file.generation);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Offline', 'one.txt'), 'utf8'),
      'offline base\n',
    );
    assert.equal(client.status().confirmedRevision, null);
    const before = f.store.revision();
    await client.command({
      kind: 'conflict-resolve',
      conflictId: conflict.id,
      choice: 'remote',
      expectedRevision: client.store.file(file.id)!.revision,
    });
    assert.ok(f.store.revision() > before);
    assert.equal(client.status().rejected, 0);
    assert.equal(fs.readFileSync(path.join(f.root, 'Offline', 'one.txt'), 'utf8'), 'base\n');
    client.disconnect();
    insert(client, file.id, 'deleted pending ');
    const current = f.store.file(file.id)!;
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'delete',
        fileId: file.id,
        baseRevision: current.revision,
        expectedRevision: f.store.revision(),
      },
      f.actor,
    );
    await client.connect();
    assert.equal(
      client.status().files.some((item) => item.id === file.id),
      false,
    );
    assert.equal(client.status().rejected, 1);
    assert.equal(f.store.file(file.id)?.deleted, true);
    assert.ok(
      client
        .status()
        .metadata.conflicts.some((c) => c.reason === 'REMOTE_DELETION' && c.status === 'open'),
    );
    const deletionConflict = client
      .status()
      .metadata.conflicts.find((c) => c.reason === 'REMOTE_DELETION' && c.status === 'open')!;
    await client.command({
      kind: 'conflict-resolve',
      conflictId: deletionConflict.id,
      choice: 'local',
      expectedRevision: deletionConflict.current?.revision ?? 0,
    });
    assert.equal(f.store.file(file.id)?.deleted, false);
    assert.equal(client.editorSnapshot(file.id).text, 'deleted pending base\n');
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Offline', 'one.txt'), 'utf8'),
      'deleted pending base\n',
    );
  } finally {
    await f.close();
  }
});

test('initial transfer is pinned and catches concurrent file changes before reporting initialized', async () => {
  const f = await fixture({ 'one.txt': 'initial', 'asset.bin': new Uint8Array(700000).fill(13) });
  const original = TeamConnection.prototype.request;
  let edited = false;
  try {
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const value = (await original.call(this, method, args)) as T;
      if (method === 'blob' && !edited) {
        edited = true;
        f.store.apply(
          {
            opId: randomUUID(),
            kind: 'create',
            path: 'late.txt',
            nodeKind: 'text',
            data: b64(Buffer.from('arrived during transfer')),
          },
          f.actor,
        );
      }
      return value;
    };
    const client = f.client('Transfer');
    await client.connect();
    assert.ok(edited);
    assert.equal(client.status().initialized, true);
    assert.equal(client.status().transfer.stage, 'ready');
    assert.equal(client.store.manifestHash(), f.store.manifestHash());
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Transfer', 'late.txt'), 'utf8'),
      'arrived during transfer',
    );
    assert.equal(
      hash(fs.readFileSync(path.join(f.root, 'Transfer', 'asset.bin'))),
      hash(new Uint8Array(700000).fill(13)),
    );
  } finally {
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('cancelled transfer cannot install late results; retry reuses only verified complete blobs', async () => {
  const f = await fixture({ 'one.txt': 'initial', 'large.bin': new Uint8Array(700000).fill(5) });
  const original = TeamConnection.prototype.request;
  let blocked = false;
  let unblock: (() => void) | undefined;
  let client: ProjectReplica | undefined;
  try {
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const value = (await original.call(this, method, args)) as T;
      if (method === 'blob' && !blocked) {
        blocked = true;
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      return value;
    };
    client = f.client('Cancel');
    const first = client.connect();
    await until(() => blocked);
    client.cancel();
    unblock!();
    await assert.rejects(first, { code: 'CANCELLED' });
    assert.equal(client.status().initialized, false);
    assert.equal(client.status().transfer.stage, 'cancelled');
    assert.equal(fs.existsSync(path.join(f.root, 'Cancel', 'one.txt')), false);
    TeamConnection.prototype.request = original;
    await client.connect();
    assert.equal(client.status().initialized, true);
    assert.equal(client.store.manifestHash(), f.store.manifestHash());
  } finally {
    unblock?.();
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('unmatched workcopy remains untouched, viewers cannot edit, and failed local commit sends nothing', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'Occupied'));
    fs.writeFileSync(path.join(f.root, 'Occupied', 'mine.txt'), 'personal');
    const occupied = f.client('Occupied');
    await assert.rejects(occupied.connect(), { code: 'WORKCOPY_NOT_EMPTY' });
    occupied.disconnect();
    assert.equal(fs.readFileSync(path.join(f.root, 'Occupied', 'mine.txt'), 'utf8'), 'personal');
    const viewer = f.client('Viewer', f.invite('viewer'));
    await viewer.connect();
    const file = viewer.status().files.find((item) => item.kind === 'text')!;
    assert.throws(() => insert(viewer, file.id, 'no'), { code: 'READ_ONLY' });
    const client = f.client('Writer');
    await client.connect();
    const before = f.store.revision();
    const text = client.editorSnapshot(file.id).text;
    client.store.db.exec(
      "CREATE TRIGGER fail_replica_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'simulated full disk'); END",
    );
    assert.throws(() => insert(client, file.id, 'lost?'));
    assert.equal(client.editorSnapshot(file.id).text, text);
    assert.equal(client.status().pending, 0);
    assert.equal(f.store.revision(), before);
    client.store.db.exec('DROP TRIGGER fail_replica_outbox');
    insert(client, file.id, 'saved ');
    await until(() => client.status().pending === 0);
    assert.match(client.editorSnapshot(file.id).text, /saved/);
  } finally {
    await f.close();
  }
});

test('external baseline stays independent of projections, stale saves and offline structure become deduplicated local conflicts', async () => {
  const f = await fixture();
  try {
    const client = f.client('External');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const target = path.join(f.root, 'External', 'one.txt');
    fs.writeFileSync(target, 'external first\n');
    client.retryProjection();
    await until(
      () =>
        client.status().pending === 0 &&
        client.store.file(file.id)!.hash === hash('external first\n'),
    );
    const activity = f.store.eventsSince(0).find((e) => e.kind === 'write');
    assert.equal(activity?.actor.source.kind, 'unknown');
    const remote = f.store.file(file.id)!;
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'write',
        fileId: file.id,
        generation: remote.generation,
        baseHash: remote.hash,
        baseRevision: remote.revision,
        data: b64(Buffer.from('remote second\n')),
      },
      f.actor,
    );
    await until(() => fs.readFileSync(target, 'utf8') === 'remote second\n');
    fs.writeFileSync(target, 'stale external buffer\n');
    client.retryProjection();
    assert.equal(fs.readFileSync(target, 'utf8'), 'stale external buffer\n');
    assert.ok(
      client.status().metadata.conflicts.some((c) => c.reason === 'STALE_EXTERNAL_BASELINE'),
    );
    const count = client.status().metadata.conflicts.length;
    client.retryProjection();
    assert.equal(client.status().metadata.conflicts.length, count);
    client.disconnect();
    fs.writeFileSync(path.join(f.root, 'External', 'new-offline.txt'), 'keep');
    client.retryProjection();
    assert.ok(
      client
        .status()
        .metadata.conflicts.some(
          (c) => c.path === 'new-offline.txt' && c.reason === 'EXTERNAL_CREATE',
        ),
    );
    assert.equal(client.status().pending, 0);
  } finally {
    await f.close();
  }
});

test('own external claim holds disk reflection, and release checks actual external bytes', async () => {
  const f = await fixture();
  try {
    const client = f.client('Claim');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const target = path.join(f.root, 'Claim', 'one.txt');
    const claim = await client.command({
      kind: 'claim-create',
      fileId: file.id,
      description: 'External editor',
      strict: false,
      external: true,
    });
    const current = f.store.file(file.id)!;
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'write',
        fileId: file.id,
        generation: current.generation,
        baseHash: current.hash,
        baseRevision: current.revision,
        data: b64(Buffer.from('remote while held\n')),
      },
      f.actor,
    );
    await until(() => client.store.file(file.id)!.hash === hash('remote while held\n'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'base\n');
    assert.equal(client.status().projections.find((p) => p.fileId === file.id)?.state, 'held');
    fs.writeFileSync(target, 'external held buffer\n');
    await client.command({ kind: 'claim-complete', claimId: String(claim.result?.claimId) });
    assert.equal(fs.readFileSync(target, 'utf8'), 'external held buffer\n');
    assert.ok(
      client.status().metadata.conflicts.some((c) => c.reason === 'STALE_EXTERNAL_BASELINE'),
    );
  } finally {
    await f.close();
  }
});

test('forged operation ACK never clears durable outbox or claims confirmation', async () => {
  const f = await fixture();
  const original = TeamConnection.prototype.request;
  try {
    const client = f.client('Ack');
    await client.connect();
    const file = client.status().files.find((item) => item.kind === 'text')!;
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const value = (await original.call(this, method, args)) as T;
      if (method === 'command') return { ...(value as ProjectEvent), opId: randomUUID() } as T;
      return value;
    };
    insert(client, file.id, 'durable ');
    await until(() => client.status().error?.code === 'INVALID_ACK');
    assert.equal(client.status().pending, 1);
    assert.equal(client.status().confirmedRevision, null);
    assert.equal(Number(client.store.db.prepare('SELECT count(*) n FROM receipts').get()!.n), 0);
    TeamConnection.prototype.request = original;
    await client.connect();
    await until(() => client.status().pending === 0);
    assert.equal((client.editorSnapshot(file.id).text.match(/durable/g) ?? []).length, 1);
  } finally {
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('binary CAS commits exact bytes and rejected writes preserve the submitted bytes for explicit review', async () => {
  const f = await fixture({ 'image.bin': new Uint8Array(300000).fill(1) });
  try {
    const client = f.client('Binary');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'image.bin')!;
    const bytes = new Uint8Array(300000).fill(2);
    await client.command({
      kind: 'write',
      fileId: file.id,
      generation: file.generation,
      baseRevision: file.revision,
      baseHash: file.hash,
      data: b64(bytes),
    });
    assert.equal(client.status().rejected, 0);
    assert.equal(client.store.file(file.id)!.hash, hash(bytes));
    assert.equal(hash(fs.readFileSync(path.join(f.root, 'Binary', 'image.bin'))), hash(bytes));
    const rejected = new Uint8Array(300000).fill(3);
    await assert.rejects(
      client.command({
        kind: 'write',
        fileId: file.id,
        generation: file.generation,
        baseRevision: file.revision,
        baseHash: file.hash,
        data: b64(rejected),
      }),
      { code: 'STALE_REVISION' },
    );
    const conflict = client
      .status()
      .metadata.conflicts.find((c) => c.status === 'open' && c.localHash === hash(rejected));
    assert.ok(conflict);
    assert.equal(hash(await client.blob(conflict.localHash!)), hash(rejected));
    assert.equal(hash(fs.readFileSync(path.join(f.root, 'Binary', 'image.bin'))), hash(bytes));
    await client.command({
      kind: 'conflict-resolve',
      conflictId: conflict.id,
      choice: 'remote',
      expectedRevision: client.store.file(file.id)!.revision,
    });
    assert.equal(client.status().rejected, 0);
  } finally {
    await f.close();
  }
});

test('remote folder moves update every closed child and clean old directories without a retry', async () => {
  const f = await fixture();
  try {
    const client = f.client('Move');
    await client.connect();
    const folder = f.store.files().find((file) => file.path === 'closed')!;
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'move',
        fileId: folder.id,
        path: 'renamed',
        baseRevision: folder.revision,
      },
      f.actor,
    );
    await until(
      () =>
        fs.existsSync(path.join(f.root, 'Move', 'renamed', 'two.txt')) &&
        client.status().projections.every((p) => p.state === 'applied'),
    );
    assert.equal(fs.existsSync(path.join(f.root, 'Move', 'closed')), false);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'Move', 'renamed', 'two.txt'), 'utf8'),
      'second\n',
    );
    assert.equal(client.status().metadata.conflicts.length, 0);
  } finally {
    await f.close();
  }
});

test('a corrupt transfer is never installed or cached as verified content', async () => {
  const f = await fixture({ 'asset.bin': new Uint8Array(700000).fill(9) });
  const original = TeamConnection.prototype.request;
  let damaged = false;
  try {
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const value = (await original.call(this, method, args)) as T;
      if (method === 'blob' && !damaged) {
        damaged = true;
        const chunk = value as { hash: string; offset: number; total: number; data: string };
        const bytes = unb64(chunk.data, 256 * 1024);
        bytes[0] ^= 255;
        return { ...chunk, data: b64(bytes) } as T;
      }
      return value;
    };
    const client = f.client('Corrupt');
    await assert.rejects(client.connect(), { code: 'BLOB_HASH_MISMATCH' });
    assert.equal(client.status().initialized, false);
    assert.equal(client.store.hasBlob(hash(new Uint8Array(700000).fill(9))), false);
    assert.equal(fs.existsSync(path.join(f.root, 'Corrupt', 'asset.bin')), false);
    TeamConnection.prototype.request = original;
    await client.connect();
    assert.equal(
      hash(fs.readFileSync(path.join(f.root, 'Corrupt', 'asset.bin'))),
      hash(new Uint8Array(700000).fill(9)),
    );
  } finally {
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('offline directory changes survive reopening and explicit structural commands resolve their review records', async () => {
  const f = await fixture({ 'empty/.keep': 'keep' });
  try {
    const invite = f.invite();
    let client = f.client('Structure', invite);
    await client.connect();
    client.disconnect();
    fs.mkdirSync(path.join(f.root, 'Structure', 'new-empty'));
    client.retryProjection();
    assert.ok(
      client.status().metadata.conflicts.some((c) => c.path === 'new-empty' && c.status === 'open'),
    );
    assert.equal(client.status().pending, 0);
    client.close();
    client = f.client('Structure', invite);
    assert.equal(fs.existsSync(path.join(f.root, 'Structure', 'new-empty')), true);
    await client.connect();
    await client.command({ kind: 'create', path: 'new-empty', nodeKind: 'directory' });
    assert.ok(
      client
        .status()
        .metadata.conflicts.some((c) => c.path === 'new-empty' && c.status === 'resolved'),
    );
    assert.ok(f.store.files().some((file) => file.path === 'new-empty'));
    const empty = client.status().files.find((file) => file.path === 'new-empty')!;
    client.disconnect();
    fs.rmdirSync(path.join(f.root, 'Structure', 'new-empty'));
    client.close();
    client = f.client('Structure', invite);
    assert.equal(fs.existsSync(path.join(f.root, 'Structure', 'new-empty')), false);
    assert.ok(
      client
        .status()
        .metadata.conflicts.some(
          (c) => c.reason === 'EXTERNAL_DIRECTORY_DELETION' && c.status === 'open',
        ),
    );
    await client.connect();
    await client.command({
      kind: 'delete',
      fileId: empty.id,
      baseRevision: client.store.file(empty.id)!.revision,
      expectedRevision: client.store.revision(),
    });
    assert.equal(fs.existsSync(path.join(f.root, 'Structure', 'new-empty')), false);
    assert.equal(client.status().metadata.conflicts.filter((c) => c.status === 'open').length, 0);
  } finally {
    await f.close();
  }
});

test('live watcher recognizes own projection hashes and sends a safe external save with Unknown source', async () => {
  const f = await fixture();
  try {
    const client = f.client('Watched', f.invite(), true);
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    insert(client, file.id, 'app ');
    await until(() => client.status().pending === 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(client.status().metadata.conflicts.length, 0);
    // An explicit external claim records that the external editor has read the latest projection.
    const claim = await client.command({
      kind: 'claim-create',
      fileId: file.id,
      description: 'Read current file',
      strict: false,
      external: true,
    });
    fs.writeFileSync(path.join(f.root, 'Watched', 'one.txt'), 'watcher save\n');
    await until(
      () => f.store.file(file.id)!.hash === hash('watcher save\n') && client.status().pending === 0,
    );
    await client.command({ kind: 'claim-complete', claimId: String(claim.result?.claimId) });
    assert.equal(client.status().metadata.conflicts.length, 0);
    assert.equal(
      f.store.eventsSince(0).find((event) => event.kind === 'write')!.actor.source.kind,
      'unknown',
    );
  } finally {
    await f.close();
  }
});

test('activity queries include server history from before the initial replica snapshot', async () => {
  const f = await fixture();
  try {
    const event = f.store.apply(
      {
        opId: randomUUID(),
        kind: 'create',
        path: 'historical.txt',
        nodeKind: 'text',
        data: b64(Buffer.from('history')),
      },
      f.actor,
    );
    const client = f.client('History');
    await client.connect();
    const entries = (await client.query({ kind: 'activity' })) as { opId: string }[];
    assert.ok(entries.some((entry) => entry.opId === event.opId));
  } finally {
    await f.close();
  }
});

test('profile name change reconnects the same identity without losing pending edits or watcher state', async () => {
  const f = await fixture();
  const original = TeamConnection.prototype.request;
  let paused = false;
  let release: (() => void) | undefined;
  try {
    const client = f.client('Original name', f.invite(), true);
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const identity = client.clientId;
    client.disconnect();
    insert(client, file.id, 'pending ');
    assert.equal(client.status().pending, 1);
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const value = (await original.call(this, method, args)) as T;
      if (method === 'snapshot' && !paused) {
        paused = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return value;
    };
    const stale = client.connect();
    const staleRejected = assert.rejects(stale, { code: 'CANCELLED' });
    await until(() => paused);
    await client.setName('  Renamed member  ');
    release!();
    await staleRejected;
    assert.equal(client.status().name, 'Renamed member');
    assert.equal(client.clientId, identity);
    assert.equal(client.status().watching, true);
    await until(() => client.status().pending === 0);
    assert.equal(
      f.host.status().peers.find((peer) => peer.clientId === identity)?.name,
      'Renamed member',
    );
    assert.equal(client.editorSnapshot(file.id).text, 'pending base\n');
    assert.equal(
      f.store.eventsSince(0).find((event) => event.kind === 'text')!.actor.name,
      'Renamed member',
    );
    const confirmed = f.host.status().peers.find((peer) => peer.clientId === identity)!;
    assert.equal(confirmed.memberId, client.status().actorId);
    await client.setName('Renamed member');
    assert.equal(client.status().connection, 'online');
    assert.equal(client.status().watching, true);
  } finally {
    release?.();
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('explicit offline profile name change stays offline and rejects invalid names without changing state', async () => {
  const f = await fixture();
  const original = TeamConnection.prototype.connect;
  let connections = 0;
  try {
    const client = f.client('Offline name');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    client.disconnect();
    insert(client, file.id, 'offline ');
    TeamConnection.prototype.connect = async function () {
      connections++;
      return original.call(this);
    };
    await client.setName(' New offline name ');
    assert.equal(connections, 0);
    assert.equal(client.status().connection, 'offline');
    assert.equal(client.status().name, 'New offline name');
    assert.equal(client.status().pending, 1);
    await assert.rejects(client.setName('   '), { code: 'INVALID_NAME' });
    await assert.rejects(client.setName('x'.repeat(61)), { code: 'INVALID_NAME' });
    assert.equal(client.status().name, 'New offline name');
    assert.equal(connections, 0);
    await client.connect();
    await until(() => client.status().pending === 0);
    assert.equal(
      f.host.status().peers.find((peer) => peer.clientId === client.clientId)?.name,
      'New offline name',
    );
    assert.equal(connections, 1);
    assert.equal(client.editorSnapshot(file.id).text, 'offline base\n');
  } finally {
    TeamConnection.prototype.connect = original;
    await f.close();
  }
});

test('confirmation retries pending-to-clean at the same revision when the durable ACK overtakes barrier finalization', async () => {
  const f = await fixture();
  const original = TeamConnection.prototype.request;
  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let releaseBarrier!: () => void;
  const barrierGate = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let commandEvent: ProjectEvent | undefined;
  let armBarrier = false;
  let barrierCallbackRan = false;
  try {
    const client = f.client('Confirmation');
    await client.connect();
    await until(() => f.host.status().confirmedRevision === 0);
    TeamConnection.prototype.request = function <T>(method: string, args: unknown): Promise<T> {
      const result = original.call(this, method, args) as Promise<T>;
      if (method === 'command')
        return result.then(async (value) => {
          commandEvent = value as ProjectEvent;
          await ackGate;
          return value;
        });
      if (method === 'barrier' && armBarrier) {
        armBarrier = false;
        const nativeThen = result.then.bind(result);
        // Hold the barrier continuation after its applied(pending) send, while
        // allowing the real command ACK to commit and call confirm() first.
        Object.defineProperty(result, 'then', {
          value: (fulfilled: (value: T) => unknown, rejected?: (error: unknown) => unknown) =>
            nativeThen(async (value) => {
              const output = fulfilled(value);
              barrierCallbackRan = true;
              await barrierGate;
              return output;
            }, rejected),
        });
      }
      return result;
    };
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    insert(client, file.id, 'confirmed ');
    await until(
      () =>
        !!commandEvent &&
        client.status().revision === 1 &&
        f.host.status().peers[0]?.projection === 'pending',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.status().pending, 1);
    // Retransmission of a committed event invalidates confirmation without
    // changing the catalog revision, just as another pending state report can.
    armBarrier = true;
    f.store.emit('change', commandEvent!);
    await until(() => barrierCallbackRan);
    releaseAck();
    await until(() => client.status().pending === 0);
    assert.equal(client.status().revision, 1);
    assert.equal(f.host.status().peers[0]?.projection, 'pending');
    releaseBarrier();
    await until(
      () => f.host.status().confirmedRevision === 1 && client.status().confirmedRevision === 1,
    );
    assert.equal(f.host.status().peers[0]?.projection, 'applied');
    assert.equal(client.status().rejected, 0);
    assert.equal(Number(client.store.db.prepare('SELECT count(*) n FROM receipts').get()!.n), 1);
  } finally {
    releaseAck();
    releaseBarrier();
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('confirmation barrier mismatch retries are bounded and stop on explicit disconnect', async () => {
  const f = await fixture();
  const original = TeamConnection.prototype.request;
  let barriers = 0;
  try {
    const client = f.client('Barrier backoff');
    await client.connect();
    await until(() => f.host.status().confirmedRevision === 0);
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const result = (await original.call(this, method, args)) as T;
      if (method === 'barrier') {
        barriers++;
        return {
          ...(result as { revision: number; manifestHash: string }),
          revision: client.status().revision + 100,
        } as T;
      }
      return result;
    };
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    insert(client, file.id, 'backoff ');
    await until(() => client.status().pending === 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(barriers >= 2);
    assert.ok(barriers <= 6, `Unexpected barrier burst: ${barriers}`);
    assert.equal(client.status().confirmedRevision, null);
    client.disconnect();
    const stopped = barriers;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(barriers, stopped);
  } finally {
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('download progress is throttled without losing final counters, verified bytes, or cached restart state', async (t) => {
  const binary = new Uint8Array(4 * 1024 * 1024).fill(43);
  const files: Record<string, string | Uint8Array> = { 'asset.bin': binary };
  for (let index = 0; index < 12; index++) files[`history-${index}.txt`] = `History ${index}\n`;
  const f = await fixture(files);
  const original = TeamConnection.prototype.request;
  let clock = 0;
  let blobRequests = 0;
  const reports: { time: number; stage: string; doneBytes: number; doneFiles: number }[] = [];
  const fakeTime = t.mock.method(performance, 'now', () => clock);
  try {
    TeamConnection.prototype.request = async function <T>(
      method: string,
      args: unknown,
    ): Promise<T> {
      const result = (await original.call(this, method, args)) as T;
      if (method === 'blob') {
        blobRequests++;
        clock += 10;
      }
      return result;
    };
    const client = f.client('Progress');
    client.on('state', (status: ReplicaStatus) =>
      reports.push({
        time: clock,
        stage: status.transfer.stage,
        doneBytes: status.transfer.doneBytes,
        doneFiles: status.transfer.doneFiles,
      }),
    );
    await client.connect();
    const complete = client.status();
    const manifest = f.store.snapshot();
    assert.equal(complete.transfer.doneBytes, complete.transfer.totalBytes);
    assert.equal(complete.transfer.doneFiles, complete.transfer.totalFiles);
    assert.equal(
      complete.transfer.doneBytes,
      manifest.blobs.reduce((sum, blob) => sum + blob.size, 0),
    );
    assert.equal(complete.transfer.doneFiles, manifest.blobs.length);
    assert.equal(hash(fs.readFileSync(path.join(f.root, 'Progress', 'asset.bin'))), hash(binary));
    assert.equal(client.store.manifestHash(), f.store.manifestHash());
    const progress = reports
      .filter((report) => report.stage === 'downloading')
      .filter(
        (report, index, all) =>
          index === 0 ||
          report.doneBytes !== all[index - 1].doneBytes ||
          report.doneFiles !== all[index - 1].doneFiles,
      );
    assert.ok(blobRequests > 20);
    assert.ok(progress.length <= 1 + Math.floor(clock / 100));
    for (let index = 1; index < progress.length; index++)
      assert.ok(progress[index].time - progress[index - 1].time >= 100);
    for (const stage of ['manifest', 'downloading', 'catching-up', 'verifying', 'ready'])
      assert.ok(
        reports.some((report) => report.stage === stage),
        `Missing immediate ${stage} stage`,
      );
    client.disconnect();
    reports.length = 0;
    const requestsBefore = blobRequests;
    await client.connect();
    assert.equal(blobRequests, requestsBefore);
    assert.equal(reports.filter((report) => report.stage === 'downloading').length, 1);
    assert.equal(client.status().transfer.doneBytes, complete.transfer.doneBytes);
    assert.equal(client.status().transfer.doneFiles, complete.transfer.doneFiles);
    assert.equal(client.store.manifestHash(), complete.manifestHash);
    assert.equal(hash(fs.readFileSync(path.join(f.root, 'Progress', 'asset.bin'))), hash(binary));
  } finally {
    fakeTime.mock.restore();
    TeamConnection.prototype.request = original;
    await f.close();
  }
});

test('editor snapshot accepts one fresh precomputed status without recalculating project state', async (t) => {
  const f = await fixture();
  try {
    const client = f.client('Precomputed');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const fresh = client.status();
    const actualStatus = client.status.bind(client);
    let calculations = 0;
    const counted = t.mock.method(client, 'status', () => {
      calculations++;
      return actualStatus();
    });
    try {
      const reused = client.editorSnapshot(file.id, fresh);
      assert.equal(calculations, 0);
      const ordinary = client.editorSnapshot(file.id);
      assert.equal(calculations, 1);
      assert.deepEqual(reused, ordinary);
    } finally {
      counted.mock.restore();
    }
  } finally {
    await f.close();
  }
});

test('failed stale checkpoint intent is archived and a fresh retry reaches complete confirmation', async () => {
  const f = await fixture();
  try {
    const client = f.client('Checkpoint retry', f.invite('owner'));
    await client.connect();
    const checkpoint = await client.command({ kind: 'checkpoint-create', name: 'Before change' });
    const checkpointId = String(checkpoint.result?.checkpointId);
    const staleRevision = client.store.revision();
    await client.command({
      kind: 'create',
      path: 'after-checkpoint.txt',
      nodeKind: 'text',
      data: b64(Buffer.from('later')),
    });
    await assert.rejects(
      client.command({ kind: 'checkpoint-restore', checkpointId, expectedRevision: staleRevision }),
      { code: 'STALE_REVISION' },
    );
    assert.equal(client.status().pending, 0);
    assert.equal(client.status().rejected, 0);
    assert.equal(client.status().metadata.conflicts.length, 0);
    const failure = client.store.db.prepare('SELECT * FROM command_failures').get() as {
      op_id: string;
      command: string;
      reason: string;
      failed_at: number;
    };
    assert.equal(failure.reason, 'STALE_REVISION');
    assert.equal(JSON.parse(failure.command).expectedRevision, staleRevision);
    assert.ok(failure.failed_at > 0);
    await client.command({
      kind: 'checkpoint-restore',
      checkpointId,
      expectedRevision: client.store.revision(),
    });
    await until(
      () =>
        f.host.status().confirmedRevision === f.store.revision() &&
        client.status().confirmedRevision === f.store.revision(),
    );
    assert.equal(Number(client.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n), 0);
    assert.equal(client.status().confirmedRevision, f.store.revision());
    assert.equal(
      fs.existsSync(path.join(f.root, 'Checkpoint retry', 'after-checkpoint.txt')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('failed advisory claim creates no document conflict and its exact request remains archived', async () => {
  const f = await fixture();
  try {
    const client = f.client('Claim retry');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const before = client.editorSnapshot(file.id).state;
    const claim = await client.command({
      kind: 'claim-create',
      fileId: file.id,
      description: 'First advisory intent',
      strict: false,
      external: false,
    });
    await assert.rejects(
      client.command({
        kind: 'claim-create',
        fileId: file.id,
        description: 'Duplicate advisory intent',
        strict: false,
        external: false,
      }),
      { code: 'CLAIM_EXISTS' },
    );
    assert.equal(client.editorSnapshot(file.id).state, before);
    assert.equal(client.status().metadata.conflicts.length, 0);
    assert.equal(client.status().rejected, 0);
    const failure = client.store.db
      .prepare('SELECT command,reason FROM command_failures')
      .get() as { command: string; reason: string };
    assert.equal(failure.reason, 'CLAIM_EXISTS');
    assert.equal(JSON.parse(failure.command).description, 'Duplicate advisory intent');
    await client.command({ kind: 'claim-complete', claimId: String(claim.result?.claimId) });
    await until(() => f.host.status().confirmedRevision === f.store.revision());
  } finally {
    await f.close();
  }
});

test('operation size guard archives a failed metadata request and permits a smaller real retry', async () => {
  const f = await fixture();
  try {
    const client = f.client('Size retry', f.invite('owner'));
    await client.connect();
    type Handler = (command: ProjectCommand, actor: Actor) => Record<string, unknown> | void;
    const original = (f.store as unknown as { handlers: Map<string, Handler> }).handlers.get(
      'checkpoint-create',
    )!;
    (f.store as unknown as { handlers: Map<string, Handler> }).handlers.set(
      'checkpoint-create',
      (command, actor) =>
        command.kind === 'checkpoint-create' && command.name === 'Too large'
          ? { padding: 'x'.repeat(20 * 1024 * 1024) }
          : original(command, actor),
    );
    const before = f.store.revision();
    await assert.rejects(client.command({ kind: 'checkpoint-create', name: 'Too large' }), {
      code: 'OPERATION_TOO_LARGE',
    });
    assert.equal(f.store.revision(), before);
    assert.equal(client.status().rejected, 0);
    assert.equal(client.status().metadata.conflicts.length, 0);
    assert.equal(
      client.store.db.prepare('SELECT reason FROM command_failures').get()!.reason,
      'OPERATION_TOO_LARGE',
    );
    const retry = await client.command({ kind: 'checkpoint-create', name: 'Small retry' });
    assert.ok(retry.result?.checkpointId);
    await until(() => f.host.status().confirmedRevision === f.store.revision());
    assert.equal(Number(client.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n), 0);
  } finally {
    await f.close();
  }
});

test('data-bearing file create and write failures remain recoverable drafts until explicitly reviewed', async () => {
  const f = await fixture();
  try {
    const client = f.client('Draft retry');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const created = Buffer.from('unpublished create draft\n');
    await assert.rejects(
      client.command({ kind: 'create', path: file.path, nodeKind: 'text', data: b64(created) }),
    );
    assert.equal(client.status().rejected, 1);
    const createConflict = client
      .status()
      .metadata.conflicts.find(
        (item) => item.localHash === hash(created) && item.status === 'open',
      )!;
    assert.ok(createConflict);
    assert.equal(hash(await client.blob(createConflict.localHash!)), hash(created));
    assert.equal(
      Number(client.store.db.prepare('SELECT count(*) n FROM command_failures').get()!.n),
      0,
    );
    await client.command({
      kind: 'conflict-resolve',
      conflictId: createConflict.id,
      choice: 'remote',
      expectedRevision: client.store.file(file.id)!.revision,
    });
    assert.equal(client.status().rejected, 0);
    assert.equal(
      Number(client.store.db.prepare('SELECT count(*) n FROM command_failures').get()!.n),
      1,
    );
    const update = Buffer.from('unpublished write draft\n');
    await assert.rejects(
      client.command({
        kind: 'write',
        fileId: file.id,
        generation: client.store.file(file.id)!.generation,
        baseRevision: 999,
        baseHash: file.hash,
        data: b64(update),
      }),
      { code: 'STALE_REVISION' },
    );
    assert.equal(client.status().rejected, 1);
    const writeConflict = client
      .status()
      .metadata.conflicts.find(
        (item) => item.localHash === hash(update) && item.status === 'open',
      )!;
    assert.ok(writeConflict);
    assert.equal(hash(await client.blob(writeConflict.localHash!)), hash(update));
    await client.command({
      kind: 'conflict-resolve',
      conflictId: writeConflict.id,
      choice: 'remote',
      expectedRevision: client.store.file(file.id)!.revision,
    });
    await until(() => f.host.status().confirmedRevision === f.store.revision());
    assert.equal(client.status().rejected, 0);
  } finally {
    await f.close();
  }
});

test('stale manual merge failure preserves a reviewable draft and an identical fresh retry clears it', async () => {
  const f = await fixture();
  try {
    const client = f.client('Merge retry');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const created = await client.command({
      kind: 'conflict-create',
      fileId: file.id,
      path: file.path,
      reason: 'Two reviewed versions',
      generation: file.generation,
      revision: file.revision,
      baseHash: file.hash,
      localData: b64(Buffer.from('local alternative\n')),
      remoteHash: file.hash,
    });
    const conflictId = String(created.result?.conflictId);
    const reviewedRevision = client.store.file(file.id)!.revision;
    const originalLocal = client
      .status()
      .metadata.conflicts.find((item) => item.id === conflictId)!.localHash;
    f.store.apply(
      {
        opId: randomUUID(),
        kind: 'write',
        fileId: file.id,
        generation: file.generation,
        baseRevision: file.revision,
        baseHash: file.hash,
        data: b64(Buffer.from('new remote version\n')),
      },
      f.actor,
    );
    await until(() => client.store.file(file.id)!.hash === hash('new remote version\n'));
    const merged = Buffer.from('reviewed manual merge\n');
    await assert.rejects(
      client.command({
        kind: 'conflict-resolve',
        conflictId,
        choice: 'merged',
        expectedRevision: reviewedRevision,
        data: b64(merged),
      }),
      { code: 'STALE_REVISION' },
    );
    assert.equal(client.status().rejected, 0);
    assert.equal(Number(client.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n), 0);
    const draft = client
      .status()
      .metadata.conflicts.find(
        (item) =>
          item.id.startsWith('local-') && item.localHash === hash(merged) && item.status === 'open',
      )!;
    assert.ok(draft);
    assert.equal(hash(await client.blob(draft.localHash!)), hash(merged));
    const original = client.status().metadata.conflicts.find((item) => item.id === conflictId)!;
    assert.equal(original.localHash, originalLocal);
    assert.equal(original.status, 'open');
    const failure = client.store.db
      .prepare('SELECT command,reason FROM command_failures')
      .get() as { command: string; reason: string };
    assert.equal(JSON.parse(failure.command).data, b64(merged));
    assert.equal(failure.reason, 'STALE_REVISION');
    await client.command({
      kind: 'conflict-resolve',
      conflictId,
      choice: 'merged',
      expectedRevision: client.store.file(file.id)!.revision,
      data: b64(merged),
    });
    await until(() => f.host.status().confirmedRevision === f.store.revision());
    assert.equal(
      client.status().metadata.conflicts.filter((item) => item.status === 'open').length,
      0,
    );
    assert.equal(client.editorSnapshot(file.id).text, merged.toString());
    assert.equal(client.status().rejected, 0);
  } finally {
    await f.close();
  }
});

test('reopen archives only old known non-draft failures and leaves drafts and existing conflict records intact', async () => {
  const f = await fixture();
  try {
    const invite = f.invite('owner');
    let client = f.client('Migration retry', invite);
    await client.connect();
    client.disconnect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const checkpoint: ProjectCommand = {
      opId: randomUUID(),
      kind: 'checkpoint-restore',
      checkpointId: 'old-checkpoint',
      expectedRevision: 999,
    };
    const claim: ProjectCommand = {
      opId: randomUUID(),
      kind: 'claim-create',
      fileId: file.id,
      description: 'Old failed claim',
      strict: false,
      external: false,
    };
    const write: ProjectCommand = {
      opId: randomUUID(),
      kind: 'write',
      fileId: file.id,
      generation: file.generation,
      baseRevision: 999,
      baseHash: file.hash,
      data: b64(Buffer.from('old draft')),
    };
    const merged: ProjectCommand = {
      opId: randomUUID(),
      kind: 'conflict-resolve',
      conflictId: 'old-conflict',
      choice: 'merged',
      expectedRevision: 999,
      data: b64(Buffer.from('old merged draft')),
    };
    for (const command of [checkpoint, claim, write, merged])
      client.store.db
        .prepare(
          "INSERT INTO outbox(op_id,command,file_id,generation,state,reason,external) VALUES(?,?,?,NULL,'rejected','STALE_REVISION',0)",
        )
        .run(command.opId, JSON.stringify(command), 'fileId' in command ? command.fileId : null);
    const kept = {
      id: 'local-old-preserved',
      fileId: file.id,
      path: file.path,
      reason: 'Old preserved bytes',
      generation: file.generation,
      revision: file.revision,
      baseHash: file.hash,
      localHash: file.hash,
      remoteHash: file.hash,
      actorId: invite.memberId,
      createdAt: 1,
      status: 'open',
    };
    const body = JSON.stringify(kept);
    client.store.db
      .prepare('INSERT INTO local_conflicts(id,body,observed_key) VALUES(?,?,?)')
      .run(kept.id, body, 'old-preserved');
    client.close();
    client = f.client('Migration retry', invite);
    assert.equal(client.status().rejected, 2);
    assert.equal(
      Number(client.store.db.prepare('SELECT count(*) n FROM command_failures').get()!.n),
      2,
    );
    assert.equal(
      client.store.db
        .prepare('SELECT command FROM command_failures WHERE op_id=?')
        .get(checkpoint.opId)!.command,
      JSON.stringify(checkpoint),
    );
    assert.equal(
      client.store.db.prepare('SELECT command FROM outbox WHERE op_id=?').get(write.opId)!.command,
      JSON.stringify(write),
    );
    assert.ok(client.store.db.prepare('SELECT op_id FROM outbox WHERE op_id=?').get(merged.opId));
    assert.equal(
      client.store.db.prepare('SELECT body FROM local_conflicts WHERE id=?').get(kept.id)!.body,
      body,
    );
  } finally {
    await f.close();
  }
});

test('failed conflict upload keeps its bytes as a local draft and corrected upload can be reviewed to completion', async () => {
  const f = await fixture();
  try {
    const client = f.client('Upload retry');
    await client.connect();
    const file = client.status().files.find((item) => item.path === 'one.txt')!;
    const bytes = Buffer.from('uploaded conflict version\n');
    const input = {
      kind: 'conflict-create' as const,
      fileId: file.id,
      path: file.path,
      reason: 'Upload for review',
      generation: file.generation,
      revision: file.revision,
      baseHash: 'f'.repeat(64),
      localData: b64(bytes),
      remoteHash: file.hash,
    };
    await assert.rejects(client.command(input));
    assert.equal(client.status().rejected, 0);
    assert.equal(client.status().pending, 0);
    const draft = client
      .status()
      .metadata.conflicts.find(
        (conflict) =>
          conflict.id.startsWith('local-') &&
          conflict.localHash === hash(bytes) &&
          conflict.status === 'open',
      )!;
    assert.ok(draft);
    assert.equal(draft.baseHash, null);
    assert.equal(hash(await client.blob(draft.localHash!)), hash(bytes));
    assert.equal(
      JSON.parse(
        String(client.store.db.prepare('SELECT command FROM command_failures').get()!.command),
      ).localData,
      b64(bytes),
    );
    const accepted = await client.command({ ...input, baseHash: file.hash });
    assert.equal(
      client.status().metadata.conflicts.find((conflict) => conflict.id === draft.id)!.status,
      'resolved',
    );
    await client.command({
      kind: 'conflict-resolve',
      conflictId: String(accepted.result?.conflictId),
      choice: 'remote',
      expectedRevision: client.store.file(file.id)!.revision,
    });
    await until(() => f.host.status().confirmedRevision === f.store.revision());
    assert.equal(
      client.status().metadata.conflicts.filter((conflict) => conflict.status === 'open').length,
      0,
    );
    assert.equal(client.status().rejected, 0);
  } finally {
    await f.close();
  }
});
