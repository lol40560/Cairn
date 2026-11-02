import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClientSnapshot, Role } from '../shared/types.js';
import type {
  CommandInput,
  ConflictEntry,
  ProjectEvent,
  ProjectFile,
  ProjectStatus,
  ReplicaStatus,
  TeamInvite,
  TeamStatus,
} from '../shared/project.js';

const fixture = fileURLToPath(new URL('./helpers/project-process.js', import.meta.url));
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoded = (bytes: string | Uint8Array) => Buffer.from(bytes).toString('base64');
type HostState = ProjectStatus & { team: TeamStatus };
type Started = { pid: number; state: HostState; ownerId: string };
type Persisted = {
  catalog: ProjectFile[];
  revision: number;
  manifestHash: string;
  journal: any[];
  operations: any[];
  blobs: { hash: string; actualHash: string; size: number; actualSize: number }[];
  documents: any[];
  quickCheck: unknown;
  outbox: any[];
  receipts: any[];
  localConflicts: ConflictEntry[];
  localDocs: any[];
  projections: any[];
};

class Worker extends EventEmitter {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private sequence = 0;
  private stopped = false;
  private requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor() {
    super();
    this.child = fork(fixture, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    // Drained but never printed: crashes must not leak invitations or private values.
    this.child.stdout!.resume();
    this.child.stderr!.resume();
    this.child.on('message', (message: any) => {
      if (message.event) {
        this.emit(message.event, message);
        return;
      }
      const pending = this.requests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(message.id);
      if (message.error)
        pending.reject(
          Object.assign(new Error(`Project fixture failed (${message.error.code})`), {
            code: message.error.code,
          }),
        );
      else pending.resolve(message.result);
    });
    this.child.on('error', () => this.rejectRequests('Project fixture could not run'));
    this.exited = new Promise((resolve) =>
      this.child.once('exit', () => {
        this.stopped = true;
        this.rejectRequests('Project fixture exited');
        resolve();
      }),
    );
  }
  private rejectRequests(message: string): void {
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.requests.clear();
  }
  call<T = any>(command: string, value?: unknown, timeout = 20000): Promise<T> {
    if (this.stopped || this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.reject(new Error('Project fixture is stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Timed out: ${command}`));
      }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      this.child.send({ id, command, value }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.requests.delete(id);
          reject(new Error('Project fixture IPC failed'));
        }
      });
    });
  }
  next(event: string, timeout = 20000): Promise<any> {
    return new Promise((resolve, reject) => {
      const handler = (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeout);
      this.once(event, handler);
    });
  }
  async kill(): Promise<void> {
    if (!this.stopped && this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill('SIGKILL');
    await bounded(this.exited, 5000, 'child termination');
  }
  async close(): Promise<void> {
    if (this.stopped || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      await this.call('close', undefined, 2000);
      await bounded(this.exited, 2000, 'graceful child exit');
    } catch {
      await this.kill();
    }
  }
}
async function bounded<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
function file(state: { files: ProjectFile[] }, name: string): ProjectFile {
  const result = state.files.find((item) => item.path === name);
  assert.ok(result, `Expected project file ${name}`);
  return result;
}
function liveCatalog(files: ProjectFile[]): ProjectFile[] {
  return files.filter((item) => !item.deleted).sort((a, b) => a.id.localeCompare(b.id));
}
function assertDb(db: Persisted): void {
  assert.deepEqual(db.quickCheck, { quick_check: 'ok' });
  for (const blob of db.blobs) {
    assert.equal(blob.actualHash, blob.hash, 'immutable blob hash');
    assert.equal(blob.actualSize, blob.size, 'immutable blob size');
  }
  for (const document of db.documents)
    assert.equal(
      digest(document.text),
      document.hash,
      'persisted binary Yjs state agrees with canonical bytes',
    );
  for (const local of db.localDocs ?? [])
    assert.equal(local.actualHash, local.contentHash, 'durable local content agrees with its blob');
  for (let index = 1; index < db.journal.length; index++)
    assert.equal(
      db.journal[index].revision,
      db.journal[index - 1].revision + 1,
      'journal remains contiguous',
    );
}
function assertDisk(root: string, files: ProjectFile[]): void {
  for (const current of files) {
    const target = path.join(root, ...current.path.split('/'));
    if (current.kind === 'directory') assert.ok(fs.statSync(target).isDirectory());
    else
      assert.equal(
        digest(fs.readFileSync(target)),
        current.hash,
        `projected bytes: ${current.path}`,
      );
  }
}
async function blob(worker: Worker, hash: string): Promise<Buffer> {
  const result = await worker.call('blob', { hash });
  const bytes = Buffer.from(result.data, 'base64');
  assert.equal(digest(bytes), hash);
  return bytes;
}
async function converged(
  host: Worker,
  a: Worker,
  b: Worker,
): Promise<{ host: HostState; a: ReplicaStatus; b: ReplicaStatus }> {
  let last: { host: HostState; a: ReplicaStatus; b: ReplicaStatus } | undefined;
  const result = await eventually(
    async () => {
      const [h, left, right] = await Promise.all([
        host.call<HostState>('state'),
        a.call<ReplicaStatus>('state'),
        b.call<ReplicaStatus>('state'),
      ]);
      return (last = { host: h, a: left, b: right });
    },
    (value) =>
      [value.a, value.b].every(
        (client) =>
          client.connection === 'online' &&
          client.initialized &&
          client.pending === 0 &&
          client.rejected === 0 &&
          client.revision === value.host.revision &&
          client.manifestHash === value.host.manifestHash &&
          client.projections.every((p) => p.state === 'applied'),
      ) &&
      value.host.projections.every((p) => p.state === 'applied') &&
      value.host.team.confirmedRevision === value.host.revision,
    'host and both independent replicas confirm the same catalog',
  ).catch((error) => {
    const safe =
      last &&
      Object.fromEntries(
        Object.entries(last).map(([name, state]) => [
          name,
          {
            revision: state.revision,
            manifestHash: state.manifestHash,
            projections: state.projections.map((p) => ({
              path: p.path,
              state: p.state,
              error: p.error,
            })),
            ...('connection' in state
              ? {
                  connection: state.connection,
                  pending: state.pending,
                  rejected: state.rejected,
                  error: state.error?.code,
                }
              : { confirmed: state.team.confirmedRevision }),
          },
        ]),
      );
    throw new Error(`${error.message}; safe state: ${JSON.stringify(safe)}`);
  });
  assert.deepEqual(liveCatalog(result.a.files), liveCatalog(result.host.files));
  assert.deepEqual(liveCatalog(result.b.files), liveCatalog(result.host.files));
  return result;
}
async function setup(t: TestContext, files: Record<string, string | Uint8Array>) {
  const tempParent = fs.realpathSync.native(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(tempParent, 'cairn-project-process-'));
  const hostRoot = path.join(temporary, 'host');
  fs.mkdirSync(hostRoot);
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(hostRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const workers: Worker[] = [];
  const make = () => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  };
  t.after(async () => {
    const closed = await Promise.allSettled(workers.map((worker) => worker.close()));
    for (const item of closed)
      assert.equal(item.status, 'fulfilled', 'every child must stop before cleanup');
    assert.equal(path.dirname(path.resolve(temporary)), tempParent);
    assert.ok(path.basename(temporary).startsWith('cairn-project-process-'));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let host = make();
  let started = await host.call<Started>('start-host', { root: hostRoot });
  return {
    temporary,
    hostRoot,
    make,
    get host() {
      return host;
    },
    get started() {
      return started;
    },
    async restartHost() {
      host = make();
      started = await host.call<Started>('start-host', {
        root: hostRoot,
        port: started.state.team.port,
      });
      return started;
    },
    async client(name: string, role: Role = 'editor', invite?: TeamInvite) {
      const invitation = invite ?? (await host.call<TeamInvite>('invite', { role }));
      const worker = make();
      const root = path.join(temporary, name);
      const result = await worker.call<{ pid: number; state: ReplicaStatus }>('start-replica', {
        root,
        invite: invitation,
        name,
      });
      return { worker, root, invite: invitation, ...result };
    },
  };
}

test(
  'project processes pin snapshot R, catch modifications/move/deletion during download, and reflect unopened UTF-8/CRLF/binary files',
  { timeout: 90000 },
  async (t) => {
    const secret = 'FIXTURE_ONLY_DO_NOT_TRANSFER';
    const binary = Buffer.alloc(700000, 0xa5);
    const f = await setup(t, {
      'notes/main.txt': 'seed 한글\n',
      'nested/closed-crlf.txt': '第一行\r\n第二行\r\n',
      'nested/delete.txt': 'remove\n',
      'assets/data.bin': binary,
      '.gitignore': 'ignored/\n*.secret\n',
      'ignored/private.txt': secret,
      '.env': secret,
      'nested/config.secret': secret,
    });
    const a = await f.client('alice', 'owner'),
      b = await f.client('bob');
    assert.equal(
      new Set([process.pid, f.started.pid, a.pid, b.pid]).size,
      4,
      'authority and replicas are three distinct OS processes',
    );
    await a.worker.call('arm-download');
    const paused = a.worker.next('download-paused');
    const connecting = a.worker.call('connect');
    void connecting.catch(() => {});
    const captured = await paused;
    const initial = await a.worker.call<ReplicaStatus>('state');
    assert.equal(initial.initialized, false);
    assert.equal(initial.transfer.stage, 'downloading');
    assert.equal(fs.existsSync(path.join(a.root, 'notes', 'main.txt')), false);
    await b.worker.call('connect');
    const before = await f.host.call<HostState>('state');
    assert.equal(
      captured.revision,
      before.revision,
      'the first downloaded blob belongs to pinned snapshot R',
    );
    const main = file(before, 'notes/main.txt'),
      removed = file(before, 'nested/delete.txt'),
      closed = file(before, 'nested/closed-crlf.txt');
    await b.worker.call('select', { fileId: main.id });
    await f.host.call('command', {
      kind: 'write',
      fileId: main.id,
      generation: main.generation,
      baseRevision: main.revision,
      baseHash: main.hash,
      data: encoded('download 중 수정\n'),
    });
    const latest = await f.host.call<HostState>('state');
    await f.host.call('command', {
      kind: 'move',
      fileId: main.id,
      path: 'notes/renamed.txt',
      baseRevision: file(latest, 'notes/main.txt').revision,
    });
    await f.host.call('command', {
      kind: 'delete',
      fileId: removed.id,
      baseRevision: removed.revision,
      expectedRevision: (await f.host.call<HostState>('state')).revision,
    });
    await f.host.call('command', {
      kind: 'write',
      fileId: closed.id,
      generation: closed.generation,
      baseRevision: closed.revision,
      baseHash: closed.hash,
      data: encoded('未開啟檔案\r\n閉じたまま\r\n'),
    });
    await f.host.call('command', {
      kind: 'create',
      path: 'nested/new.txt',
      nodeKind: 'text',
      data: encoded('created after snapshot\n'),
    });
    await a.worker.call('release-download');
    await connecting;
    const result = await converged(f.host, a.worker, b.worker);
    assert.equal(
      result.host.revision,
      captured.revision + 5,
      'all five post-snapshot commands replayed',
    );
    assert.equal(file(result.host, 'notes/renamed.txt').id, main.id);
    assert.equal(file(result.host, 'nested/closed-crlf.txt').lineEnding, 'crlf');
    for (const root of [f.hostRoot, a.root, b.root]) {
      assertDisk(root, result.host.files);
      assert.equal(fs.existsSync(path.join(root, 'notes', 'main.txt')), false);
      assert.equal(fs.existsSync(path.join(root, 'nested', 'delete.txt')), false);
    }
    for (const root of [a.root, b.root])
      for (const relative of ['.env', 'ignored/private.txt', 'nested/config.secret'])
        assert.equal(
          fs.existsSync(path.join(root, ...relative.split('/'))),
          false,
          'ignored fixture bytes must remain local to creator',
        );
    assert.equal(fs.readFileSync(path.join(f.hostRoot, '.env'), 'utf8'), secret);
    assert.equal(
      result.host.files.some((item) =>
        ['.env', 'ignored/private.txt', 'nested/config.secret'].includes(item.path),
      ),
      false,
    );
    const databases = await Promise.all(
      [f.host, a.worker, b.worker].map((worker) => worker.call<Persisted>('persisted')),
    );
    for (const db of databases) {
      assertDb(db);
      assert.equal(
        db.blobs.some((item) => item.hash === digest(secret)),
        false,
      );
      assert.equal(db.manifestHash, result.host.manifestHash);
    }
    assert.equal(databases[0].catalog.find((item) => item.id === removed.id)?.deleted, true);
    assert.equal(databases[1].outbox.length, 0);
    assert.equal(databases[2].outbox.length, 0);
    t.diagnostic(
      'Real pinned WSS across 1 authority + 2 replica OS processes; snapshot/download mutation, stable file identity, closed CRLF bytes, binary SHA-256, tombstone and ignored-data exclusion verified.',
    );
  },
);

test(
  'project processes retain same-position Yjs edits, pending outbox after replica kill, and durable ACK at immediate authority crash/restart',
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t, { 'nested/live.txt': 'seed\n', 'closed.txt': 'closed\n' });
    const a = await f.client('alice', 'owner');
    let b = await f.client('bob');
    await Promise.all([a.worker.call('connect'), b.worker.call('connect')]);
    let result = await converged(f.host, a.worker, b.worker);
    const target = file(result.host, 'nested/live.txt');
    await Promise.all([a.worker.call('disconnect'), b.worker.call('disconnect')]);
    await Promise.all([
      a.worker.call('insert', { fileId: target.id, index: 0, text: '한글' }),
      b.worker.call('insert', { fileId: target.id, index: 0, text: '中文' }),
    ]);
    const before = await b.worker.call<Persisted>('persisted');
    assertDb(before);
    assert.equal(before.outbox.length, 1);
    const originalId = (await b.worker.call<ReplicaStatus>('state')).clientId;
    await b.worker.kill();
    b = await f.client('bob', 'editor', b.invite);
    const reopened = await b.worker.call<Persisted>('persisted');
    assert.equal(b.state.clientId, originalId);
    assert.deepEqual(reopened.outbox, before.outbox);
    assert.equal(reopened.localDocs.find((item) => item.fileId === target.id).text, '中文seed\n');
    await Promise.all([a.worker.call('connect'), b.worker.call('connect')]);
    result = await converged(f.host, a.worker, b.worker);
    let expected = (await a.worker.call<ClientSnapshot>('editor', { fileId: target.id })).text;
    assert.ok(['한글中文seed\n', '中文한글seed\n'].includes(expected));
    assert.equal(result.host.revision, 2);
    const actors = (await f.host.call<Persisted>('persisted')).journal;
    assert.deepEqual(
      actors.map((event) => event.actor.id).sort(),
      [a.invite.memberId, b.invite.memberId].sort(),
    );
    assert.deepEqual(actors.map((event) => event.actor.name).sort(), ['alice', 'bob']);
    assert.ok(
      actors.every((event) => event.actor.source.kind === 'app'),
      'authority activity binds authenticated editors and declared source',
    );
    const identity = {
      teamId: result.host.team.teamId,
      projectId: result.host.projectId,
      fileId: target.id,
      generation: target.generation,
      ownerId: f.started.ownerId,
    };
    // Two fresh durability boundaries; no fixed delay separates receipt persistence and killing authority.
    for (let round = 1; round <= 2; round++) {
      const oldRevision: number = result.host.revision;
      const marker = `ACK-CRASH-${round}\n`;
      expected += marker;
      const killed = a.worker.next('host-killed-after-ack');
      await a.worker.call('arm-host-crash', { pid: f.host.child.pid });
      await a.worker.call('insert', { fileId: target.id, index: 'end', text: marker });
      const witness = await killed;
      assert.equal(witness.revision, oldRevision + 1);
      assert.equal(witness.pending, 0);
      await bounded(f.host.exited, 5000, 'authority exit immediately after durable receipt');
      const clientDb = await a.worker.call<Persisted>('persisted');
      assert.equal(clientDb.outbox.length, 0);
      assert.equal(clientDb.receipts.at(-1).opId, witness.opId);
      assert.equal(clientDb.localDocs.find((item) => item.fileId === target.id).text, expected);
      const restarted = await f.restartHost();
      assert.equal(restarted.state.team.teamId, identity.teamId);
      assert.equal(restarted.state.projectId, identity.projectId);
      assert.equal(restarted.ownerId, identity.ownerId);
      const restored = file(restarted.state, 'nested/live.txt');
      assert.equal(restored.id, identity.fileId);
      assert.equal(restored.generation, identity.generation);
      const durable = await f.host.call<Persisted>('persisted');
      assertDb(durable);
      assert.equal(durable.revision, oldRevision + 1);
      assert.equal(durable.documents.find((item) => item.fileId === target.id).text, expected);
      assert.equal(durable.operations.filter((item) => item.opId === witness.opId).length, 1);
      await Promise.all([a.worker.call('connect'), b.worker.call('connect')]);
      result = await converged(f.host, a.worker, b.worker);
      assert.equal(file(result.host, 'nested/live.txt').hash, digest(expected));
    }
    const dbs = await Promise.all(
      [f.host, a.worker, b.worker].map((worker) => worker.call<Persisted>('persisted')),
    );
    for (const db of dbs) {
      assertDb(db);
      assert.equal(db.manifestHash, result.host.manifestHash);
      assert.equal(db.documents.find((item) => item.fileId === target.id).text, expected);
    }
    for (const db of dbs.slice(1)) {
      assert.equal(db.outbox.length, 0);
      assert.equal(new Set(db.receipts.map((row) => row.opId)).size, db.receipts.length);
      for (const receipt of db.receipts) {
        const committed = dbs[0].journal.find((event) => event.opId === receipt.opId);
        assert.ok(committed);
        assert.equal(receipt.revision, committed.revision);
        assert.equal(receipt.manifestHash, committed.manifestHash);
        assert.equal(receipt.eventHash, committed.eventHash);
      }
    }
    for (const root of [f.hostRoot, a.root, b.root]) assertDisk(root, result.host.files);
    t.diagnostic(
      'Two receipt-immediate authority SIGKILL/restarts and one pending replica SIGKILL/reopen passed: binary Yjs states, exact text/SHA-256, catalog, receipt, outbox, operation dedup and identities checked on disk.',
    );
  },
);

