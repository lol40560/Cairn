import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as Y from 'yjs';
import { b64, hash } from '../core/common.js';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import type {
  Actor,
  ProjectCommand,
  ProjectEvent,
  ProjectFile,
  SharedMetadata,
  SnapshotManifest,
} from '../shared/project.js';

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-project-store-'));
const owner = (store: ProjectStore): Actor => ({
  id: store.ownerId,
  name: 'Owner',
  role: 'owner',
  source: { kind: 'app' },
});
const op = (command: Omit<ProjectCommand, 'opId'>): ProjectCommand =>
  ({ ...command, opId: randomUUID() }) as ProjectCommand;
function edit(store: ProjectStore, file: ProjectFile, at: number, text: string): ProjectCommand {
  const doc = new Y.Doc();
  doc.getText('content');
  Y.applyUpdate(doc, store.getBlob(file.stateHash!));
  const vector = Y.encodeStateVector(doc);
  doc.getText('content').insert(at, text);
  const update = b64(Y.encodeStateAsUpdate(doc, vector));
  doc.destroy();
  return { opId: randomUUID(), kind: 'text', fileId: file.id, generation: file.generation, update };
}
function blobObjects(store: ProjectStore, snapshot: SnapshotManifest) {
  return snapshot.blobs.map((blob) => ({ hash: blob.hash, data: b64(store.getBlob(blob.hash)) }));
}
const clean = (root: string) =>
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

test('catalog imports byte-exact multi-file data and preserves Yjs identity across restart and another process', () => {
  const root = fixture();
  let store: ProjectStore | undefined;
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'one\r\ntwo\r\n');
    fs.writeFileSync(path.join(root, 'photo.png'), Buffer.from([0, 1, 255, 2]));
    store = new ProjectStore({ root, mode: 'authority', autoProject: false });
    assert.equal(store.files().length, 3);
    const file = store.files().find((f) => f.path === 'src/main.ts')!;
    assert.equal(file.lineEnding, 'crlf');
    assert.equal(file.kind, 'text');
    const state = b64(store.getBlob(file.stateHash!));
    const manifest = store.manifestHash();
    const projectId = store.projectId;
    const busy = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {ProjectStore} from ${JSON.stringify(new URL('../core/project/store.js', import.meta.url).href)};try{new ProjectStore({root:process.argv[1],mode:'authority'});process.exit(2)}catch(e){console.log(e.code)}`,
        root,
      ],
      { encoding: 'utf8' },
    );
    assert.match(busy.stdout, /PROJECT_BUSY/);
    store.close();
    store = undefined;
    const resumed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {ProjectStore} from ${JSON.stringify(new URL('../core/project/store.js', import.meta.url).href)};const s=new ProjectStore({root:process.argv[1],mode:'authority',autoProject:false});console.log(JSON.stringify({manifest:s.manifestHash(),id:s.projectId,state:Buffer.from(s.getBlob(s.files().find(f=>f.path==='src/main.ts').stateHash)).toString('base64')}));s.close();`,
        root,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout.trim()), { manifest, id: projectId, state });
  } finally {
    store?.close();
    clean(root);
  }
});

test('durable apply deduplicates receipts and rolls back every row before any disk projection on failed commit', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    let emissions = 0;
    store.on('change', () => emissions++);
    const command: ProjectCommand = {
      opId: randomUUID(),
      kind: 'create',
      path: 'note.txt',
      nodeKind: 'text',
      data: b64(Buffer.from('hello')),
    };
    const event = store.apply(command, owner(store));
    assert.equal(event.revision, 1);
    assert.equal(emissions, 1);
    assert.equal(fs.existsSync(path.join(root, 'note.txt')), false);
    assert.deepEqual(store.apply(command, owner(store)), event);
    assert.equal(emissions, 1);
    assert.throws(() => store.apply({ ...command, path: 'other.txt' }, owner(store)), {
      code: 'OP_ID_COLLISION',
    });
    const count = (
      store.db.prepare('SELECT count(*) AS n FROM project_blobs').get() as { n: number }
    ).n;
    store.db.exec(
      "CREATE TRIGGER fail_commit BEFORE INSERT ON project_journal BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
    );
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'create',
            path: 'never.txt',
            nodeKind: 'text',
            data: b64(Buffer.from('never committed')),
          },
          owner(store),
        ),
      /injected/,
    );
    assert.equal(store.revision(), 1);
    assert.equal(store.files().length, 1);
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_blobs').get() as { n: number }).n,
      count,
    );
    assert.equal(fs.existsSync(path.join(root, 'never.txt')), false);
    assert.equal(emissions, 1);
    store.db.exec('DROP TRIGGER fail_commit');
    store.projectPending();
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'hello');
    assert.equal(store.status().projections[0]!.state, 'applied');
  } finally {
    store.close();
    clean(root);
  }
});

