import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { CurrentProject } from '../shared/release-api.js';
import type { ClientSnapshot } from '../shared/types.js';
import { MAX_TEXT_BYTES, MAX_UPDATE_BYTES } from '../shared/types.js';
import type {
  Actor, ActivityEntry, ChangeSource, Checkpoint, CommandInput, ConflictEntry,
  FileChange, FileKind, ImpactPreview, ProjectEvent, ProjectFile, ReplicaStatus,
  SharedMetadata, StoreQuery, TeamStatus,
} from '../shared/project.js';

const ROOT = 'memory://hackathon';
const TITLE = 'Hackathon Simulation';
const clone = <T>(value: T): T => structuredClone(value);
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function fail(code: string, message: string): never {
  throw Object.assign(new Error(`[${code}] ${message}`), { code });
}

/** A disposable, isolated project. Never imports a store, filesystem, or transport. */
export class Simulation extends EventEmitter {
  private readonly projectId = `simulation-${randomUUID()}`;
  private readonly clientId = `simulation-client-${randomUUID()}`;
  private readonly actor: Actor;
  private readonly sessionId = randomUUID();
  private files = new Map<string, ProjectFile>();
  private blobs = new Map<string, string>();
  private metadata: SharedMetadata = {
    claims: [], conflicts: [], checkpoints: [], trash: [], ignorePatterns: [],
    retentionDays: 30, strictClaims: false,
  };
  private activity: ActivityEntry[] = [];
  private revision = 0;
  private selected: string | null = null;
  private watching = false;
  private closed = false;

  constructor(options: { name: string }) {
    super();
    this.actor = { id: `simulation-owner-${randomUUID()}`, clientId: this.clientId,
      name: `${options.name.trim() || 'You'} (Simulation)`, role: 'owner', source: { kind: 'app' } };
    this.seed();
  }

  get current(): CurrentProject {
    return { id: this.projectId, projectId: this.projectId, name: TITLE, path: ROOT,
      kind: 'local', files: this.activeFiles(), excluded: [], watching: this.watching };
  }

  get team(): TeamStatus {
    return { teamId: `simulation-team-${this.projectId}`, projectId: this.projectId,
      name: TITLE, enabled: false, port: 0, addresses: [], revision: this.revision,
      manifestHash: this.manifestHash(), confirmedRevision: null,
      peers: [
        { clientId: this.clientId, memberId: this.actor.id, name: this.actor.name, role: 'owner',
          appliedRevision: this.revision, projection: 'applied', ...(this.selected ? { activeFileId: this.selected } : {}) },
        { clientId: 'simulation-mina', memberId: 'simulation-mina', name: 'Mina (Simulation)', role: 'editor',
          appliedRevision: this.revision, projection: 'applied', activeFileId: this.findPath('src/App.tsx')?.id },
        { clientId: 'simulation-jun', memberId: 'simulation-jun', name: 'Jun (Simulation)', role: 'viewer',
          appliedRevision: this.revision, projection: 'applied' },
      ] };
  }

  get replica(): ReplicaStatus {
    const files = this.activeFiles();
    return { projectId: this.projectId, clientId: this.clientId, actorId: this.actor.id,
      name: this.actor.name, role: 'owner', root: ROOT,
      // Online here means the in-memory command adapter is available. No socket exists.
      connection: this.closed ? 'offline' : 'online', initialized: !this.closed,
      pending: 0, rejected: 0, revision: this.revision, manifestHash: this.manifestHash(),
      confirmedRevision: null, team: this.team,
      transfer: { stage: this.closed ? 'idle' : 'ready', doneBytes: 0, totalBytes: 0,
        doneFiles: 0, totalFiles: 0 }, files,
      projections: files.map(file => ({ fileId: file.id, path: file.path, hash: file.hash, state: 'applied' })),
      metadata: clone(this.metadata), watching: this.watching };
  }

