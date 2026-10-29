import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { b64, hash } from '../core/common.js';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import type { Actor, CommandInput, ProjectEvent, ProjectFile } from '../shared/project.js';

const owner: Actor = { id: 'owner-test', name: 'Owner', role: 'owner', source: { kind: 'app' } };
const peer: Actor = { id: 'peer-test', name: 'Peer', role: 'editor', source: { kind: 'app' } };
const bytes = (value: string | Uint8Array): string => b64(typeof value === 'string' ? Buffer.from(value) : value);
function setup(files: Record<string, string | Uint8Array> = { 'note.txt': 'original\n' }, autoProject = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-recovery-'));
  for (const [name, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), contents); }
  let store = new ProjectStore({ root, mode: 'authority', ownerId: owner.id, autoProject });
  let recovery = new RecoveryService(store);
  return {
    root, get store() { return store; }, get recovery() { return recovery; },
    file(name = 'note.txt') { const file = store.files(true).find((file) => file.path === name); assert.ok(file, `Missing fixture file ${name}`); return file; },
    apply(command: CommandInput, actor = owner): ProjectEvent { return store.apply({ ...command, opId: randomUUID() }, actor); },
    write(value: string | Uint8Array, actor = owner, name = 'note.txt') {
      const file = store.files().find((file) => file.path === name)!;
      return this.apply({ kind: 'write', fileId: file.id, generation: file.generation, baseRevision: file.revision, baseHash: file.hash, data: bytes(value) }, actor);
    },
    reopen() { store.close(); store = new ProjectStore({ root, mode: 'authority', ownerId: owner.id, autoProject }); recovery = new RecoveryService(store); },
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
function conflict(f: ReturnType<typeof setup>, local: string | Uint8Array | null, name = 'note.txt'): string {
  const file = f.file(name);
  return f.apply({ kind: 'conflict-create', fileId: file.id, path: file.path, reason: 'External baseline is stale', generation: file.generation,
    revision: file.revision, baseHash: file.hash, localData: local === null ? null : bytes(local), remoteHash: file.deleted ? null : file.hash }).result!.conflictId as string;
}
function read(f: ReturnType<typeof setup>, file: ProjectFile = f.file()): Buffer { return Buffer.from(f.store.getBlob(file.hash)); }
function count(db: DatabaseSync, table: string): number { return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n); }

test('claims enforce explicit strict mode, preserve attribution, and release held disk projections safely', async () => {
  const f = setup();
  try {
    const original = f.file();
    const created = f.apply({ kind: 'claim-create', fileId: original.id, description: 'Editing with my local tool', strict: false, external: true, ttlMs: 1000,
      source: { kind: 'declared-ai', tool: 'Explicit test tool' } });
    const id = created.result!.claimId as string;
    assert.equal(f.store.metadata().claims[0].source.kind, 'declared-ai');
    f.write('remote change\n', peer);
    f.store.projectPending();
    assert.equal(f.store.status().projections.find((item) => item.fileId === original.id)!.state, 'held');
    assert.equal(fs.readFileSync(path.join(f.root, original.path), 'utf8'), 'original\n');
    assert.throws(() => f.apply({ kind: 'claim-renew', claimId: id }, peer), { code: 'PERMISSION_DENIED' });
    f.apply({ kind: 'claim-renew', claimId: id });
    const renewed = f.store.metadata().claims[0];
    assert.ok(renewed.expiresAt - Date.now() <= 1000);
    fs.writeFileSync(path.join(f.root, original.path), 'external unsaved version\n');
    f.apply({ kind: 'claim-complete', claimId: id });
    f.store.projectPending();
    assert.equal(fs.readFileSync(path.join(f.root, original.path), 'utf8'), 'external unsaved version\n');
    assert.equal(f.store.status().projections.find((item) => item.fileId === original.id)!.state, 'blocked');
    assert.equal(read(f).toString(), 'remote change\n');
    const strict = f.apply({ kind: 'claim-create', fileId: original.id, description: 'Exclusive editing by agreement', strict: true, external: false, ttlMs: 1000 }).result!.claimId as string;
    const before = f.store.revision();
    assert.throws(() => f.write('must not commit', peer), { code: 'FILE_CLAIMED' });
    assert.equal(f.store.revision(), before);
    f.apply({ kind: 'claim-cancel', claimId: strict });
    f.write('permitted after cancellation\n', peer);
    const expiring = f.apply({ kind: 'claim-create', fileId: original.id, description: 'Short claim', strict: false, external: false, ttlMs: 1000 }).result!.claimId as string;
    const deadline = Date.now() + 3500;
    while (f.store.metadata().claims.find((item) => item.id === expiring)!.status === 'active' && Date.now() < deadline) await delay(100);
    assert.equal(f.store.metadata().claims.find((item) => item.id === expiring)!.status, 'expired');
    assert.ok(f.store.eventsSince(before).some((event) => event.kind === 'claim-expire' && event.actor.source.kind === 'system'));
    f.reopen();
    assert.equal(f.store.metadata().claims.find((item) => item.id === expiring)!.status, 'expired');
  } finally { f.close(); }
});