test('store enforces role, source, generation, binary CAS and global delete preview checks', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const viewer: Actor = { id: 'reader', name: 'Reader', role: 'viewer', source: { kind: 'app' } };
    assert.throws(
      () =>
        store.apply({ opId: randomUUID(), kind: 'create', path: 'x', nodeKind: 'text' }, viewer),
      { code: 'READ_ONLY' },
    );
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'create',
            path: 'x',
            nodeKind: 'text',
            source: { kind: 'authenticated-ai' } as never,
          },
          owner(store),
        ),
      { code: 'INVALID_SOURCE' },
    );
    assert.throws(
      () =>
        store.apply(
          { opId: randomUUID(), kind: 'create', path: '.env', nodeKind: 'text' },
          owner(store),
        ),
      { code: 'EXCLUDED_PATH' },
    );
    store.apply(
      {
        opId: randomUUID(),
        kind: 'create',
        path: 'data.bin',
        nodeKind: 'binary',
        data: b64(Buffer.from([1, 2, 0])),
      },
      owner(store),
    );
    const file = store.files()[0]!;
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'write',
            fileId: file.id,
            generation: 2,
            baseRevision: file.revision,
            baseHash: file.hash,
            data: '',
          },
          owner(store),
        ),
      { code: 'STALE_GENERATION' },
    );
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'write',
            fileId: file.id,
            generation: 1,
            baseRevision: 0,
            baseHash: file.hash,
            data: '',
          },
          owner(store),
        ),
      { code: 'STALE_REVISION' },
    );
    const preview = store.query({ kind: 'preview-delete', fileId: file.id }) as {
      revision: number;
    };
    store.apply(
      { opId: randomUUID(), kind: 'create', path: 'other.txt', nodeKind: 'text' },
      owner(store),
    );
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'delete',
            fileId: file.id,
            baseRevision: file.revision,
            expectedRevision: preview.revision,
          },
          owner(store),
        ),
      { code: 'STALE_PREVIEW' },
    );
    assert.throws(
      () =>
        store.apply(
          { opId: randomUUID(), kind: 'text', fileId: file.id, generation: 1, update: '' },
          owner(store),
        ),
      { code: 'BINARY_FILE' },
    );
  } finally {
    store.close();
    clean(root);
  }
});

test('recursive move keeps stable IDs, deletion preserves ignored children, and filesystem divergence blocks sync', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'folder', 'a.txt'), 'safe');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const folder = store.files().find((f) => f.kind === 'directory')!;
    const file = store.files().find((f) => f.kind === 'text')!;
    store.apply(
      {
        opId: randomUUID(),
        kind: 'move',
        fileId: folder.id,
        path: 'moved',
        baseRevision: folder.revision,
        expectedRevision: store.revision(),
      },
      owner(store),
    );
    store.projectPending();
    assert.equal(store.file(file.id)!.path, 'moved/a.txt');
    assert.equal(fs.readFileSync(path.join(root, 'moved', 'a.txt'), 'utf8'), 'safe');
    assert.equal(fs.existsSync(path.join(root, 'folder')), false);
    fs.writeFileSync(path.join(root, 'moved', '.env'), 'secret must remain');
    const current = store.file(folder.id)!;
    store.apply(
      {
        opId: randomUUID(),
        kind: 'delete',
        fileId: folder.id,
        baseRevision: current.revision,
        expectedRevision: store.revision(),
      },
      owner(store),
    );
    store.projectPending();
    assert.equal(fs.readFileSync(path.join(root, 'moved', '.env'), 'utf8'), 'secret must remain');
    assert.equal(store.files().length, 0);
    assert.equal(store.file(file.id)!.deleted, true);
    assert.equal(store.status().projections.find((p) => p.fileId === folder.id)!.state, 'blocked');
  } finally {
    store.close();
    clean(root);
  }
});