  get editor(): ClientSnapshot | null {
    const file = this.selected ? this.files.get(this.selected) : undefined;
    if (this.closed || !file || file.deleted || file.kind !== 'text') return null;
    return { connection: 'online', initialized: true, clientId: this.clientId,
      name: this.actor.name, role: 'owner', projectId: this.projectId, fileId: file.id,
      generation: file.generation, fileName: file.path, lineEnding: file.lineEnding ?? 'lf',
      text: this.text(file.hash), state: this.blob(file.stateHash!), pending: 0, rejected: 0,
      localSaved: false, serverRevision: this.revision, serverHash: file.hash,
      serverProjection: 'applied', localProjection: 'applied', peers: this.team.peers,
      confirmedRevision: null, directory: ROOT };
  }

  selectFile(id: string): ClientSnapshot | null {
    this.assertOpen();
    this.requireFile(id);
    this.selected = id;
    this.emit('state');
    return this.editor;
  }

  update(input: { update: string; fileId: string; generation: number; clientId: string }): ClientSnapshot {
    this.assertOpen();
    if (input.clientId !== this.clientId) fail('STALE_CLIENT', 'This editor belongs to another simulation session.');
    const file = this.requireFile(input.fileId);
    if (file.kind !== 'text') fail('BINARY_FILE', 'Only text files support collaborative editing.');
    this.command({ kind: 'text', fileId: input.fileId, generation: input.generation, update: input.update });
    // An IPC update can finish after selection changed; return the edited file, without changing selection.
    const selected = this.selected;
    this.selected = file.id;
    const snapshot = this.editor!;
    this.selected = selected;
    return snapshot;
  }

  command(input: CommandInput): ProjectEvent {
    this.assertOpen();
    const backup = { files: clone(this.files), blobs: new Map(this.blobs), metadata: clone(this.metadata) };
    const before = new Map([...this.files].map(([id, file]) => [id, clone(file)]));
    let result: Record<string, unknown>;
    try { result = this.apply(input); this.validateTree(); }
    catch (error) {
      this.files = backup.files; this.blobs = backup.blobs; this.metadata = backup.metadata;
      throw error;
    }
    const changes: FileChange[] = [];
    for (const [id, file] of this.files) {
      const previous = before.get(id) ?? null;
      if (JSON.stringify(previous) !== JSON.stringify(file)) {
        if (previous) {
          const claim = this.metadata.claims.find(c => c.fileId === id && c.ownerId !== this.actor.id &&
            c.status === 'active' && c.expiresAt > Date.now() && (c.strict || this.metadata.strictClaims));
          if (claim) {
            this.files = backup.files; this.blobs = backup.blobs; this.metadata = backup.metadata;
            fail('FILE_CLAIMED', 'An active strict claim covers this file. Cancel it or wait until it finishes.');
          }
        }
        file.revision = this.revision + 1;
        changes.push({ before: previous, after: clone(file) });
      }
    }
    this.revision++;
    const actor = { ...this.actor, source: clone('source' in input && input.source ? input.source : { kind: 'app' } as ChangeSource) };
    const opId = randomUUID();
    const time = Date.now();
    const counts = changes.reduce((total, change) => {
      const oldLines = change.before?.kind === 'text' && !change.before.deleted ? this.text(change.before.hash).split('\n') : [];
      const newLines = change.after.kind === 'text' && !change.after.deleted ? this.text(change.after.hash).split('\n') : [];
      let start = 0;
      while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
      let end = 0;
      while (end < oldLines.length - start && end < newLines.length - start && oldLines.at(-end - 1) === newLines.at(-end - 1)) end++;
      return { added: total.added + newLines.length - start - end, removed: total.removed + oldLines.length - start - end };
    }, { added: 0, removed: 0 });
    const activity: ActivityEntry = { id: randomUUID(), opId, revision: this.revision, time,
      actor, kind: input.kind, paths: [...new Set(changes.map(c => c.after.path))], files: clone(changes),
      ...counts, summary: `Simulation: ${input.kind}`, sessionId: this.sessionId };
    if ('fileId' in input && input.fileId && !activity.paths.length) {
      const file = this.files.get(input.fileId); if (file) activity.paths.push(file.path);
    }
    this.activity.unshift(activity);
    const event: ProjectEvent = { opId, revision: this.revision, time, actor, kind: input.kind,
      changes, metadata: clone(this.metadata), manifestHash: this.manifestHash(), activity: clone(activity), result };
    this.emit('state');
    return event;
  }