test(
  'project processes preserve both binary CAS versions, deleted pending edits, and pre-restore generation bytes',
  { timeout: 120000 },
  async (t) => {
    const original = Buffer.from([0, 1, 2, 255]);
    const remote = Buffer.from([0, 9, 8, 255]);
    const local = Buffer.from([0, 7, 6, 255]);
    const f = await setup(t, {
      'asset.bin': original,
      'deleted.txt': 'delete base\n',
      'restore.txt': 'restore base\n',
    });
    const a = await f.client('alice', 'owner'),
      b = await f.client('bob');
    await Promise.all([a.worker.call('connect'), b.worker.call('connect')]);
    let shared = await converged(f.host, a.worker, b.worker);
    const asset = file(shared.host, 'asset.bin'),
      deleted = file(shared.host, 'deleted.txt'),
      restored = file(shared.host, 'restore.txt');
    await a.worker.call('command', {
      kind: 'write',
      fileId: asset.id,
      generation: asset.generation,
      baseRevision: asset.revision,
      baseHash: asset.hash,
      data: encoded(remote),
    });
    shared = await converged(f.host, a.worker, b.worker);
    await assert.rejects(
      b.worker.call('command', {
        kind: 'write',
        fileId: asset.id,
        generation: asset.generation,
        baseRevision: asset.revision,
        baseHash: asset.hash,
        data: encoded(local),
      }),
      { code: 'STALE_REVISION' },
    );
    const rejected = await b.worker.call<Persisted>('persisted');
    assert.equal(rejected.outbox.length, 1);
    assert.equal(rejected.outbox[0].state, 'rejected');
    assert.equal(Buffer.from(rejected.outbox[0].command.data, 'base64').compare(local), 0);
    const binaryConflict = rejected.localConflicts.find(
      (item) => item.fileId === asset.id && item.status === 'open',
    )!;
    assert.ok(binaryConflict);
    assert.equal(binaryConflict.localHash, digest(local));
    assert.equal(binaryConflict.remoteHash, digest(remote));
    assert.deepEqual(await blob(b.worker, binaryConflict.localHash!), local);
    assert.deepEqual(await blob(b.worker, binaryConflict.remoteHash!), remote);
    await b.worker.call('command', {
      kind: 'conflict-resolve',
      conflictId: binaryConflict.id,
      choice: 'both',
      expectedRevision: file(await b.worker.call<ReplicaStatus>('state'), 'asset.bin').revision,
    });
    shared = await converged(f.host, a.worker, b.worker);
    assert.ok(shared.host.files.some((item) => item.hash === digest(remote)));
    assert.ok(shared.host.files.some((item) => item.hash === digest(local)));
    const checkpoint = await a.worker.call<ProjectEvent>('command', {
      kind: 'checkpoint-create',
      name: 'Before generation replacement',
    });
    assert.equal(typeof checkpoint.result?.checkpointId, 'string');
    await converged(f.host, a.worker, b.worker);
    await b.worker.call('disconnect');
    await b.worker.call('insert', { fileId: deleted.id, index: 0, text: 'DELETE-PENDING ' });
    await b.worker.call('insert', { fileId: restored.id, index: 0, text: 'RESTORE-PENDING ' });
    const pending = await b.worker.call<Persisted>('persisted');
    assert.equal(pending.outbox.length, 2);
    await a.worker.call('command', {
      kind: 'delete',
      fileId: deleted.id,
      baseRevision: deleted.revision,
      expectedRevision: (await a.worker.call<ReplicaStatus>('state')).revision,
    });
    await a.worker.call('command', {
      kind: 'checkpoint-restore',
      checkpointId: String(checkpoint.result?.checkpointId),
      fileIds: [restored.id],
      expectedRevision: (await a.worker.call<ReplicaStatus>('state')).revision,
    });
    await b.worker.call('connect');
    const invalidated = await eventually(
      () => b.worker.call<ReplicaStatus>('state'),
      (state) => state.pending === 0 && state.rejected === 2,
      'deleted and replaced generation edits are retained as rejected',
    );
    assert.equal(invalidated.confirmedRevision, null);
    assert.equal(
      invalidated.files.some((item) => item.id === deleted.id),
      false,
    );
    assert.ok(file(invalidated, 'restore.txt').generation > restored.generation);
    const deletionConflict = invalidated.metadata.conflicts.find(
      (item) => item.reason === 'REMOTE_DELETION' && item.fileId === deleted.id,
    )!;
    const generationConflict = invalidated.metadata.conflicts.find(
      (item) => item.reason === 'GENERATION_CHANGED' && item.fileId === restored.id,
    )!;
    assert.ok(deletionConflict?.localStateHash);
    assert.ok(generationConflict?.localStateHash);
    assert.equal(
      (await blob(b.worker, deletionConflict.localHash!)).toString(),
      'DELETE-PENDING delete base\n',
    );
    assert.equal(
      (await blob(b.worker, generationConflict.localHash!)).toString(),
      'RESTORE-PENDING restore base\n',
    );
    assert.equal(
      fs.readFileSync(path.join(b.root, 'deleted.txt'), 'utf8'),
      'DELETE-PENDING delete base\n',
    );
    assert.equal(
      fs.readFileSync(path.join(b.root, 'restore.txt'), 'utf8'),
      'RESTORE-PENDING restore base\n',
    );
    assert.equal(
      (await b.worker.call<ClientSnapshot>('editor', { fileId: restored.id })).text,
      'restore base\n',
    );
    const hostDb = await f.host.call<Persisted>('persisted');
    assertDb(hostDb);
    assert.equal(hostDb.catalog.find((item) => item.id === deleted.id)?.deleted, true);
    assert.equal(
      hostDb.documents.find((item) => item.fileId === restored.id).text,
      'restore base\n',
    );
    const hostState = await f.host.call<HostState>('state');
    assert.ok(hostState.metadata.checkpoints.some((item) => item.protected));
    assert.ok(hostState.metadata.trash.some((item) => item.fileId === deleted.id));
    const beforeRestart = await b.worker.call<Persisted>('persisted');
    assertDb(beforeRestart);
    await b.worker.kill();
    const reopened = await f.client('bob', 'editor', b.invite);
    const afterRestart = await reopened.worker.call<Persisted>('persisted');
    assertDb(afterRestart);
    assert.deepEqual(afterRestart.outbox, beforeRestart.outbox);
    assert.deepEqual(afterRestart.localConflicts, beforeRestart.localConflicts);
    assert.equal(
      fs.readFileSync(path.join(reopened.root, 'restore.txt'), 'utf8'),
      'RESTORE-PENDING restore base\n',
    );
    t.diagnostic(
      'Binary CAS retains both immutable versions and explicit both-resolution; deletion/checkpoint restoration rejects old pending generations, preserves text and Yjs recovery blobs and original local files across process death.',
    );
  },
);