test('external safe changes retain Yjs structure, stale buffers conflict, explicit baseline adoption allows the next safe save', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha beta gamma');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  const conflicts: ProjectCommand[] = [];
  store.registerCommand('conflict-create', (command) => {
    conflicts.push(command);
    if (command.kind === 'conflict-create' && command.localData)
      store.putBlob(Buffer.from(command.localData, 'base64'));
    return { conflictId: randomUUID() };
  });
  try {
    const initial = store.files()[0]!;
    const oldDoc = new Y.Doc();
    oldDoc.getText('content');
    Y.applyUpdate(oldDoc, store.getBlob(initial.stateHash!));
    const originalClients = [...oldDoc.store.clients.keys()];
    oldDoc.destroy();
    fs.writeFileSync(path.join(root, 'note.txt'), 'alpha BETA gamma');
    store.scanExternal();
    const saved = store.file(initial.id)!;
    assert.equal(Buffer.from(store.getBlob(saved.hash)).toString(), 'alpha BETA gamma');
    const newDoc = new Y.Doc();
    newDoc.getText('content');
    Y.applyUpdate(newDoc, store.getBlob(saved.stateHash!));
    for (const client of originalClients) assert.ok(newDoc.store.clients.has(client));
    newDoc.destroy();
    store.apply(edit(store, saved, 0, 'remote '), owner(store));
    store.projectPending();
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'remote alpha BETA gamma');
    fs.writeFileSync(path.join(root, 'note.txt'), 'alpha BETA gamma external');
    store.scanExternal();
    assert.equal(conflicts.length, 1);
    assert.equal(
      Buffer.from(store.getBlob(store.file(initial.id)!.hash)).toString(),
      'remote alpha BETA gamma',
    );
    store.scanExternal();
    assert.equal(conflicts.length, 1);
    fs.writeFileSync(path.join(root, 'note.txt'), store.getBlob(store.file(initial.id)!.hash));
    store.adoptExternalBaseline(initial.id);
    fs.writeFileSync(path.join(root, 'note.txt'), 'remote alpha BETA gamma accepted');
    store.scanExternal();
    assert.equal(
      Buffer.from(store.getBlob(store.file(initial.id)!.hash)).toString(),
      'remote alpha BETA gamma accepted',
    );
    assert.equal(conflicts.length, 1);
  } finally {
    store.close();
    clean(root);
  }
});

test('snapshots pin immutable state, canonical replica install and ingest are atomic and never overwrite its workcopy', () => {
  const root = fixture();
  const replicaRoot = fixture();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one');
  const authority = new ProjectStore({ root, mode: 'authority', autoProject: false });
  const replica = new ProjectStore({
    root: replicaRoot,
    mode: 'replica',
    projectId: authority.projectId,
  });
  try {
    const pinned = authority.snapshot();
    const pinnedBytes = blobObjects(authority, pinned);
    const file = authority.files()[0]!;
    const event = authority.apply(edit(authority, file, 3, ' two'), owner(authority));
    assert.equal(Buffer.from(authority.getBlob(pinned.files[0]!.hash)).toString(), 'one');
    replica.installSnapshot(pinned, pinnedBytes, () =>
      replica.db.exec('CREATE TABLE local_receipt(id TEXT PRIMARY KEY)'),
    );
    assert.equal(replica.revision(), 0);
    assert.equal(fs.existsSync(path.join(replicaRoot, 'a.txt')), false);
    const latest = authority.snapshot();
    const bytes = blobObjects(authority, latest);
    assert.throws(
      () =>
        replica.ingest(event, bytes, () => {
          replica.db.prepare('INSERT INTO local_receipt VALUES (?)').run('rollback');
          throw new Error('local merge failed');
        }),
      /local merge failed/,
    );
    assert.equal(replica.revision(), 0);
    assert.equal(replica.manifestHash(), pinned.manifestHash);
    assert.equal(replica.db.prepare('SELECT * FROM local_receipt').all().length, 0);
    replica.ingest(event, bytes, () =>
      replica.db.prepare('INSERT INTO local_receipt VALUES (?)').run('committed'),
    );
    assert.equal(replica.manifestHash(), authority.manifestHash());
    assert.equal(fs.existsSync(path.join(replicaRoot, 'a.txt')), false);
    assert.equal(replica.eventsSince(0).length, 1);
    fs.writeFileSync(path.join(replicaRoot, 'a.txt'), 'pending local text');
    replica.installSnapshot(latest, bytes);
    assert.equal(fs.readFileSync(path.join(replicaRoot, 'a.txt'), 'utf8'), 'pending local text');
    assert.throws(
      () => replica.installSnapshot({ ...latest, manifestHash: hash('tampered') }, bytes),
      { code: 'INVALID_SNAPSHOT' },
    );
  } finally {
    replica.close();
    authority.close();
    clean(replicaRoot);
    clean(root);
  }
});