test('text conflict CAS preserves all versions, allows reviewed manual text, and keeps both as distinct identities', () => {
  const f = setup();
  try {
    const original = f.file(), id = conflict(f, 'local version\n');
    const preserved = f.store.metadata().conflicts.find((entry) => entry.id === id)!;
    f.write('later canonical version\n', peer);
    assert.throws(() => f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'local', expectedRevision: original.revision }), { code: 'STALE_REVISION' });
    const current = f.file();
    const event = f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'merged', expectedRevision: current.revision, data: bytes('reviewed combined version\n') });
    assert.equal(read(f).toString(), 'reviewed combined version\n');
    assert.ok(f.file().generation > current.generation);
    assert.equal(event.metadata.conflicts.find((entry) => entry.id === id)!.resolution, 'merged');
    assert.equal(Buffer.from(f.store.getBlob(preserved.baseHash!)).toString(), 'original\n');
    assert.equal(Buffer.from(f.store.getBlob(preserved.localHash!)).toString(), 'local version\n');
    assert.equal(Buffer.from(f.store.getBlob(current.hash)).toString(), 'later canonical version\n');
    const both = conflict(f, 'separate local copy\n');
    const result = f.apply({ kind: 'conflict-resolve', conflictId: both, choice: 'both', expectedRevision: f.file().revision });
    const copy = f.store.file(result.result!.copyFileId as string)!;
    assert.notEqual(copy.id, f.file().id); assert.notEqual(copy.path, f.file().path);
    assert.equal(read(f, copy).toString(), 'separate local copy\n');
    assert.equal(read(f).toString(), 'reviewed combined version\n');
    f.reopen();
    assert.equal(f.store.metadata().conflicts.filter((entry) => entry.status === 'resolved').length, 2);
    assert.equal(read(f, f.store.file(copy.id)!).toString(), 'separate local copy\n');
  } finally { f.close(); }
});

test('binary conflicts retain exact bytes and reject text merging without committing partial records', () => {
  const remote = Buffer.from([0, 255, 128, 10, 2]), local = Buffer.from([255, 0, 1, 13, 10, 3]);
  const f = setup({ 'asset.bin': remote });
  try {
    const id = conflict(f, local, 'asset.bin'), before = f.store.revision(), blobs = count(f.store.db, 'project_blobs');
    assert.throws(() => f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'merged', expectedRevision: f.file('asset.bin').revision, data: bytes('invalid text merge') }), { code: 'BINARY_MERGE' });
    assert.equal(f.store.revision(), before); assert.equal(count(f.store.db, 'project_blobs'), blobs);
    const resolved = f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'local', expectedRevision: f.file('asset.bin').revision });
    assert.deepEqual(read(f, f.file('asset.bin')), local); assert.equal(f.file('asset.bin').kind, 'binary');
    const preserved = resolved.metadata.conflicts.find((entry) => entry.id === id)!;
    assert.deepEqual(Buffer.from(f.store.getBlob(preserved.remoteHash!)), remote);
    f.apply({ kind: 'create', path: 'explicit-binary.txt', nodeKind: 'binary', data: bytes('binary by explicit choice') });
    const asciiId = conflict(f, 'replacement still binary', 'explicit-binary.txt');
    f.apply({ kind: 'conflict-resolve', conflictId: asciiId, choice: 'both', expectedRevision: f.file('explicit-binary.txt').revision });
    assert.ok(f.store.files().filter((file) => file.path.startsWith('explicit-binary')).every((file) => file.kind === 'binary'));
    f.reopen(); assert.deepEqual(read(f, f.file('asset.bin')), local);
  } finally { f.close(); }
});