  query(query: StoreQuery): unknown {
    this.assertOpen();
    if (query.kind === 'metadata') return clone(this.metadata);
    if (query.kind === 'activity') {
      const search = query.search?.toLocaleLowerCase();
      return clone(this.activity.filter(entry =>
        (!search || `${entry.summary} ${entry.paths.join(' ')} ${entry.actor.name}`.toLocaleLowerCase().includes(search)) &&
        (!query.fileId || entry.files.some(change => change.after.id === query.fileId)) &&
        (!query.actorId || entry.actor.id === query.actorId) &&
        (!query.source || entry.actor.source.kind === query.source || entry.actor.source.tool === query.source)
      ).slice(0, Math.max(0, Math.min(query.limit ?? 200, 1000))));
    }
    if (query.kind === 'preview-delete') {
      const file = this.requireFile(query.fileId);
      return this.impact(this.descendants(file).map(before => ({ before: clone(before),
        after: { ...clone(before), deleted: true, generation: before.generation + 1 } })));
    }
    if (query.kind === 'preview-checkpoint') return this.previewCheckpoint(query.checkpointId, query.fileIds);
    return clone(this.metadata[query.kind]);
  }

  readBlob(hash: string): { data: string } { this.assertOpen(); return { data: this.blob(hash) }; }

  setWatching(enabled: boolean): void {
    this.assertOpen(); this.watching = enabled; this.emit('state');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.watching = false; this.selected = null;
    this.files.clear(); this.blobs.clear(); this.activity = [];
    this.metadata = { claims: [], conflicts: [], checkpoints: [], trash: [], ignorePatterns: [], retentionDays: 30, strictClaims: false };
    this.removeAllListeners();
  }