test('unknown existing replica content is refused and failed projections remain blocked with both versions intact', () => {
  const root = fixture();
  const replicaRoot = fixture();
  fs.writeFileSync(path.join(root, 'note.txt'), 'base');
  fs.writeFileSync(path.join(replicaRoot, 'unrelated.txt'), 'keep');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  const replica = new ProjectStore({
    root: replicaRoot,
    mode: 'replica',
    projectId: store.projectId,
  });
  try {
    const snapshot = store.snapshot();
    assert.throws(() => replica.installSnapshot(snapshot, blobObjects(store, snapshot)), {
      code: 'WORKCOPY_NOT_EMPTY',
    });
    assert.equal(fs.readFileSync(path.join(replicaRoot, 'unrelated.txt'), 'utf8'), 'keep');
    const file = store.files()[0]!;
    store.apply(edit(store, file, 4, ' canonical'), owner(store));
    fs.writeFileSync(path.join(root, 'note.txt'), 'outside');
    store.projectPending();
    assert.equal(store.status().projections[0]!.state, 'blocked');
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'outside');
    assert.equal(
      Buffer.from(store.getBlob(store.file(file.id)!.hash)).toString(),
      'base canonical',
    );
    assert.ok(
      fs
        .readdirSync(path.join(root, '.cairn-next', 'recovery'))
        .some((name) => name.startsWith('external-')),
    );
  } finally {
    replica.close();
    store.close();
    clean(replicaRoot);
    clean(root);
  }
});

test('new external files import online and held projections resume without trusting a stale baseline', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    fs.mkdirSync(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new', 'file.txt'), 'created outside');
    store.scanExternal();
    const file = store.files().find((f) => f.path === 'new/file.txt')!;
    assert.ok(file);
    assert.equal(store.status().projections.find((p) => p.fileId === file.id)!.state, 'applied');
    let held = true;
    store.setProjectionHold(() => held);
    store.apply(edit(store, file, 0, 'app '), owner(store));
    store.projectPending();
    assert.equal(store.status().projections.find((p) => p.fileId === file.id)!.state, 'held');
    assert.equal(fs.readFileSync(path.join(root, 'new', 'file.txt'), 'utf8'), 'created outside');
    held = false;
    store.projectPending();
    assert.equal(
      fs.readFileSync(path.join(root, 'new', 'file.txt'), 'utf8'),
      'app created outside',
    );
  } finally {
    store.close();
    clean(root);
  }
});

test('pending create followed by moves projects directly to its final path and unchanged scans do not create revisions', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    store.apply(
      {
        opId: randomUUID(),
        kind: 'create',
        path: 'first.txt',
        nodeKind: 'text',
        data: b64(Buffer.from('pending')),
      },
      owner(store),
    );
    const file = store.files()[0]!;
    store.apply(
      {
        opId: randomUUID(),
        kind: 'move',
        fileId: file.id,
        path: 'last.txt',
        baseRevision: file.revision,
      },
      owner(store),
    );
    store.projectPending();
    assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'last.txt'), 'utf8'), 'pending');
    const revision = store.revision();
    store.scanExternal();
    store.scanExternal();
    assert.equal(store.revision(), revision);
  } finally {
    store.close();
    clean(root);
  }
});

test('canonical ignore updates unshare content in the same event before disk projection', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  fs.writeFileSync(path.join(root, 'private.txt'), 'preserve on disk');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const ignore = store.files().find((f) => f.path === '.gitignore')!;
    const file = store.files().find((f) => f.path === 'private.txt')!;
    const event = store.apply(
      {
        opId: randomUUID(),
        kind: 'write',
        fileId: ignore.id,
        generation: ignore.generation,
        baseRevision: ignore.revision,
        baseHash: ignore.hash,
        data: b64(Buffer.from('private.txt\n')),
      },
      owner(store),
    );
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '');
    assert.equal(store.file(file.id)!.deleted, true);
    assert.ok(event.changes.some((change) => change.after.id === file.id && change.preserveDisk));
    assert.equal(
      store.snapshot().files.some((f) => f.id === file.id),
      false,
    );
    store.projectPending();
    assert.equal(fs.readFileSync(path.join(root, 'private.txt'), 'utf8'), 'preserve on disk');
  } finally {
    store.close();
    clean(root);
  }
});

test('a restore event can follow a live-only snapshot that omitted its older tombstone', () => {
  const root = fixture();
  const replicaRoot = fixture();
  fs.writeFileSync(path.join(root, 'note.txt'), 'recover');
  const authority = new ProjectStore({ root, mode: 'authority', autoProject: false });
  const replica = new ProjectStore({
    root: replicaRoot,
    mode: 'replica',
    projectId: authority.projectId,
  });
  try {
    const file = authority.files()[0]!;
    authority.apply(
      {
        opId: randomUUID(),
        kind: 'delete',
        fileId: file.id,
        baseRevision: file.revision,
        expectedRevision: authority.revision(),
      },
      owner(authority),
    );
    const deleted = authority.file(file.id)!;
    const snapshot = authority.snapshot();
    assert.equal(snapshot.files.length, 0);
    replica.installSnapshot(snapshot, blobObjects(authority, snapshot));
    authority.registerCommand('trash-restore', () => {
      authority.stageFile(authority.textFile(deleted, 'recover', true));
    });
    const restored = authority.apply(
      {
        opId: randomUUID(),
        kind: 'trash-restore',
        trashId: 'fixture',
        expectedRevision: authority.revision(),
      },
      owner(authority),
    );
    replica.ingest(restored, blobObjects(authority, authority.snapshot()));
    assert.equal(replica.file(file.id)!.generation, 3);
    assert.equal(replica.manifestHash(), authority.manifestHash());
  } finally {
    replica.close();
    authority.close();
    clean(replicaRoot);
    clean(root);
  }
});