test('old-generation conflicts use the reviewed current target for CAS, keeping current remote content or deletion', () => {
  const f = setup();
  try {
    const checkpointId = f.apply({ kind: 'checkpoint-create', name: 'Generation reset point' }).result!.checkpointId as string;
    const id = conflict(f, 'old local preserved\n'), earlier = f.file();
    f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: f.store.revision() });
    f.write('latest reviewed canonical\n', peer);
    const review = f.store.metadata().conflicts.find((entry) => entry.id === id)!;
    assert.ok(review.current!.generation > review.generation);
    assert.equal(review.remoteHash, earlier.hash);
    assert.equal(review.current!.hash, hash('latest reviewed canonical\n'));
    assert.throws(() => f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'remote', expectedRevision: earlier.revision }), { code: 'STALE_REVISION' });
    const current = f.file();
    const kept = f.apply({ kind: 'conflict-resolve', conflictId: id, choice: 'remote', expectedRevision: review.current!.revision });
    assert.equal(kept.changes.length, 0); assert.deepEqual(f.file(), current);
    assert.equal(read(f).toString(), 'latest reviewed canonical\n');
    const localId = conflict(f, 'explicitly recovered old local\n');
    f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: f.store.revision() });
    const reset = f.file();
    f.apply({ kind: 'conflict-resolve', conflictId: localId, choice: 'local', expectedRevision: reset.revision });
    assert.ok(f.file().generation > reset.generation);
    assert.equal(read(f).toString(), 'explicitly recovered old local\n');
    const deletedId = conflict(f, 'local before deletion\n'), live = f.file();
    f.apply({ kind: 'delete', fileId: live.id, baseRevision: live.revision, expectedRevision: f.store.revision() });
    const deletedReview = f.store.metadata().conflicts.find((entry) => entry.id === deletedId)!;
    assert.equal(deletedReview.current!.deleted, true);
    f.apply({ kind: 'conflict-resolve', conflictId: deletedId, choice: 'remote', expectedRevision: deletedReview.current!.revision });
    assert.equal(f.file().deleted, true);
    const missing = f.apply({ kind: 'conflict-create', fileId: null, path: 'new.txt', reason: 'Unshared external file', generation: 0, revision: 0,
      baseHash: null, localData: bytes('new recovered file\n'), remoteHash: null }).result!.conflictId as string;
    assert.equal(f.store.metadata().conflicts.find((entry) => entry.id === missing)!.current, null);
    f.apply({ kind: 'conflict-resolve', conflictId: missing, choice: 'local', expectedRevision: 0 });
    assert.equal(read(f, f.file('new.txt')).toString(), 'new recovered file\n');
  } finally { f.close(); }
});