  private apply(input: CommandInput): Record<string, unknown> {
    switch (input.kind) {
      case 'create': {
        this.validatePath(input.path);
        this.ensureAvailable(input.path);
        const file = this.makeFile(input.path, input.nodeKind, this.decode(input.data ?? ''));
        this.files.set(file.id, file);
        return { fileId: file.id };
      }
      case 'text': {
        const file = this.requireFile(input.fileId);
        this.checkGeneration(file, input.generation);
        if (file.kind !== 'text') fail('BINARY_FILE', 'Only text files support collaborative editing.');
        const doc = new Y.Doc();
        try {
          doc.getText('content'); Y.applyUpdate(doc, Buffer.from(this.blob(file.stateHash!), 'base64'));
          Y.applyUpdate(doc, this.decode(input.update, MAX_UPDATE_BYTES));
          const text = doc.getText('content').toString();
          this.validateText(Buffer.from(text));
          if (file.lineEnding === 'lf' && text.includes('\r')) fail('LINE_ENDING_MISMATCH', 'Keep this file in LF format.');
          if (file.lineEnding === 'crlf' && /(^|[^\r])\n|\r(?!\n)/.test(text)) fail('LINE_ENDING_MISMATCH', 'Keep this file in CRLF format.');
          this.files.set(file.id, { ...file, hash: this.put(Buffer.from(text)), size: Buffer.byteLength(text),
            stateHash: this.put(Y.encodeStateAsUpdate(doc)) });
        } catch (error) {
          if (error instanceof Error && 'code' in error) throw error;
          fail('INVALID_UPDATE', 'The simulation could not apply this document update.');
        } finally { doc.destroy(); }
        return { fileId: file.id };
      }
      case 'write': {
        const file = this.requireFile(input.fileId); this.checkGeneration(file, input.generation);
        if (file.revision !== input.baseRevision || file.hash !== input.baseHash) fail('STALE_REVISION', 'The file changed. Review it again.');
        this.files.set(file.id, this.makeFile(file.path, file.kind, this.decode(input.data), file));
        return { fileId: file.id };
      }
      case 'move': {
        const file = this.requireFile(input.fileId); this.checkPreview(input.expectedRevision);
        if (file.revision !== input.baseRevision) fail('STALE_REVISION', 'The file changed. Review it again.');
        this.validatePath(input.path);
        if (file.kind === 'directory' && input.path.startsWith(`${file.path}/`)) fail('INVALID_PATH', 'A folder cannot be moved inside itself.');
        const moving = this.descendants(file); const ids = new Set(moving.map(f => f.id));
        const changes = moving.map(f => ({ ...f, path: input.path + f.path.slice(file.path.length) }));
        for (const next of changes) this.ensureAvailable(next.path, ids);
        for (const next of changes) this.files.set(next.id, next);
        return { fileId: file.id };
      }
      case 'delete': {
        const file = this.requireFile(input.fileId); this.checkPreview(input.expectedRevision);
        if (file.revision !== input.baseRevision) fail('STALE_REVISION', 'The file changed. Review it again.');
        const deletedAt = Date.now();
        for (const next of this.descendants(file)) this.deleteFile(next, deletedAt);
        return { fileId: file.id };
      }
      case 'claim-create': {
        const file = this.requireFile(input.fileId);
        const now = Date.now(); const id = randomUUID();
        if (!input.description.trim()) fail('INVALID_COMMAND', 'Describe the work before creating a claim.');
        if (this.metadata.claims.some(c => c.fileId === file.id && c.status === 'active' && c.expiresAt > now &&
          (input.strict || c.strict || this.metadata.strictClaims))) fail('FILE_CLAIMED', 'An active claim already covers this file.');
        this.metadata.claims.unshift({ id, fileId: file.id, ownerId: this.actor.id, ownerName: this.actor.name,
          description: input.description, source: clone(input.source ?? { kind: 'app' }), baseRevision: file.revision,
          baseHash: file.hash, generation: file.generation, strict: input.strict, external: input.external,
          createdAt: now, expiresAt: now + Math.max(1000, Math.min(input.ttlMs ?? 900_000, 3_600_000)), status: 'active' });
        return { claimId: id };
      }
      case 'claim-renew': case 'claim-complete': case 'claim-cancel': {
        const claim = this.metadata.claims.find(c => c.id === input.claimId) ?? fail('NOT_FOUND', 'This claim no longer exists.');
        if (claim.status !== 'active') fail('CLAIM_INACTIVE', 'This claim has finished.');
        if (claim.ownerId !== this.actor.id && input.kind !== 'claim-cancel') fail('PERMISSION_DENIED', 'Only the claim author may complete or renew it.');
        if (input.kind === 'claim-renew') claim.expiresAt = Date.now() + 900_000;
        else claim.status = input.kind === 'claim-complete' ? 'completed' : 'cancelled';
        return { claimId: claim.id, status: claim.status };
      }
      case 'claim-expire': {
        const expired = this.metadata.claims.filter(c => c.status === 'active' && c.expiresAt <= Date.now());
        for (const claim of expired) claim.status = 'expired';
        return { expired: expired.map(c => c.id) };
      }
      case 'checkpoint-create': {
        if (!input.name.trim()) fail('INVALID_COMMAND', 'Give the checkpoint a name.');
        const checkpoint = this.checkpoint(input.name.trim()); return { checkpointId: checkpoint.id };
      }
      case 'checkpoint-delete': {
        this.checkPreview(input.expectedRevision); this.requireCheckpoint(input.checkpointId);
        this.metadata.checkpoints = this.metadata.checkpoints.filter(c => c.id !== input.checkpointId);
        return { checkpointId: input.checkpointId };
      }
      case 'checkpoint-restore': {
        this.checkPreview(input.expectedRevision);
        const checkpoint = this.requireCheckpoint(input.checkpointId);
        const preview = this.previewCheckpoint(input.checkpointId, input.fileIds);
        const protective = this.checkpoint(`Before restoring ${checkpoint.name}`, true);
        for (const change of preview.files) {
          if (change.after.deleted) { if (change.before) this.deleteFile(change.before); }
          else {
            const after = change.after;
            this.files.set(after.id, this.makeFile(after.path, after.kind, Buffer.from(this.blob(after.hash), 'base64'),
              { ...after, generation: this.files.get(after.id)?.generation ?? 0 }));
          }
        }
        this.validateTree();
        return { checkpointId: checkpoint.id, protectiveCheckpointId: protective.id,
          creates: preview.creates, updates: preview.updates, deletes: preview.deletes };
      }
      case 'trash-restore': {
        this.checkPreview(input.expectedRevision);
        const entry = this.metadata.trash.find(t => t.id === input.trashId) ?? fail('NOT_FOUND', 'This deleted item no longer exists.');
        const entries = this.metadata.trash.filter(t => t.id === entry.id ||
          entry.kind === 'directory' && t.path.startsWith(`${entry.path}/`) && t.deletedAt === entry.deletedAt);
        for (const item of entries) {
          this.ensureAvailable(item.path);
          this.files.set(item.fileId, this.makeFile(item.path, item.kind, Buffer.from(this.blob(item.file.hash), 'base64'),
            { ...item.file, generation: this.files.get(item.fileId)?.generation ?? item.generation }));
        }
        const restored = new Set(entries.map(t => t.id));
        this.metadata.trash = this.metadata.trash.filter(t => !restored.has(t.id));
        return { fileId: entry.fileId };
      }
      case 'trash-purge': {
        this.checkPreview(input.expectedRevision);
        for (const id of input.trashIds) if (!this.metadata.trash.some(t => t.id === id)) fail('NOT_FOUND', 'This deleted item no longer exists.');
        this.metadata.trash = this.metadata.trash.filter(t => !input.trashIds.includes(t.id));
        return { purged: input.trashIds, checkpointsPreserved: true };
      }
      case 'conflict-create': {
        this.validatePath(input.path);
        for (const hash of [input.baseHash, input.remoteHash]) if (hash) this.blob(hash);
        const file = input.fileId ? this.files.get(input.fileId) : this.findPath(input.path);
        const conflict: ConflictEntry = { id: randomUUID(), fileId: file?.id ?? input.fileId, path: input.path,
          reason: input.reason, generation: file?.generation ?? input.generation, revision: file?.revision ?? input.revision,
          baseHash: input.baseHash, localHash: input.localData === null ? null : this.put(this.decode(input.localData)),
          remoteHash: input.remoteHash, actorId: this.actor.id, createdAt: Date.now(), status: 'open' };
        this.metadata.conflicts.unshift(conflict); return { conflictId: conflict.id };
      }
      case 'conflict-resolve': return this.resolveConflict(input);
      case 'settings': {
        if (input.retentionDays !== undefined && (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365)) fail('INVALID_COMMAND', 'Retention must be between 1 and 365 days.');
        if (input.ignorePatterns) this.metadata.ignorePatterns = [...input.ignorePatterns];
        if (input.retentionDays !== undefined) this.metadata.retentionDays = input.retentionDays;
        if (input.strictClaims !== undefined) this.metadata.strictClaims = input.strictClaims;
        return { simulationOnly: true };
      }
      case 'rescan': return { simulationOnly: true, scannedFiles: this.activeFiles().length };
    }
  }