test('binary transfer bound accepts 16 MiB and rejects larger bytes without changing the catalog', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 137);
    store.apply(
      {
        opId: randomUUID(),
        kind: 'create',
        path: 'large.bin',
        nodeKind: 'binary',
        data: b64(bytes),
      },
      owner(store),
    );
    assert.equal(store.files()[0]!.size, bytes.length);
    assert.deepEqual(store.getBlob(store.files()[0]!.hash), new Uint8Array(bytes));
    const revision = store.revision();
    assert.throws(
      () =>
        store.apply(
          {
            opId: randomUUID(),
            kind: 'create',
            path: 'oversize.bin',
            nodeKind: 'binary',
            data: b64(Buffer.alloc(bytes.length + 1)),
          },
          owner(store),
        ),
      { code: 'SIZE_LIMIT' },
    );
    assert.equal(store.revision(), revision);
    assert.equal(store.files().length, 1);
  } finally {
    store.close();
    clean(root);
  }
});

test('real watcher imports an external save, keeps its source Unknown, and ignores its own content-hash projection', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'watched.txt'), 'before');
  const store = new ProjectStore({ root, mode: 'authority' });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail('Watcher did not reach the expected catalog state');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  try {
    store.startWatching();
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(root, 'watched.txt'), 'outside');
    await waitFor(() => store.files()[0]!.hash === hash('outside'));
    assert.equal(store.eventsSince(0)[0]!.actor.source.kind, 'unknown');
    const file = store.files()[0]!;
    store.apply(edit(store, file, 7, ' app'), owner(store));
    await waitFor(() => fs.readFileSync(path.join(root, 'watched.txt'), 'utf8') === 'outside app');
    const revision = store.revision();
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(store.revision(), revision);
    store.stopWatching();
    assert.equal(store.status().watching, false);
  } finally {
    store.close();
    clean(root);
  }
});

test('a leaf file can change casing without losing its identity or becoming an ignored tombstone', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'Example.txt'), 'case preserved');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const file = store.files()[0]!;
    store.apply(
      {
        opId: randomUUID(),
        kind: 'move',
        fileId: file.id,
        path: 'example.txt',
        baseRevision: file.revision,
      },
      owner(store),
    );
    store.projectPending();
    assert.equal(store.file(file.id)!.deleted, false);
    assert.equal(store.file(file.id)!.path, 'example.txt');
    assert.equal(store.status().projections[0]!.state, 'applied');
    assert.ok(fs.readdirSync(root).includes('example.txt'));
    assert.ok(!fs.readdirSync(root).includes('Example.txt'));
  } finally {
    store.close();
    clean(root);
  }
});

test('external actor attribution remains Unknown by default and records AI only when explicitly declared', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'note.txt'), 'first');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    store.setExternalActor({ ...owner(store), name: 'Alice', source: { kind: 'app' } });
    fs.writeFileSync(path.join(root, 'note.txt'), 'second');
    store.scanExternal();
    assert.equal(store.eventsSince(0)[0]!.actor.source.kind, 'unknown');
    assert.equal(store.eventsSince(0)[0]!.actor.name, 'Alice');
    store.setExternalActor({
      ...owner(store),
      name: 'Alice',
      source: { kind: 'declared-ai', tool: 'User-declared tool' },
    });
    fs.writeFileSync(path.join(root, 'note.txt'), 'third');
    store.scanExternal();
    assert.deepEqual(store.eventsSince(1)[0]!.actor.source, {
      kind: 'declared-ai',
      tool: 'User-declared tool',
    });
    assert.throws(
      () =>
        store.setExternalActor({ ...owner(store), source: { kind: 'authenticated-ai' } as never }),
      { code: 'INVALID_ACTOR' },
    );
  } finally {
    store.close();
    clean(root);
  }
});