test('checkpoint restore and its protective checkpoint share the durable transaction and survive restart', () => {
  const f = setup({ 'note.txt': 'original\n', 'unchanged.txt': 'same\n', 'image.bin': Buffer.from([0, 255, 1]) });
  try {
    const originals = f.store.files();
    const checkpointId = f.apply({ kind: 'checkpoint-create', name: 'Known good state' }).result!.checkpointId as string;
    f.write('changed\n');
    f.apply({ kind: 'create', path: 'later.txt', nodeKind: 'text', data: bytes('later\n') });
    const before = { revision: f.store.revision(), files: f.store.files(true), metadata: f.store.metadata(), blobs: count(f.store.db, 'project_blobs'), receipts: count(f.store.db, 'project_operations') };
    const preview = f.store.query({ kind: 'preview-checkpoint', checkpointId }) as { files: unknown[]; deletes: number; unchanged: number };
    assert.equal(preview.deletes, 1); assert.equal(preview.unchanged, 2);
    assert.deepEqual(f.store.query({ kind: 'preview-checkpoint', checkpointId }), preview);
    assert.throws(() => f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: before.revision - 1 }), { code: 'STALE_REVISION' });
    f.store.db.exec("CREATE TRIGGER test_abort_restore BEFORE INSERT ON project_journal WHEN json_extract(NEW.event,'$.kind')='checkpoint-restore' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END;");
    assert.throws(() => f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: before.revision }), /injected commit failure/);
    assert.equal(f.store.revision(), before.revision);
    assert.deepEqual(f.store.files(true), before.files); assert.deepEqual(f.store.metadata(), before.metadata);
    assert.equal(count(f.store.db, 'project_blobs'), before.blobs); assert.equal(count(f.store.db, 'project_operations'), before.receipts);
    f.store.db.exec('DROP TRIGGER test_abort_restore');
    const reader = new DatabaseSync(path.join(f.root, '.cairn-next', 'project.sqlite'), { readOnly: true });
    let observedDurable = false;
    f.store.once('change', (event: ProjectEvent) => {
      observedDurable = !!reader.prepare('SELECT 1 FROM project_operations WHERE op_id=?').get(event.opId);
      assert.equal(count(reader, 'recovery_checkpoints'), 2);
    });
    const restored = f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: before.revision });
    reader.close(); assert.equal(observedDurable, true);
    assert.equal(restored.revision, before.revision + 1);
    assert.ok(restored.result!.protectiveCheckpointId);
    assert.equal(f.file('later.txt').deleted, true);
    for (const source of originals) { const current = f.store.file(source.id)!; assert.equal(current.hash, source.hash); assert.ok(current.generation > source.generation); }
    const old = originals.find((file) => file.path === 'note.txt')!;
    assert.throws(() => f.apply({ kind: 'write', fileId: old.id, generation: old.generation, baseRevision: old.revision, baseHash: old.hash, data: bytes('late stale edit') }), { code: 'STALE_GENERATION' });
    f.reopen();
    assert.equal(read(f).toString(), 'original\n');
    assert.equal(f.store.metadata().checkpoints.length, 2);
    const protective = f.store.metadata().checkpoints.find((entry) => entry.id === restored.result!.protectiveCheckpointId)!;
    assert.equal(protective.protected, true);
    assert.equal(Buffer.from(f.store.getBlob(protective.files.find((file) => file.path === 'note.txt')!.hash)).toString(), 'changed\n');
  } finally { f.close(); }
});