  private resolveConflict(input: Extract<CommandInput, { kind: 'conflict-resolve' }>): Record<string, unknown> {
    const conflict = this.metadata.conflicts.find(c => c.id === input.conflictId) ?? fail('NOT_FOUND', 'This conflict no longer exists.');
    if (conflict.status !== 'open') fail('CONFLICT_RESOLVED', 'This conflict has already been resolved.');
    const file = conflict.fileId ? this.files.get(conflict.fileId) : this.findPath(conflict.path);
    if ((file?.revision ?? 0) !== input.expectedRevision) fail('STALE_REVISION', 'The file changed. Review it again.');
    let copy: ProjectFile | undefined;
    if (input.choice === 'both') {
      if (!file || file.deleted || !conflict.localHash) fail('INVALID_COMMAND', 'Both versions must exist to keep separate copies.');
      const dot = file.path.lastIndexOf('.'); const split = dot > file.path.lastIndexOf('/') + 1 ? dot : file.path.length;
      let path = ''; let suffix = 1;
      do { path = `${file.path.slice(0, split)}.local-${suffix++}${file.path.slice(split)}`; } while (this.findPath(path));
      copy = this.makeFile(path, file.kind, Buffer.from(this.blob(conflict.localHash), 'base64'));
      this.files.set(copy.id, copy);
    } else if (input.choice !== 'remote') {
      if (input.choice === 'merged' && (file?.kind === 'binary' || input.data === undefined)) fail('BINARY_MERGE', 'A text merge needs text content.');
      const bytes = input.choice === 'merged' ? this.decode(input.data!) :
        conflict.localHash ? Buffer.from(this.blob(conflict.localHash), 'base64') : null;
      if (bytes === null) { if (file && !file.deleted) this.deleteFile(file); }
      else {
        if (!file || file.deleted) this.ensureAvailable(conflict.path);
        const next = this.makeFile(file?.path ?? conflict.path, file?.kind ?? 'text', bytes, file);
        this.files.set(next.id, next);
      }
    }
    conflict.status = 'resolved'; conflict.resolution = input.choice;
    return { conflictId: conflict.id, ...(copy ? { copyFileId: copy.id, copyPath: copy.path } : {}) };
  }

