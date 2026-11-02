import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Y from 'yjs';
import { Simulation } from '../electron/simulation.js';
import type { ActivityEntry, Checkpoint, ConflictEntry, ImpactPreview, TrashEntry } from '../shared/project.js';

const encode = (text: string): string => Buffer.from(text).toString('base64');
function edit(simulation: Simulation, path: string, text: string): void {
  const file = simulation.current.files.find(file => file.path === path)!;
  const snapshot = simulation.selectFile(file.id)!;
  const doc = new Y.Doc();
  try {
    doc.getText('content'); Y.applyUpdate(doc, Buffer.from(snapshot.state, 'base64'));
    const vector = Y.encodeStateVector(doc);
    const content = doc.getText('content');
    doc.transact(() => { content.delete(0, content.length); content.insert(0, text); });
    simulation.update({ update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'),
      fileId: file.id, generation: file.generation, clientId: snapshot.clientId });
  } finally { doc.destroy(); }
}
function content(simulation: Simulation, filePath: string): string {
  const file = simulation.current.files.find(file => file.path === filePath)!;
  return Buffer.from(simulation.readBlob(file.hash).data, 'base64').toString('utf8');
}

test('simulation exposes clearly labeled disposable data without modifying a normal project or settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-simulation-isolation-'));
  const projectPath = path.join(directory, 'normal-project.txt');
  const settingsPath = path.join(directory, 'normal-settings.json');
  fs.writeFileSync(projectPath, 'Existing user project.\r\n');
  fs.writeFileSync(settingsPath, '{"projects":["normal-project"],"watching":true}\n');
  const initialProject = fs.readFileSync(projectPath);
  const initialSettings = fs.readFileSync(settingsPath);
  const simulation = new Simulation({ name: 'Tester' });
  const separateSession = new Simulation({ name: 'Second session' });
  const separateBefore = separateSession.current;
  try {
    assert.equal(simulation.current.path, 'memory://hackathon');
    assert.equal(simulation.current.name, 'Hackathon Simulation');
    assert.equal(simulation.team.enabled, false);
    assert.equal(simulation.team.port, 0);
    assert.deepEqual(simulation.team.addresses, []);
    assert.equal(simulation.team.confirmedRevision, null);
    assert.equal(simulation.replica.confirmedRevision, null);
    assert.equal(simulation.editor!.localSaved, false);
    assert.ok(simulation.team.peers.every(peer => peer.name.includes('(Simulation)')));
    assert.ok((simulation.query({ kind: 'activity', source: 'declared-ai' }) as ActivityEntry[])
      .some(activity => activity.actor.source.tool === 'Codex (declared simulation)'));
    edit(simulation, 'README.md', '# Edited only in memory\n');
    simulation.setWatching(true);
    simulation.command({ kind: 'create', path: 'demo-only.txt', nodeKind: 'text', data: encode('temporary') });
    simulation.close();
    assert.deepEqual(fs.readFileSync(projectPath), initialProject);
    assert.deepEqual(fs.readFileSync(settingsPath), initialSettings);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['normal-project.txt', 'normal-settings.json']);
    assert.deepEqual(separateSession.current, separateBefore);
  } finally {
    simulation.close(); separateSession.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('text updates change actual Yjs content and emit state, with stale sessions and generations rejected atomically', () => {
  const simulation = new Simulation({ name: 'Tester' });
  try {
    let events = 0; simulation.on('state', () => events++);
    const initial = simulation.editor!;
    edit(simulation, 'README.md', '# Shared trail\nA real in-memory edit.\n');
    assert.equal(simulation.editor!.text, '# Shared trail\nA real in-memory edit.\n');
    assert.equal(content(simulation, 'README.md'), simulation.editor!.text);
    assert.equal(simulation.replica.revision, initial.serverRevision + 1);
    assert.ok(events >= 2);
    const before = simulation.replica;
    assert.throws(() => simulation.update({ update: '', fileId: initial.fileId,
      generation: initial.generation, clientId: 'normal-project-client' }), { code: 'STALE_CLIENT' });
    assert.throws(() => simulation.update({ update: '', fileId: initial.fileId,
      generation: initial.generation + 1, clientId: initial.clientId }), { code: 'STALE_GENERATION' });
    assert.throws(() => simulation.update({ update: 'not-base64!', fileId: initial.fileId,
      generation: initial.generation, clientId: initial.clientId }), { code: 'INVALID_DATA' });
    assert.deepEqual(simulation.replica, before);
    const doc = new Y.Doc();
    try {
      doc.getText('content'); Y.applyUpdate(doc, Buffer.from(simulation.editor!.state, 'base64'));
      assert.equal(doc.getText('content').toString(), simulation.editor!.text);
    } finally { doc.destroy(); }
  } finally { simulation.close(); }
});

test('returned snapshots and metadata cannot mutate the simulation through shared object references', () => {
  const simulation = new Simulation({ name: 'Tester' });
  try {
    const current = simulation.current;
    current.files[0]!.path = 'changed-by-caller';
    const replica = simulation.replica;
    replica.metadata.conflicts.length = 0;
    const checkpoints = simulation.query({ kind: 'checkpoints' }) as Checkpoint[];
    checkpoints[0]!.files.length = 0;
    assert.ok(!simulation.current.files.some(file => file.path === 'changed-by-caller'));
    assert.equal(simulation.replica.metadata.conflicts.length, 1);
    assert.ok((simulation.query({ kind: 'checkpoints' }) as Checkpoint[])[0]!.files.length > 0);
  } finally { simulation.close(); }
});

test('checkpoint restore replaces text, creates a protective checkpoint, and rejects the previous editor generation', () => {
  const simulation = new Simulation({ name: 'Tester' });
  try {
    const checkpoint = (simulation.query({ kind: 'checkpoints' }) as Checkpoint[])[0]!;
    const initialText = content(simulation, 'README.md');
    edit(simulation, 'README.md', '# Changed after checkpoint\n');
    const edited = simulation.editor!;
    const preview = simulation.query({ kind: 'preview-checkpoint', checkpointId: checkpoint.id }) as ImpactPreview;
    assert.equal(preview.updates, 1);
    assert.equal(preview.creates, 1); // Demo notes existed before their staged deletion.
    const event = simulation.command({ kind: 'checkpoint-restore', checkpointId: checkpoint.id, expectedRevision: preview.revision });
    assert.ok(event.result!.protectiveCheckpointId);
    assert.equal(content(simulation, 'README.md'), initialText);
    assert.ok(simulation.current.files.some(file => file.path === 'demo-notes.md'));
    assert.equal((simulation.query({ kind: 'checkpoints' }) as Checkpoint[]).filter(c => c.protected).length, 1);
    assert.throws(() => simulation.update({ update: '', fileId: edited.fileId,
      generation: edited.generation, clientId: edited.clientId }), { code: 'STALE_GENERATION' });
    const restored = simulation.replica;
    assert.throws(() => simulation.command({ kind: 'checkpoint-restore', checkpointId: checkpoint.id,
      expectedRevision: preview.revision }), { code: 'STALE_PREVIEW' });
    assert.deepEqual(simulation.replica, restored);
  } finally { simulation.close(); }
});

test('conflict choices keep local, current remote, separate copies, or merged text and reject stale review', () => {
  for (const choice of ['local', 'remote', 'both', 'merged'] as const) {
    const simulation = new Simulation({ name: 'Tester' });
    try {
      const conflict = (simulation.query({ kind: 'conflicts' }) as ConflictEntry[])[0]!;
      const remote = content(simulation, conflict.path);
      const local = Buffer.from(simulation.readBlob(conflict.localHash!).data, 'base64').toString('utf8');
      const file = simulation.current.files.find(file => file.id === conflict.fileId)!;
      const before = simulation.replica;
      assert.throws(() => simulation.command({ kind: 'conflict-resolve', conflictId: conflict.id, choice,
        expectedRevision: file.revision + 1 }), { code: 'STALE_REVISION' });
      assert.deepEqual(simulation.replica, before);
      const result = simulation.command({ kind: 'conflict-resolve', conflictId: conflict.id, choice,
        expectedRevision: file.revision, ...(choice === 'merged' ? { data: encode('export const merged = true;\n') } : {}) });
      assert.equal((simulation.query({ kind: 'conflicts' }) as ConflictEntry[])[0]!.status, 'resolved');
      assert.equal(content(simulation, conflict.path), choice === 'local' ? local :
        choice === 'merged' ? 'export const merged = true;\n' : remote);
      if (choice === 'both') assert.equal(content(simulation, result.result!.copyPath as string), local);
      assert.throws(() => simulation.command({ kind: 'conflict-resolve', conflictId: conflict.id, choice,
        expectedRevision: file.revision }), { code: 'CONFLICT_RESOLVED' });
    } finally { simulation.close(); }
  }
});

test('file operations, trash restore, previews, claims, and query filters mutate only demo state', () => {
  const simulation = new Simulation({ name: 'Tester' });
  try {
    const trash = (simulation.query({ kind: 'trash' }) as TrashEntry[])[0]!;
    simulation.command({ kind: 'trash-restore', trashId: trash.id, expectedRevision: simulation.replica.revision });
    assert.equal((simulation.query({ kind: 'trash' }) as TrashEntry[]).length, 0);
    assert.match(content(simulation, 'demo-notes.md'), /Practice a safe restore/);
    simulation.command({ kind: 'create', path: 'docs', nodeKind: 'directory' });
    simulation.command({ kind: 'create', path: 'docs/plan.md', nodeKind: 'text', data: encode('Plan A\n'),
      source: { kind: 'declared-ai', tool: 'Codex (declared simulation)' } });
    const folder = simulation.current.files.find(file => file.path === 'docs')!;
    simulation.command({ kind: 'move', fileId: folder.id, path: 'design', baseRevision: folder.revision,
      expectedRevision: simulation.replica.revision });
    assert.equal(content(simulation, 'design/plan.md'), 'Plan A\n');
    const file = simulation.current.files.find(file => file.path === 'design/plan.md')!;
    const claimed = simulation.command({ kind: 'claim-create', fileId: file.id, description: 'Review the plan', strict: true, external: false });
    simulation.command({ kind: 'claim-complete', claimId: claimed.result!.claimId as string });
    assert.ok(simulation.replica.metadata.claims.some(claim => claim.status === 'completed'));
    const preview = simulation.query({ kind: 'preview-delete', fileId: folder.id }) as ImpactPreview;
    assert.equal(preview.deletes, 2);
    const moved = simulation.current.files.find(file => file.id === folder.id)!;
    simulation.command({ kind: 'delete', fileId: folder.id, baseRevision: moved.revision, expectedRevision: preview.revision });
    assert.ok(!simulation.current.files.some(file => file.path.startsWith('design')));
    const deletedFolder = (simulation.query({ kind: 'trash' }) as TrashEntry[]).find(entry => entry.fileId === folder.id)!;
    simulation.command({ kind: 'trash-restore', trashId: deletedFolder.id, expectedRevision: simulation.replica.revision });
    assert.equal(content(simulation, 'design/plan.md'), 'Plan A\n');
    const activities = simulation.query({ kind: 'activity', source: 'declared-ai', fileId: file.id }) as ActivityEntry[];
    assert.equal(activities.length, 1);
    assert.equal(activities[0]!.kind, 'create');
  } finally { simulation.close(); }
});

test('failed tree mutations and strict claim writes roll back all memory state', () => {
  const simulation = new Simulation({ name: 'Tester' });
  try {
    const before = simulation.replica;
    assert.throws(() => simulation.command({ kind: 'create', path: 'src/App.tsx/child.txt', nodeKind: 'text' }), { code: 'PATH_EXISTS' });
    assert.throws(() => simulation.command({ kind: 'create', path: '../escape', nodeKind: 'text' }), { code: 'INVALID_PATH' });
    assert.deepEqual(simulation.replica, before);
    simulation.command({ kind: 'settings', strictClaims: true });
    const strict = simulation.replica;
    assert.throws(() => edit(simulation, 'src/theme.css', 'body { color: red; }\n'), { code: 'FILE_CLAIMED' });
    assert.deepEqual(simulation.replica.files, strict.files);
    assert.deepEqual(simulation.replica.metadata, strict.metadata);
    assert.equal(simulation.replica.revision, strict.revision);
  } finally { simulation.close(); }
});

test('closing and starting again resets content, conflicts, claims and recovery without retaining session data', () => {
  const first = new Simulation({ name: 'Tester' });
  const initialText = content(first, 'README.md');
  const initial = first.editor!;
  edit(first, 'README.md', 'Never persist this edit.\n');
  first.command({ kind: 'create', path: 'ephemeral.txt', nodeKind: 'text', data: encode('Only first session') });
  const conflict = (first.query({ kind: 'conflicts' }) as ConflictEntry[])[0]!;
  first.command({ kind: 'conflict-resolve', conflictId: conflict.id, choice: 'remote', expectedRevision: conflict.revision });
  first.close();
  assert.equal(first.editor, null);
  assert.equal(first.current.files.length, 0);
  assert.equal(first.replica.connection, 'offline');
  assert.throws(() => first.query({ kind: 'metadata' }), { code: 'SIMULATION_CLOSED' });
  assert.throws(() => first.readBlob(initial.serverHash), { code: 'SIMULATION_CLOSED' });
  const second = new Simulation({ name: 'Tester' });
  try {
    assert.notEqual(second.current.projectId, initial.projectId);
    assert.equal(content(second, 'README.md'), initialText);
    assert.ok(!second.current.files.some(file => file.path === 'ephemeral.txt'));
    assert.equal(second.replica.metadata.conflicts.filter(c => c.status === 'open').length, 1);
    assert.equal(second.replica.metadata.checkpoints.length, 1);
    assert.equal(second.replica.metadata.trash.length, 1);
    assert.equal(second.replica.metadata.claims.filter(c => c.status === 'active').length, 1);
    assert.throws(() => second.update({ update: '', fileId: initial.fileId, generation: initial.generation,
      clientId: initial.clientId }), { code: 'STALE_CLIENT' });
  } finally { second.close(); }
});