test('self-excluding ignore controls are rejected before they can silently drop protection', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(root, 'private.txt'), 'must not be shared');
  try {
    assert.throws(() => new ProjectStore({ root, mode: 'authority', autoProject: false }), {
      code: 'INVALID_IGNORE',
    });
    fs.writeFileSync(path.join(root, '.gitignore'), 'private.txt\n');
    const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
    try {
      const control = store.files()[0]!;
      assert.equal(control.path, '.gitignore');
      assert.throws(
        () =>
          store.apply(
            {
              opId: randomUUID(),
              kind: 'write',
              fileId: control.id,
              generation: control.generation,
              baseRevision: control.revision,
              baseHash: control.hash,
              data: b64(Buffer.from('*\n')),
            },
            owner(store),
          ),
        { code: 'INVALID_IGNORE' },
      );
      assert.equal(store.revision(), 0);
      assert.equal(store.snapshot().files.length, 1);
      assert.equal(fs.readFileSync(path.join(root, 'private.txt'), 'utf8'), 'must not be shared');
    } finally {
      store.close();
    }
  } finally {
    clean(root);
  }
});

test('reviewed external conflicts project the selected bytes, while later external saves still win CAS', () => {
  for (const choice of ['remote', 'local', 'both', 'merged', 'newer-save', 'missing'] as const) {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'note.txt'), 'base');
    const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
    new RecoveryService(store);
    try {
      const file = store.files()[0]!;
      store.apply(edit(store, file, 4, ' remote'), owner(store));
      store.projectPending();
      if (choice === 'missing') fs.unlinkSync(path.join(root, 'note.txt'));
      else fs.writeFileSync(path.join(root, 'note.txt'), 'reviewed outside');
      store.scanExternal();
      const conflict = store.metadata().conflicts.find((entry) => entry.status === 'open')!;
      assert.ok(conflict);
      assert.equal(store.status().projections[0]!.state, 'blocked');
      if (choice === 'newer-save')
        fs.writeFileSync(path.join(root, 'note.txt'), 'newer unreviewed save');
      store.apply(
        {
          opId: randomUUID(),
          kind: 'conflict-resolve',
          conflictId: conflict.id,
          choice: choice === 'newer-save' || choice === 'missing' ? 'remote' : choice,
          expectedRevision: store.file(file.id)!.revision,
          ...(choice === 'merged' ? { data: b64(Buffer.from('reviewed merged')) } : {}),
        },
        owner(store),
      );
      store.projectPending();
      const expected =
        choice === 'local'
          ? 'reviewed outside'
          : choice === 'merged'
            ? 'reviewed merged'
            : choice === 'newer-save'
              ? 'newer unreviewed save'
              : 'base remote';
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), expected, choice);
      assert.equal(
        store.status().projections.find((p) => p.fileId === file.id)!.state,
        choice === 'newer-save' ? 'blocked' : 'applied',
        choice,
      );
      if (choice === 'both')
        assert.equal(
          fs.readFileSync(
            path.join(root, store.files().find((f) => f.id !== file.id)!.path),
            'utf8',
          ),
          'reviewed outside',
        );
    } finally {
      store.close();
      clean(root);
    }
  }
});

test('an oversized external replacement remains on disk and cannot report applied projection', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'note.txt'), 'small');
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const file = store.files()[0]!;
    fs.writeFileSync(path.join(root, 'note.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    store.scanExternal();
    assert.equal(store.file(file.id)!.hash, hash('small'));
    assert.equal(store.status().projections[0]!.state, 'blocked');
    assert.equal(fs.statSync(path.join(root, 'note.txt')).size, 16 * 1024 * 1024 + 1);
    assert.equal(store.revision(), 0);
  } finally {
    store.close();
    clean(root);
  }
});

const wireBudget = 20 * 1024 * 1024;
const emptyMetadata = (): SharedMetadata => ({
  claims: [],
  conflicts: [],
  checkpoints: [],
  trash: [],
  ignorePatterns: [],
  retentionDays: 30,
  strictClaims: false,
});
function longCatalog(count: number, digest: string): ProjectFile[] {
  const prefix = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}/${'e'.repeat(195)}`;
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture-${index}`,
    path: `${prefix}-${String(index).padStart(4, '0')}.bin`,
    kind: 'binary',
    generation: 1,
    revision: 0,
    hash: digest,
    size: 0,
    stateHash: null,
    lineEnding: null,
    deleted: false,
  }));
}
function bulkEvent(store: ProjectStore, files: ProjectFile[], revision: number): ProjectEvent {
  const actor = owner(store),
    opId = `bulk-${revision}`;
  const changes = files.map((file) => ({
    before: { ...file, revision: revision - 1 },
    after: { ...file, generation: 2, revision, deleted: true },
  }));
  return {
    opId,
    revision,
    time: revision,
    actor,
    kind: 'delete',
    changes,
    metadata: emptyMetadata(),
    manifestHash: hash(''),
    activity: {
      id: `activity-${revision}`,
      opId,
      revision,
      time: revision,
      actor,
      kind: 'delete',
      paths: files.map((file) => file.path),
      files: changes,
      added: 0,
      removed: 0,
      summary: `delete: ${files.length} entries`,
      sessionId: 'fixture',
    },
  };
}