  private previewCheckpoint(id: string, fileIds?: string[]): ImpactPreview {
    const checkpoint = this.requireCheckpoint(id);
    const target = new Map(checkpoint.files.map(file => [file.id, file]));
    const selected = fileIds ? new Set(fileIds) : null;
    const changes: FileChange[] = [];
    for (const fileId of new Set([...this.files.keys(), ...target.keys()])) {
      if (selected && !selected.has(fileId)) continue;
      const current = this.files.get(fileId); const after = target.get(fileId);
      if (!after && current && !current.deleted) changes.push({ before: clone(current), after: { ...clone(current), deleted: true } });
      else if (after && (!current || current.deleted || current.path !== after.path || current.hash !== after.hash || current.kind !== after.kind))
        changes.push({ before: current ? clone(current) : null, after: clone(after) });
    }
    return this.impact(changes);
  }

  private impact(files: FileChange[]): ImpactPreview {
    return { revision: this.revision, paths: [...new Set(files.map(f => f.after.path))], files,
      creates: files.filter(f => !f.after.deleted && (!f.before || f.before.deleted)).length,
      updates: files.filter(f => !f.after.deleted && f.before && !f.before.deleted).length,
      deletes: files.filter(f => f.after.deleted && f.before && !f.before.deleted).length,
      bytes: files.filter(f => !f.after.deleted).reduce((total, file) => total + file.after.size, 0) };
  }

  private checkpoint(name: string, protectedCheckpoint = false): Checkpoint {
    const checkpoint: Checkpoint = { id: randomUUID(), name, protected: protectedCheckpoint,
      createdAt: Date.now(), revision: this.revision, actorName: this.actor.name, files: this.activeFiles() };
    this.metadata.checkpoints.unshift(checkpoint); return checkpoint;
  }