test('file restore handles path swaps and exclusions without touching ignored or internal disk files', () => {
  const f = setup({ 'a.txt': 'A\n', 'b.txt': 'B\n', 'local.txt': 'keep locally\n', '.env': 'SECRET=fixture-only\n' });
  try {
    const checkpointId = f.apply({ kind: 'checkpoint-create', name: 'Paths before rename' }).result!.checkpointId as string;
    const a = f.file('a.txt'), b = f.file('b.txt');
    f.apply({ kind: 'move', fileId: a.id, path: 'temp.txt', baseRevision: a.revision });
    f.apply({ kind: 'move', fileId: b.id, path: 'a.txt', baseRevision: f.store.file(b.id)!.revision });
    f.apply({ kind: 'move', fileId: a.id, path: 'b.txt', baseRevision: f.store.file(a.id)!.revision });
    const hidden = f.file('local.txt');
    const settings = f.apply({ kind: 'settings', ignorePatterns: ['local.txt'], strictClaims: true, retentionDays: 7 });
    assert.equal(f.store.file(hidden.id)!.deleted, true);
    assert.ok(settings.changes.some((change) => change.after.id === hidden.id && change.preserveDisk));
    assert.equal(fs.readFileSync(path.join(f.root, 'local.txt'), 'utf8'), 'keep locally\n');
    assert.ok(!f.store.metadata().checkpoints[0].files.some((file) => file.id === hidden.id));
    const preview = f.store.query({ kind: 'preview-checkpoint', checkpointId }) as { excluded: { path: string }[] };
    assert.ok(preview.excluded.some((entry) => entry.path === 'local.txt'));
    const collisionRevision = f.store.revision();
    assert.throws(() => f.apply({ kind: 'checkpoint-restore', checkpointId, fileIds: [a.id], expectedRevision: collisionRevision }), { code: 'PATH_CONFLICT' });
    assert.equal(f.store.revision(), collisionRevision);
    f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: f.store.revision() });
    assert.equal(f.store.file(a.id)!.path, 'a.txt'); assert.equal(f.store.file(b.id)!.path, 'b.txt');
    assert.equal(read(f, f.store.file(a.id)!).toString(), 'A\n');
    assert.equal(f.store.file(hidden.id)!.deleted, true);
    assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'SECRET=fixture-only\n');
    assert.ok(!f.store.snapshot().blobs.some((blob) => blob.hash === hash('SECRET=fixture-only\n')));
    f.write('new A\n', owner, 'a.txt'); f.write('new B\n', owner, 'b.txt');
    const untouched = f.file('b.txt');
    f.apply({ kind: 'checkpoint-restore', checkpointId, fileIds: [a.id], expectedRevision: f.store.revision() });
    assert.equal(read(f, f.file('a.txt')).toString(), 'A\n');
    assert.deepEqual(f.file('b.txt'), untouched);
    f.reopen(); assert.deepEqual(f.store.metadata().ignorePatterns, ['local.txt']);
    assert.throws(() => f.apply({ kind: 'create', path: 'local.txt', nodeKind: 'text', data: bytes('must stay excluded') }), { code: 'EXCLUDED_PATH' });
    const ignoredHash = f.file('b.txt').hash;
    f.apply({ kind: 'create', path: '.gitignore', nodeKind: 'text', data: bytes('b.txt\n') });
    assert.equal(f.store.file(b.id)!.deleted, true);
    assert.ok(!f.store.metadata().checkpoints.some((entry) => entry.files.some((file) => file.path === 'b.txt')));
    assert.ok(!f.store.snapshot().blobs.some((blob) => blob.hash === ignoredHash));
  } finally { f.close(); }
});

test('trash restores a deleted tree, keeps checkpoint recovery independent of purge, and applies retention durably', () => {
  const f = setup({ 'folder/a.txt': 'A\n', 'folder/b.bin': Buffer.from([0, 255, 1]) });
  try {
    const checkpointId = f.apply({ kind: 'checkpoint-create', name: 'Independent recovery' }).result!.checkpointId as string;
    const folder = f.file('folder');
    f.apply({ kind: 'delete', fileId: folder.id, baseRevision: folder.revision, expectedRevision: f.store.revision() });
    assert.equal(f.store.metadata().trash.length, 3);
    const entry = f.store.metadata().trash.find((entry) => entry.path === 'folder')!;
    f.apply({ kind: 'trash-restore', trashId: entry.id, expectedRevision: f.store.revision() });
    assert.equal(f.store.files().length, 3); assert.equal(f.store.metadata().trash.length, 0);
    assert.deepEqual(read(f, f.file('folder/b.bin')), Buffer.from([0, 255, 1]));
    const restored = f.file('folder');
    f.apply({ kind: 'delete', fileId: restored.id, baseRevision: restored.revision, expectedRevision: f.store.revision() });
    const ids = f.store.metadata().trash.map((entry) => entry.id);
    const purged = f.apply({ kind: 'trash-purge', trashIds: ids, expectedRevision: f.store.revision() });
    assert.equal(purged.result!.checkpointsPreserved, true); assert.equal(f.store.metadata().trash.length, 0);
    assert.ok(f.store.metadata().checkpoints.some((entry) => entry.id === checkpointId));
    f.apply({ kind: 'checkpoint-restore', checkpointId, expectedRevision: f.store.revision() });
    assert.equal(f.store.files().length, 3);
    const file = f.file('folder/a.txt');
    f.apply({ kind: 'delete', fileId: file.id, baseRevision: file.revision, expectedRevision: f.store.revision() });
    const old = f.store.metadata().trash[0];
    old.deletedAt = Date.now() - 10 * 86400000;
    f.store.db.prepare('UPDATE recovery_trash SET created_at=?,data=? WHERE id=?').run(old.deletedAt, JSON.stringify(old), old.id);
    f.apply({ kind: 'settings', retentionDays: 7 });
    f.reopen(); assert.equal(f.store.metadata().trash.length, 0);
    assert.ok(f.store.metadata().checkpoints.some((entry) => entry.id === checkpointId));
  } finally { f.close(); }
});