test('oversized atomic event rolls back catalog, recovery metadata, blobs, projections and receipts before any disk write', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const digest = store.putBlob(new Uint8Array());
    const files = longCatalog(5000, digest);
    assert.ok(Buffer.byteLength(files[0]!.path) <= 1024);
    store.db.exec('CREATE TABLE wire_fixture_metadata(value TEXT NOT NULL); BEGIN IMMEDIATE');
    const insert = store.db.prepare('INSERT INTO project_files VALUES (?,?)');
    for (const file of files) insert.run(file.id, JSON.stringify(file));
    store.db
      .prepare('INSERT INTO wire_fixture_metadata VALUES (?)')
      .run(JSON.stringify(emptyMetadata()));
    store.db.exec('COMMIT');
    store.setMetadataProvider(
      () =>
        JSON.parse(
          (store.db.prepare('SELECT value FROM wire_fixture_metadata').get() as { value: string })
            .value,
        ) as SharedMetadata,
    );
    fs.writeFileSync(path.join(root, 'keep-local.txt'), 'must stay untouched');
    const snapshot = store.snapshot();
    assert.equal(snapshot.files.length, 5000);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < wireBudget);
    const beforeHash = store.manifestHash();
    let emitted = 0;
    store.on('change', () => emitted++);
    store.registerCommand('checkpoint-restore', () => {
      const metadata = emptyMetadata();
      metadata.checkpoints.push({
        id: 'protective',
        name: 'Before large deletion',
        createdAt: 1,
        revision: 0,
        actorName: 'Owner',
        protected: true,
        files,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 8 * 1024 * 1024);
      store.db.prepare('UPDATE wire_fixture_metadata SET value=?').run(JSON.stringify(metadata));
      store.putBlob(Buffer.from('uncommitted recovery payload'));
      for (const file of files) store.stageFile({ ...file, generation: 2, deleted: true });
    });
    const command: ProjectCommand = {
      opId: randomUUID(),
      kind: 'checkpoint-restore',
      checkpointId: 'fixture',
      expectedRevision: 0,
    };
    assert.throws(() => store.apply(command, owner(store)), { code: 'OPERATION_TOO_LARGE' });
    assert.equal(store.revision(), 0);
    assert.equal(store.manifestHash(), beforeHash);
    assert.equal(store.files().length, 5000);
    assert.equal(store.metadata().checkpoints.length, 0);
    assert.equal(emitted, 0);
    for (const table of ['project_journal', 'project_operations', 'project_projections'])
      assert.equal(
        (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
        0,
        table,
      );
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_blobs').get() as { n: number }).n,
      1,
    );
    assert.equal(fs.readFileSync(path.join(root, 'keep-local.txt'), 'utf8'), 'must stay untouched');
    assert.deepEqual(fs.readdirSync(root).sort(), ['.cairn-next', 'keep-local.txt']);
  } finally {
    store.close();
    clean(root);
  }
});

test('history and activity pages stop at the JSON byte boundary without truncating records or stalling the cursor', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const files = longCatalog(2500, hash(''));
    const sample = bulkEvent(store, files, 1);
    const eventBytes = Buffer.byteLength(JSON.stringify(sample));
    const activityBytes = Buffer.byteLength(JSON.stringify(sample.activity));
    assert.ok(eventBytes < wireBudget && eventBytes * 2 + 3 > wireBudget);
    assert.ok(activityBytes * 2 + 3 <= wireBudget && activityBytes * 3 + 4 > wireBudget);
    store.db.exec('BEGIN IMMEDIATE');
    const insert = store.db.prepare('INSERT INTO project_journal VALUES (?,?)');
    for (let revision = 1; revision <= 4; revision++)
      insert.run(revision, JSON.stringify(bulkEvent(store, files, revision)));
    store.db.prepare("UPDATE project_meta SET value='4' WHERE key='revision'").run();
    store.db.exec('COMMIT');
    const observed: number[] = [];
    let cursor = 0;
    while (cursor < 4) {
      const page = store.eventsSince(cursor, 256);
      assert.equal(page.length, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= wireBudget);
      assert.equal(page[0]!.changes.length, 2500);
      assert.equal(page[0]!.activity.files.length, 2500);
      cursor = page[0]!.revision;
      observed.push(cursor);
    }
    assert.deepEqual(observed, [1, 2, 3, 4]);
    assert.deepEqual(store.eventsSince(4), []);
    const activity = store.query({ kind: 'activity', limit: 100 }) as ProjectEvent['activity'][];
    assert.deepEqual(
      activity.map((entry) => entry.revision),
      [4, 3],
    );
    assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= wireBudget);
    assert.equal(activity[0]!.files.length, 2500);
    assert.equal((store.query({ kind: 'activity', limit: 1 }) as unknown[]).length, 1);
    assert.deepEqual(
      store.query({ kind: 'activity', search: 'no matching activity' }) as unknown[],
      [],
    );
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_journal').get() as { n: number }).n,
      4,
    );
  } finally {
    store.close();
    clean(root);
  }
});