  private deleteFile(file: ProjectFile, deletedAt = Date.now()): void {
    this.metadata.trash.unshift({ id: randomUUID(), fileId: file.id, path: file.path, kind: file.kind,
      size: file.size, deletedAt, actorName: this.actor.name, generation: file.generation, file: clone(file) });
    this.files.set(file.id, { ...file, deleted: true, generation: file.generation + 1 });
  }

  private makeFile(path: string, kind: FileKind, bytes: Uint8Array, previous?: ProjectFile): ProjectFile {
    const data = kind === 'directory' ? Buffer.alloc(0) : Buffer.from(bytes);
    const file: ProjectFile = { id: previous?.id ?? randomUUID(), path, kind, generation: (previous?.generation ?? 0) + 1,
      revision: this.revision + 1, hash: this.put(data), size: data.length, stateHash: null, lineEnding: null, deleted: false };
    if (kind === 'text') {
      const text = this.validateText(data); const doc = new Y.Doc();
      try { doc.getText('content').insert(0, text); file.stateHash = this.put(Y.encodeStateAsUpdate(doc)); }
      finally { doc.destroy(); }
      file.lineEnding = text.includes('\r\n') ? 'crlf' : 'lf';
    }
    return file;
  }

  private seed(): void {
    const add = (path: string, text: string, source?: ChangeSource) => this.command({ kind: 'create', path, nodeKind: 'text', data: Buffer.from(text).toString('base64'), source });
    add('README.md', '# Trail Notes — Hackathon Demo\n\nBuild a tiny shared trail journal with Mina and Jun.\n\nThis entire project is a simulation kept only in memory.\nTry editing a file, resolving the conflict, restoring a checkpoint, or recovering a deleted file.\nExit and restart the simulation to reset everything.\n');
    add('package.json', '{\n  "name": "trail-notes-demo",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n');
    this.command({ kind: 'create', path: 'src', nodeKind: 'directory' });
    add('src/App.tsx', 'export default function App() {\n  return (\n    <main>\n      <h1>Trail Notes</h1>\n      <p>Plan a small adventure together.</p>\n      <button>Start a trail</button>\n    </main>\n  );\n}\n');
    add('src/theme.css', ':root {\n  color: #e9f1ec;\n  background: #13241d;\n  font-family: system-ui, sans-serif;\n}\n\nbutton { padding: 12px 20px; border-radius: 12px; }\n', { kind: 'declared-ai', tool: 'Codex (declared simulation)' });
    add('demo-notes.md', '# Demo checklist\n\n- Add the trail map\n- Review the empty state\n- Practice a safe restore\n');
    this.command({ kind: 'checkpoint-create', name: 'Before the demo polish' });
    const notes = this.findPath('demo-notes.md')!;
    this.command({ kind: 'delete', fileId: notes.id, baseRevision: notes.revision, expectedRevision: this.revision });
    const app = this.findPath('src/App.tsx')!;
    this.command({ kind: 'conflict-create', fileId: app.id, path: app.path,
      reason: 'Simulated external save: two teammates changed the welcome message.',
      generation: app.generation, revision: app.revision, baseHash: app.hash, remoteHash: app.hash,
      localData: Buffer.from(this.text(app.hash).replace('Plan a small adventure together.', 'Every great trail starts with a shared note.')).toString('base64'),
      source: { kind: 'external', tool: 'VS Code (Simulation)' } });
    const theme = this.findPath('src/theme.css')!;
    this.metadata.claims.push({ id: randomUUID(), fileId: theme.id, ownerId: 'simulation-mina', ownerName: 'Mina (Simulation)',
      description: 'Polish the trail palette with declared AI assistance', source: { kind: 'declared-ai', tool: 'Codex (declared simulation)' },
      baseRevision: theme.revision, baseHash: theme.hash, generation: theme.generation, strict: false, external: true,
      createdAt: Date.now() - 120_000, expiresAt: Date.now() + 900_000, status: 'active' });
    for (let index = 0; index < this.activity.length; index++) {
      const entry = this.activity[index]!;
      entry.time = Date.now() - (index + 1) * 60_000;
      if (entry.actor.source.kind === 'declared-ai') entry.actor = { ...entry.actor, id: 'simulation-mina', name: 'Mina (Simulation)', role: 'editor' };
    }
    this.selected = this.findPath('README.md')!.id;
  }