test(
  'project processes enforce Viewer/current grants/revocation and retry a real projection after injected filesystem failure',
  { timeout: 90000 },
  async (t) => {
    const f = await setup(t, { 'editable.txt': 'base\n' });
    const a = await f.client('alice', 'owner'),
      b = await f.client('bob', 'viewer');
    await Promise.all([a.worker.call('connect'), b.worker.call('connect')]);
    let shared = await converged(f.host, a.worker, b.worker);
    const target = file(shared.host, 'editable.txt');
    await assert.rejects(
      b.worker.call('insert', { fileId: target.id, index: 0, text: 'forbidden' }),
      { code: 'READ_ONLY' },
    );
    assert.equal((await b.worker.call<Persisted>('persisted')).outbox.length, 0);
    await f.host.call('projection-fault', { enabled: true });
    await a.worker.call('insert', {
      fileId: target.id,
      index: 'end',
      text: 'durable during EACCES\n',
    });
    const faulted = await eventually(
      () => f.host.call<HostState>('state'),
      (value) => value.projections.some((p) => p.fileId === target.id && p.state === 'error'),
      'filesystem failure remains visible after durable command',
    );
    await eventually(
      () => a.worker.call<ReplicaStatus>('state'),
      (value) => value.pending === 0,
      'failed projection still acknowledges committed bytes',
    );
    assert.equal(faulted.team.confirmedRevision, null);
    assert.equal(fs.readFileSync(path.join(f.hostRoot, 'editable.txt'), 'utf8'), 'base\n');
    assert.equal(file(faulted, 'editable.txt').hash, digest('base\ndurable during EACCES\n'));
    const persisted = await f.host.call<Persisted>('persisted');
    assertDb(persisted);
    assert.equal(
      persisted.documents.find((item) => item.fileId === target.id).text,
      'base\ndurable during EACCES\n',
    );
    const cleared = await f.host.call('projection-fault', { enabled: false });
    assert.ok(cleared.hits > 0);
    await f.host.call('retry-projection');
    shared = await converged(f.host, a.worker, b.worker);
    assertDisk(f.hostRoot, shared.host.files);
    await b.worker.close();
    const editor = await f.client('current-grant', 'editor');
    await editor.worker.call('connect');
    await f.host.call('set-viewer', { memberId: editor.invite.memberId });
    await assert.rejects(
      editor.worker.call('command', {
        kind: 'create',
        path: 'must-not-exist.txt',
        nodeKind: 'text',
        data: encoded('forbidden'),
      }),
      { code: 'READ_ONLY' },
    );
    const refused = await editor.worker.call<Persisted>('persisted');
    assert.equal(refused.outbox.length, 1);
    assert.equal(refused.outbox[0].state, 'rejected');
    assert.equal(
      (await f.host.call<HostState>('state')).files.some(
        (item) => item.path === 'must-not-exist.txt',
      ),
      false,
    );
    await f.host.call('revoke', { memberId: editor.invite.memberId });
    await eventually(
      () => editor.worker.call<ReplicaStatus>('state'),
      (value) => value.connection !== 'online',
      'revoked member disconnects',
    );
    await editor.worker.call('disconnect');
    await assert.rejects(editor.worker.call('connect'), { code: 'AUTH_FAILED' });
    await editor.worker.call('disconnect');
    const final = await f.host.call<Persisted>('persisted');
    assertDb(final);
    assert.equal(final.revision, persisted.revision);
    assert.equal(final.operations.length, persisted.operations.length);
    assert.equal(fs.existsSync(path.join(f.hostRoot, 'must-not-exist.txt')), false);
    assert.equal(
      fs.readFileSync(path.join(editor.root, 'editable.txt'), 'utf8'),
      'base\ndurable during EACCES\n',
    );
    t.diagnostic(
      'Viewer edits, current grant downgrade and revoked reconnect denied; EACCES at actual projection temporary-file open left canonical bytes durable and old disk intact, then retry projected exact bytes.',
    );
  },
);