test('a single event exactly fitting an array is returned intact, while an oversized legacy item fails explicitly', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const event = bulkEvent(store, [], 1);
    event.result = { padding: '' };
    const overhead = Buffer.byteLength(JSON.stringify(event));
    event.result.padding = 'x'.repeat(wireBudget - 2 - overhead);
    const serialized = JSON.stringify(event);
    assert.equal(Buffer.byteLength(serialized) + 2, wireBudget);
    store.db.prepare('INSERT INTO project_journal VALUES (?,?)').run(1, serialized);
    store.db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
    const page = store.eventsSince(0);
    assert.equal(page.length, 1);
    assert.equal(Buffer.byteLength(JSON.stringify(page)), wireBudget);
    assert.equal(page[0]!.result!.padding, event.result.padding);
    event.result.padding += 'x';
    store.db
      .prepare('UPDATE project_journal SET event=? WHERE revision=1')
      .run(JSON.stringify(event));
    assert.throws(() => store.eventsSince(0), { code: 'OPERATION_TOO_LARGE' });
    assert.equal(store.revision(), 1);
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_journal').get() as { n: number }).n,
      1,
    );
    const activityEvent = bulkEvent(store, [], 1);
    activityEvent.activity.summary = 'x'.repeat(wireBudget);
    store.db
      .prepare('UPDATE project_journal SET event=? WHERE revision=1')
      .run(JSON.stringify(activityEvent));
    assert.throws(() => store.query({ kind: 'activity' }), { code: 'OPERATION_TOO_LARGE' });
  } finally {
    store.close();
    clean(root);
  }
});

test('a fitting metadata event cannot commit a catalog whose next snapshot would exceed the wire budget', () => {
  const root = fixture();
  const store = new ProjectStore({ root, mode: 'authority', autoProject: false });
  try {
    const digest = store.putBlob(new Uint8Array());
    const checkpointFiles = longCatalog(4500, digest);
    // ProjectFile reason is an optional descriptive string. Populate schema-valid
    // catalog rows without creating thousands of long filesystem paths.
    const files = checkpointFiles.map((file) => ({
      ...file,
      reason: 'Shared binary format. '.repeat(115),
    }));
    store.db.exec('CREATE TABLE snapshot_fixture_metadata(value TEXT NOT NULL); BEGIN IMMEDIATE');
    const insert = store.db.prepare('INSERT INTO project_files VALUES (?,?)');
    for (const file of files) insert.run(file.id, JSON.stringify(file));
    store.db
      .prepare('INSERT INTO snapshot_fixture_metadata VALUES (?)')
      .run(JSON.stringify(emptyMetadata()));
    store.db.exec('COMMIT');
    store.setMetadataProvider(
      () =>
        JSON.parse(
          (
            store.db.prepare('SELECT value FROM snapshot_fixture_metadata').get() as {
              value: string;
            }
          ).value,
        ) as SharedMetadata,
    );
    const before = store.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(before)) < wireBudget);
    const metadata = emptyMetadata();
    metadata.checkpoints.push({
      id: 'checkpoint',
      name: 'Saved state',
      createdAt: 1,
      revision: 0,
      actorName: 'Owner',
      protected: false,
      files: checkpointFiles,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 8 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...before, metadata })) > wireBudget);
    const event = bulkEvent(store, [], 1);
    event.metadata = metadata;
    assert.ok(Buffer.byteLength(JSON.stringify(event)) < wireBudget);
    store.registerCommand('checkpoint-create', () => {
      store.db
        .prepare('UPDATE snapshot_fixture_metadata SET value=?')
        .run(JSON.stringify(metadata));
    });
    assert.throws(
      () =>
        store.apply(
          { opId: randomUUID(), kind: 'checkpoint-create', name: 'Saved state' },
          owner(store),
        ),
      { code: 'OPERATION_TOO_LARGE' },
    );
    assert.equal(store.revision(), 0);
    assert.equal(store.manifestHash(), before.manifestHash);
    assert.equal(store.metadata().checkpoints.length, 0);
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_journal').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM project_operations').get() as { n: number }).n,
      0,
    );
  } finally {
    store.close();
    clean(root);
  }
});