  private assertOpen(): void { if (this.closed) fail('SIMULATION_CLOSED', 'This simulation has ended. Start a new session to reset it.'); }
  private activeFiles(): ProjectFile[] { return clone([...this.files.values()].filter(f => !f.deleted).sort((a, b) => a.path.localeCompare(b.path))); }
  private findPath(path: string): ProjectFile | undefined { return [...this.files.values()].find(f => !f.deleted && f.path.toLocaleLowerCase() === path.toLocaleLowerCase()); }
  private requireFile(id: string): ProjectFile { const file = this.files.get(id); return file && !file.deleted ? file : fail('FILE_NOT_FOUND', 'This simulation file no longer exists.'); }
  private requireCheckpoint(id: string): Checkpoint { return this.metadata.checkpoints.find(c => c.id === id) ?? fail('NOT_FOUND', 'This checkpoint no longer exists.'); }
  private blob(hash: string): string { return this.blobs.get(hash) ?? fail('BLOB_NOT_FOUND', 'This content is not part of the current simulation.'); }
  private text(hash: string): string { return Buffer.from(this.blob(hash), 'base64').toString('utf8'); }
  private put(bytes: Uint8Array): string { const hash = digest(bytes); this.blobs.set(hash, Buffer.from(bytes).toString('base64')); return hash; }
  private manifestHash(): string { return digest(JSON.stringify(this.activeFiles())); }
  private checkGeneration(file: ProjectFile, generation: number): void { if (file.generation !== generation) fail('STALE_GENERATION', 'This editor belongs to an earlier version. Reopen the file.'); }
  private checkPreview(revision?: number): void { if (revision !== undefined && revision !== this.revision) fail('STALE_PREVIEW', 'The project changed. Review the action again.'); }
  private descendants(file: ProjectFile): ProjectFile[] { return [...this.files.values()].filter(f => !f.deleted && (f.id === file.id || file.kind === 'directory' && f.path.startsWith(`${file.path}/`))); }
  private validatePath(path: string): void {
    if (!path || path.length > 1024 || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_PATH', 'Use a relative project path with forward slashes.');
    if (path.split('/').some(p => ['.git', '.cairn', 'node_modules'].includes(p.toLocaleLowerCase()) || p === '.env' || p.startsWith('.env.'))) fail('EXCLUDED_PATH', 'This path is excluded from sharing.');
  }
  private ensureAvailable(path: string, ignored = new Set<string>()): void {
    for (const file of this.files.values()) {
      if (file.deleted || ignored.has(file.id)) continue;
      const existing = file.path.toLocaleLowerCase(); const target = path.toLocaleLowerCase();
      if (existing === target || file.kind !== 'directory' && target.startsWith(`${existing}/`)) fail('PATH_EXISTS', 'A file already occupies this path.');
    }
  }
  private validateTree(): void {
    for (const file of this.files.values()) if (!file.deleted) this.ensureAvailable(file.path, new Set([file.id]));
  }
  private decode(data: string, max = MAX_UPDATE_BYTES): Buffer {
    if (data.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail('INVALID_DATA', 'The content is invalid or too large.');
    const bytes = Buffer.from(data, 'base64'); if (bytes.length > max) fail('INVALID_DATA', 'The content is too large.'); return bytes;
  }
  private validateText(bytes: Uint8Array): string {
    if (bytes.length > MAX_TEXT_BYTES) fail('TEXT_TOO_LARGE', 'Text files are limited to 1 MiB.');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) fail('BINARY_FILE', 'This file contains binary content.');
      return text;
    } catch (error) { if (error instanceof Error && 'code' in error) throw error; return fail('INVALID_TEXT', 'Text files must contain valid UTF-8.'); }
  }
}