test('canonical recovery metadata installs with verified blobs while replica-local recovery survives', () => {
  const f = setup(), replicaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-recovery-peer-'));
  let replica: ProjectStore | undefined;
  try {
    f.apply({ kind: 'checkpoint-create', name: 'Replicated checkpoint' });
    conflict(f, 'local copy\n');
    const snapshot = f.store.snapshot();
    replica = new ProjectStore({ root: replicaRoot, mode: 'replica', projectId: f.store.projectId });
    new RecoveryService(replica);
    replica.db.exec("CREATE TABLE local_conflicts(id TEXT PRIMARY KEY,data TEXT); INSERT INTO local_conflicts VALUES('kept','local bytes');");
    replica.installSnapshot(snapshot, snapshot.blobs.map(({ hash }) => ({ hash, data: bytes(f.store.getBlob(hash)) })));
    assert.deepEqual(replica.metadata(), snapshot.metadata);
    assert.equal(count(replica.db, 'local_conflicts'), 1);
    const checkpoint = replica.metadata().checkpoints[0];
    assert.equal(Buffer.from(replica.getBlob(checkpoint.files[0].hash)).toString(), 'original\n');
    const before = replica.metadata();
    const bad = structuredClone(snapshot); bad.metadata.conflicts[0].localHash = '0'.repeat(64);
    assert.throws(() => replica!.installSnapshot(bad, []));
    assert.deepEqual(replica.metadata(), before); assert.equal(count(replica.db, 'local_conflicts'), 1);
    const live = f.file();
    f.apply({ kind: 'delete', fileId: live.id, baseRevision: live.revision, expectedRevision: f.store.revision() });
    const deletedSnapshot = f.store.snapshot();
    assert.equal(deletedSnapshot.files.length, 0);
    replica.installSnapshot(deletedSnapshot, deletedSnapshot.blobs.map(({ hash }) => ({ hash, data: bytes(f.store.getBlob(hash)) })));
    assert.equal(replica.file(live.id), undefined);
    const tombstoneReview = replica.metadata().conflicts[0];
    assert.equal(tombstoneReview.current!.deleted, true);
    assert.equal(tombstoneReview.current!.revision, f.file().revision);
    const resolved = f.apply({ kind: 'conflict-resolve', conflictId: tombstoneReview.id, choice: 'remote', expectedRevision: tombstoneReview.current!.revision });
    replica.ingest(resolved, []);
    assert.equal(replica.metadata().conflicts[0].status, 'resolved');
    assert.equal(replica.metadata().conflicts[0].current!.revision, tombstoneReview.current!.revision);
    assert.equal(replica.metadata().conflicts[0].current!.deleted, true);
  } finally { replica?.close(); f.close(); fs.rmSync(replicaRoot, { recursive: true, force: true }); }
});

test('metadata checks each repeated recovery path once per call and rechecks changed filesystem safety without a new revision', () => {
  const initial = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`nested/note${index}.txt`, `fixture ${index}\n`]));
  const f = setup(initial);
  const nested = path.join(f.root, 'nested'), preserved = path.join(f.root, 'nested-preserved'), target = path.join(f.root, 'junction-target');
  try {
    for (let index = 0; index < 24; index++) f.apply({ kind: 'checkpoint-create', name: `Repeated path checkpoint ${index}` });
    const files = f.store.files().filter((file) => file.kind === 'text');
    f.apply({ kind: 'claim-create', fileId: files[0].id, description: 'Metadata fixture claim', strict: false, external: false });
    conflict(f, 'preserved local\n', files[1].path);
    f.apply({ kind: 'delete', fileId: files[2].id, baseRevision: files[2].revision, expectedRevision: f.store.revision() });
    const configure = f.store.configurePolicy.bind(f.store);
    let calls: string[] = [];
    f.store.configurePolicy = (policy) => {
      const configured = configure(policy), check = configured.check.bind(configured);
      configured.check = (relative, directory = false) => { calls.push(`${directory ? 'directory' : 'file'}:${relative}`); return check(relative, directory); };
      return configured;
    };
    const revision = f.store.revision(), first = f.recovery.metadata();
    const references = first.checkpoints.reduce((total, checkpoint) => total + checkpoint.files.length, 0) + first.claims.length + first.conflicts.length * 2 + first.trash.length;
    assert.equal(references, 220);
    assert.equal(calls.length, 9); assert.equal(new Set(calls).size, calls.length);
    calls = [];
    assert.deepEqual(f.recovery.metadata(), first);
    assert.equal(calls.length, 9, 'A second call must perform fresh path checks.');
    // A changed ancestor must be detected even without a catalog/settings change.
    // Both the preserved directory and junction target belong to this fixture.
    fs.renameSync(nested, preserved);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'note0.txt'), 'must not traverse\n');
    fs.symlinkSync(target, nested, process.platform === 'win32' ? 'junction' : 'dir');
    calls = [];
    const after = f.recovery.metadata();
    assert.equal(f.store.revision(), revision);
    assert.equal(calls.length, 9); assert.equal(new Set(calls).size, calls.length);
    assert.ok(after.checkpoints.every((checkpoint) => checkpoint.files.length === 0));
    assert.equal(after.claims.length, 0); assert.equal(after.conflicts.length, 0); assert.equal(after.trash.length, 0);
    assert.ok(first.checkpoints.every((checkpoint) => checkpoint.files.length === 9));
    assert.equal(fs.readFileSync(path.join(target, 'note0.txt'), 'utf8'), 'must not traverse\n');
  } finally {
    if (fs.existsSync(nested) && fs.lstatSync(nested).isSymbolicLink()) fs.unlinkSync(nested);
    f.close();
  }
});

test('abrupt independent process exit leaves committed restore and protective checkpoint recoverable', () => {
  const f = setup();
  const root = f.root;
  f.store.close();
  try {
    const storeUrl = new URL('../core/project/store.js', import.meta.url).href;
    const recoveryUrl = new URL('../core/project/recovery.js', import.meta.url).href;
    const program = `import {ProjectStore} from ${JSON.stringify(storeUrl)}; import {RecoveryService} from ${JSON.stringify(recoveryUrl)};
      const s=new ProjectStore({root:process.env.CAIRN_RECOVERY_TEST_ROOT,mode:'authority',ownerId:'owner-test',autoProject:false});new RecoveryService(s);
      const a={id:'owner-test',name:'Owner',role:'owner',source:{kind:'app'}};
      const cp=s.apply({opId:'process-checkpoint',kind:'checkpoint-create',name:'Before process crash'},a).result.checkpointId;
      const f=s.files()[0];s.apply({opId:'process-write',kind:'write',fileId:f.id,generation:f.generation,baseRevision:f.revision,baseHash:f.hash,data:Buffer.from('changed in child\\n').toString('base64')},a);
      s.apply({opId:'process-restore',kind:'checkpoint-restore',checkpointId:cp,expectedRevision:s.revision()},a);process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: { ...process.env, CAIRN_RECOVERY_TEST_ROOT: root }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const reopened = new ProjectStore({ root, mode: 'authority', ownerId: owner.id, autoProject: false });
    try {
      new RecoveryService(reopened);
      assert.equal(Buffer.from(reopened.getBlob(reopened.files()[0].hash)).toString(), 'original\n');
      assert.equal(reopened.metadata().checkpoints.length, 2);
      assert.equal(count(reopened.db, 'project_operations'), 3);
      assert.ok(reopened.db.prepare("SELECT 1 FROM project_operations WHERE op_id='process-restore'").get());
      assert.equal(reopened.status().projections[0].state, 'pending');
      reopened.projectPending();
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'original\n');
    } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
