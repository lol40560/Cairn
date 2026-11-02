import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CairnError, unb64 } from '../common.js';
import { MAX_UPDATE_BYTES } from '../../shared/types.js';
import { classifyBytes, MAX_BLOB_BYTES, ProjectPolicy } from './filesystem.js';
import type { ProjectStore } from './store.js';
import type {
  Actor, Checkpoint, Claim, ConflictEntry, FileChange, ImpactPreview, ProjectCommand,
  ProjectFile, SharedMetadata, TrashEntry,
} from '../../shared/project.js';

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 5000;
const MAX_CHECKPOINTS = 64;
const DEFAULT_TTL = 30 * 60 * 1000;
const MIN_TTL = 1000;
const MAX_TTL = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const system: Actor = { id: 'system', name: 'Cairn', role: 'owner', source: { kind: 'system' } };
type Settings = Pick<SharedMetadata, 'ignorePatterns' | 'retentionDays' | 'strictClaims'>;
type Table = 'recovery_claims' | 'recovery_conflicts' | 'recovery_checkpoints' | 'recovery_trash';
type Excluded = { path: string; reason: string };
type RestorePreview = ImpactPreview & { checkpointId: string; excluded: Excluded[]; unchanged: number };

function fail(code: string, message: string): never { throw new CairnError(code, message); }
function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_COMMAND', `${name} is invalid.`);
}
function label(value: string, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    fail('INVALID_COMMAND', `${name} is empty or exceeds its supported limit.`);
  return value.trim();
}
function fold(value: string): string { return value.toUpperCase().toLowerCase().normalize('NFC'); }
function active(claim: Claim, now = Date.now()): boolean { return claim.status === 'active' && claim.expiresAt > now; }
function sameVersion(a: ProjectFile, b: ProjectFile): boolean {
  return !a.deleted && a.path === b.path && a.kind === b.kind && a.hash === b.hash && a.lineEnding === b.lineEnding;
}

/** All command callbacks run inside ProjectStore.apply's transaction. This module
 * only changes SQLite rows and stages projections; the store commits and writes disk. */
export class RecoveryService {
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly store: ProjectStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_claims(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL, ttl_ms INTEGER NOT NULL DEFAULT 1800000);
      CREATE TABLE IF NOT EXISTS recovery_conflicts(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL, resolved_before TEXT);
      CREATE TABLE IF NOT EXISTS recovery_checkpoints(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_trash(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    `);
    store.db.prepare('INSERT OR IGNORE INTO recovery_settings(id,data) VALUES(1,?)').run(JSON.stringify({ ignorePatterns: [], retentionDays: 30, strictClaims: false } satisfies Settings));
    const kinds = ['claim-create', 'claim-renew', 'claim-complete', 'claim-cancel', 'claim-expire', 'conflict-create', 'conflict-resolve', 'checkpoint-create', 'checkpoint-delete', 'checkpoint-restore', 'trash-restore', 'trash-purge', 'settings'] as const;
    for (const kind of kinds) store.registerCommand(kind, (command, actor) => {
      if (actor.role === 'viewer') fail('PERMISSION_DENIED', 'Viewers cannot change project recovery records.');
      const result = this.handle(command, actor);
      this.checkBounds();
      return result;
    });
    store.setDeleteObserver((files, actor) => this.recordTrash(files, actor));
    store.setWriteGuard((fileId, actor, command) => this.guard(fileId, actor, command));
    store.setProjectionHold((fileId) => this.rows<Claim>('recovery_claims').some((claim) =>
      claim.fileId === fileId && claim.ownerId === store.ownerId && claim.external && active(claim)));
    store.setMetadataProvider(() => this.metadata());
    store.setMetadataInstaller((metadata) => this.installMetadata(metadata));
    for (const kind of ['claims', 'conflicts', 'checkpoints', 'trash', 'metadata'] as const)
      store.registerQuery(kind, () => kind === 'metadata' ? this.metadata() : this.metadata()[kind]);
    store.registerQuery('preview-checkpoint', (query) => {
      if (query.kind !== 'preview-checkpoint') fail('INVALID_QUERY', 'A checkpoint preview is required.');
      return this.previewCheckpoint(query.checkpointId, query.fileIds);
    });
    // Reads never change expiry state. Due expiry is a distinct durable system event.
    if (store.mode === 'authority') {
      this.timer = setInterval(() => {
        try {
          const now = Date.now();
          const dueClaim = this.rows<Claim>('recovery_claims').some((claim) => claim.status === 'active' && claim.expiresAt <= now);
          const dueTrash = this.rows<TrashEntry>('recovery_trash').some((entry) => entry.deletedAt <= now - this.settings().retentionDays * DAY);
          if (dueClaim || dueTrash) store.apply({ opId: randomUUID(), kind: 'claim-expire' }, system);
        }
        catch { /* A failed transaction is retried without discarding the claim. */ }
      }, 1000);
      this.timer.unref();
    }
    store.once('close', () => this.close());
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private rows<T>(table: Table): T[] {
    return (this.store.db.prepare(`SELECT data FROM ${table} ORDER BY created_at DESC,id`).all() as { data: string }[]).map((row) => JSON.parse(row.data) as T);
  }
  private row<T>(table: Table, id: string): T {
    label(id, 'Record identity', 200);
    const row = this.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    if (!row) fail('NOT_FOUND', 'The recovery record no longer exists.');
    return JSON.parse(row.data) as T;
  }
  private save(table: Table, value: { id: string }, time: number): void {
    this.store.db.prepare(`INSERT INTO ${table}(id,created_at,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, time, JSON.stringify(value));
  }
  private settings(): Settings {
    return JSON.parse((this.store.db.prepare('SELECT data FROM recovery_settings WHERE id=1').get() as { data: string }).data) as Settings;
  }
  private policy(): ProjectPolicy { return this.store.configurePolicy(new ProjectPolicy(this.store.root, this.settings().ignorePatterns)); }
  private allowed(file: Pick<ProjectFile, 'path' | 'kind'>, policy = this.policy()): boolean { return policy.check(file.path, file.kind === 'directory').allowed; }
  private requirePath(file: Pick<ProjectFile, 'path' | 'kind'>): void {
    const check = this.policy().check(file.path, file.kind === 'directory');
    if (!check.allowed) fail('EXCLUDED_PATH', check.reason ?? 'This path is excluded from sharing.');
  }
  private requireOwner(actor: Actor): void {
    if (actor.role !== 'owner') fail('PERMISSION_DENIED', 'Only the project owner can perform this action.');
  }
  private expectedRevision(expected: number): void {
    integer(expected, 'Expected project version');
    if (expected !== this.store.revision()) fail('STALE_REVISION', 'The project changed after the preview. Review the current changes and try again.');
  }
  private requireBlob(hash: string | null): void {
    if (hash !== null && (!/^[a-f0-9]{64}$/.test(hash) || !this.store.hasBlob(hash))) fail('MISSING_BLOB', 'A preserved version is unavailable.');
  }
  private checkBounds(): void {
    for (const table of ['recovery_claims', 'recovery_conflicts', 'recovery_trash', 'recovery_checkpoints'] as Table[]) {
      const count = Number((this.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      if (count > (table === 'recovery_checkpoints' ? MAX_CHECKPOINTS : MAX_RECORDS)) fail('RECOVERY_LIMIT', 'The recovery record limit was reached. Remove unneeded records before continuing.');
    }
    const size = ['recovery_claims', 'recovery_conflicts', 'recovery_trash', 'recovery_checkpoints'].reduce((sum, table) =>
      sum + Number((this.store.db.prepare(`SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS n FROM ${table}`).get() as { n: number }).n), 0);
    if (size > MAX_METADATA_BYTES) fail('RECOVERY_LIMIT', 'The recovery metadata limit was reached. Remove unneeded checkpoints before continuing.');
  }

  /** Ignored originals remain in SQLite, but their recovery blobs are not shared. */
  metadata(): SharedMetadata {
    const settings = this.settings(), policy = this.store.configurePolicy(new ProjectPolicy(this.store.root, settings.ignorePatterns));
    const files = new Map(this.store.files(true).map((file) => [file.id, file]));
    // Historical versions often share a path. Reuse a safety decision only for
    // this synchronous read; the next call always rechecks the filesystem and
    // canonical ignore rules. Policy distinguishes directories from files.
    const pathChecks = new Map<string, boolean>();
    const allowed = (file: Pick<ProjectFile, 'path' | 'kind'>): boolean => {
      const directory = file.kind === 'directory', key = `${directory ? 'directory' : 'file'}:${file.path}`;
      const cached = pathChecks.get(key);
      if (cached !== undefined) return cached;
      const result = policy.check(file.path, directory).allowed;
      pathChecks.set(key, result);
      return result;
    };
    return {
      ...settings,
      claims: this.rows<Claim>('recovery_claims').filter((claim) => { const file = files.get(claim.fileId); return file && allowed(file); }),
      conflicts: this.rows<ConflictEntry>('recovery_conflicts').flatMap((conflict) => {
        const localTarget = conflict.fileId ? files.get(conflict.fileId) : [...files.values()].find((file) => fold(file.path) === fold(conflict.path));
        // Snapshot catalogs omit tombstones. The authority's current target in
        // metadata still carries the reviewed deletion revision for resolve CAS.
        const current = localTarget ?? (this.store.mode === 'replica' ? conflict.current : undefined);
        return allowed({ path: conflict.path, kind: 'binary' }) && (!current || allowed(current)) ? [{ ...conflict, current: current ?? null }] : [];
      }),
      checkpoints: this.rows<Checkpoint>('recovery_checkpoints').map((checkpoint) => ({ ...checkpoint, files: checkpoint.files.filter(allowed) })),
      trash: this.rows<TrashEntry>('recovery_trash').filter((entry) => allowed(entry.file)),
    };
  }

  /** Called by store snapshot/event ingestion inside that transaction. It owns
   * only canonical metadata; replica-local conflicts and outbox are independent. */
  installMetadata(metadata: SharedMetadata): void {
    if (!metadata || Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) fail('RECOVERY_LIMIT', 'Incoming recovery metadata exceeds the supported limit.');
    this.validateSettings(metadata);
    const tables: [Table, { id: string }[], string][] = [
      ['recovery_claims', metadata.claims, 'createdAt'], ['recovery_conflicts', metadata.conflicts, 'createdAt'],
      ['recovery_checkpoints', metadata.checkpoints, 'createdAt'], ['recovery_trash', metadata.trash, 'deletedAt'],
    ];
    for (const [table, records, timeKey] of tables) {
      if (!Array.isArray(records) || records.length > (table === 'recovery_checkpoints' ? MAX_CHECKPOINTS : MAX_RECORDS)) fail('RECOVERY_LIMIT', 'Incoming recovery records exceed the supported limit.');
      const ids = new Set<string>();
      for (const record of records) {
        label(record.id, 'Recovery identity', 200);
        if (ids.has(record.id)) fail('INVALID_METADATA', 'Duplicate recovery identities were received.');
        ids.add(record.id);
        integer((record as unknown as Record<string, number>)[timeKey], 'Recovery timestamp');
      }
    }
    for (const checkpoint of metadata.checkpoints) {
      if (!Array.isArray(checkpoint.files) || checkpoint.files.length > MAX_RECORDS) fail('RECOVERY_LIMIT', 'The checkpoint contains too many files.');
      for (const file of checkpoint.files) this.validateVersion(file);
    }
    for (const entry of metadata.trash) this.validateVersion(entry.file);
    for (const conflict of metadata.conflicts) {
      this.requireBlob(conflict.baseHash); this.requireBlob(conflict.localHash); this.requireBlob(conflict.remoteHash);
      if (conflict.localStateHash) this.requireBlob(conflict.localStateHash);
    }
    for (const [table, records, timeKey] of tables) {
      this.store.db.exec(`DELETE FROM ${table}`);
      for (const record of records) this.save(table, record, (record as unknown as Record<string, number>)[timeKey]);
    }
    this.store.db.prepare('UPDATE recovery_settings SET data=? WHERE id=1').run(JSON.stringify({ ignorePatterns: metadata.ignorePatterns, strictClaims: metadata.strictClaims, retentionDays: metadata.retentionDays } satisfies Settings));
    this.checkBounds();
  }

  private validateVersion(file: ProjectFile): void {
    if (!file || !['text', 'binary', 'directory'].includes(file.kind)) fail('INVALID_METADATA', 'A preserved file record is invalid.');
    label(file.id, 'File identity', 200); label(file.path, 'File path', 1024);
    integer(file.generation, 'File generation', 1); integer(file.revision, 'File version'); integer(file.size, 'File size');
    if (file.kind !== 'directory') { this.requireBlob(file.hash); if (this.store.blobSize(file.hash) !== file.size) fail('INVALID_METADATA', 'A preserved file size does not match its content.'); }
    if (file.kind === 'text') { if (!file.stateHash) fail('INVALID_METADATA', 'A text version is missing its document state.'); this.requireBlob(file.stateHash); }
  }

  private validateSettings(settings: Settings): void {
    if (typeof settings.strictClaims !== 'boolean') fail('INVALID_SETTINGS', 'Strict claims must be enabled or disabled.');
    integer(settings.retentionDays, 'Trash retention', 1);
    if (settings.retentionDays > 3650) fail('INVALID_SETTINGS', 'Trash retention must be between 1 and 3650 days.');
    this.store.configurePolicy(new ProjectPolicy(this.store.root, settings.ignorePatterns));
  }

  private guard(fileId: string, actor: Actor, _command: ProjectCommand): void {
    const strict = this.settings().strictClaims;
    const conflict = this.rows<Claim>('recovery_claims').find((claim) => claim.fileId === fileId && claim.ownerId !== actor.id && active(claim) && (strict || claim.strict));
    if (conflict) fail('FILE_CLAIMED', `This file is being edited by ${conflict.ownerName}. Wait for the claim to finish or ask the owner to cancel it.`);
  }

  private handle(command: ProjectCommand, actor: Actor): Record<string, unknown> {
    switch (command.kind) {
      case 'claim-create': {
        const file = this.store.file(command.fileId);
        if (!file || file.deleted || file.kind === 'directory') fail('NOT_FOUND', 'Choose a current file to claim.');
        this.requirePath(file);
        if (typeof command.strict !== 'boolean' || typeof command.external !== 'boolean') fail('INVALID_COMMAND', 'The claim settings are invalid.');
        const now = Date.now(), ttl = command.ttlMs ?? DEFAULT_TTL;
        integer(ttl, 'Claim duration', MIN_TTL);
        if (ttl > MAX_TTL) fail('INVALID_COMMAND', 'A claim cannot last longer than one day without renewal.');
        const existing = this.rows<Claim>('recovery_claims').filter((claim) => claim.fileId === file.id && active(claim, now));
        if (existing.some((claim) => claim.ownerId === actor.id)) fail('CLAIM_EXISTS', 'Renew or finish your current claim first.');
        if (existing.some((claim) => claim.strict || command.strict || this.settings().strictClaims)) fail('FILE_CLAIMED', 'An active claim already covers this file.');
        const claim: Claim = { id: randomUUID(), fileId: file.id, ownerId: actor.id, ownerName: actor.name,
          description: label(command.description, 'Claim description', 500), source: actor.source,
          baseRevision: file.revision, baseHash: file.hash, generation: file.generation, strict: command.strict,
          external: command.external, createdAt: now, expiresAt: now + ttl, status: 'active' };
        if (claim.external && actor.id === this.store.ownerId) this.store.adoptExternalBaseline(file.id);
        this.save('recovery_claims', claim, now);
        this.store.db.prepare('UPDATE recovery_claims SET ttl_ms=? WHERE id=?').run(ttl, claim.id);
        return { claimId: claim.id };
      }
      case 'claim-renew': case 'claim-complete': case 'claim-cancel': {
        const claim = this.row<Claim>('recovery_claims', command.claimId);
        if (claim.ownerId !== actor.id && !(command.kind === 'claim-cancel' && actor.role === 'owner')) fail('PERMISSION_DENIED', 'Only the claim author can renew or complete this claim.');
        if (!active(claim)) fail('CLAIM_INACTIVE', 'This claim has already finished or expired.');
        if (command.kind === 'claim-renew') {
          const ttl = (this.store.db.prepare('SELECT ttl_ms FROM recovery_claims WHERE id=?').get(claim.id) as { ttl_ms: number }).ttl_ms;
          claim.expiresAt = Date.now() + ttl;
        }
        else claim.status = command.kind === 'claim-complete' ? 'completed' : 'cancelled';
        this.save('recovery_claims', claim, claim.createdAt);
        return { claimId: claim.id, status: claim.status };
      }
      case 'claim-expire': {
        if (actor.id !== 'system' || actor.source.kind !== 'system' || actor.role !== 'owner') fail('PERMISSION_DENIED', 'Claim expiry is an internal operation.');
        const now = Date.now(), expired: string[] = [];
        for (const claim of this.rows<Claim>('recovery_claims')) if (claim.status === 'active' && claim.expiresAt <= now) {
          claim.status = 'expired'; this.save('recovery_claims', claim, claim.createdAt); expired.push(claim.id);
        }
        return { expired, purgedTrash: this.expireTrash(now) };
      }
      case 'conflict-create': return this.createConflict(command, actor);
      case 'conflict-resolve': return this.resolveConflict(command, actor);
      case 'checkpoint-create': {
        const checkpoint = this.createCheckpoint(label(command.name, 'Checkpoint name', 160), actor, false);
        return { checkpointId: checkpoint.id, excluded: this.excludedCurrent() };
      }
      case 'checkpoint-delete': {
        this.requireOwner(actor); this.expectedRevision(command.expectedRevision);
        this.row<Checkpoint>('recovery_checkpoints', command.checkpointId);
        this.store.db.prepare('DELETE FROM recovery_checkpoints WHERE id=?').run(command.checkpointId);
        return { checkpointId: command.checkpointId, scope: 'checkpoint-only' };
      }
      case 'checkpoint-restore': {
        this.requireOwner(actor); this.expectedRevision(command.expectedRevision);
        const preview = this.previewCheckpoint(command.checkpointId, command.fileIds);
        const checkpoint = this.row<Checkpoint>('recovery_checkpoints', command.checkpointId);
        const protective = this.createCheckpoint(`Before restoring ${checkpoint.name}`, actor, true);
        this.applyRestore(preview.files, actor, command);
        return { checkpointId: checkpoint.id, protectiveCheckpointId: protective.id, excluded: preview.excluded, creates: preview.creates, updates: preview.updates, deletes: preview.deletes };
      }
      case 'trash-restore': return this.restoreTrash(command, actor);
      case 'trash-purge': {
        this.requireOwner(actor); this.expectedRevision(command.expectedRevision);
        if (!Array.isArray(command.trashIds) || !command.trashIds.length || command.trashIds.length > MAX_RECORDS) fail('INVALID_COMMAND', 'Select deleted entries to purge.');
        const ids = [...new Set(command.trashIds)];
        for (const id of ids) this.row<TrashEntry>('recovery_trash', id);
        for (const id of ids) this.store.db.prepare('DELETE FROM recovery_trash WHERE id=?').run(id);
        return { purged: ids, scope: 'trash-only', checkpointsPreserved: true };
      }
      case 'settings': return this.updateSettings(command, actor);
      default: return fail('INVALID_COMMAND', 'This is not a recovery command.');
    }
  }

  private createConflict(command: Extract<ProjectCommand, { kind: 'conflict-create' }>, actor: Actor): Record<string, unknown> {
    this.requirePath({ path: command.path, kind: 'binary' });
    integer(command.generation, 'Conflict generation'); integer(command.revision, 'Conflict version');
    this.requireBlob(command.baseHash); this.requireBlob(command.remoteHash);
    const target = command.fileId ? this.store.file(command.fileId) : this.store.files(true).find((file) => fold(file.path) === fold(command.path));
    if (target?.kind === 'directory') fail('UNSUPPORTED_CONFLICT', 'Directory conflicts need a file or folder operation.');
    const localHash = command.localData === null ? null : this.store.putBlob(unb64(command.localData, MAX_BLOB_BYTES));
    const localStateHash = command.localState === undefined ? null : this.store.putBlob(unb64(command.localState, MAX_UPDATE_BYTES));
    const reason = label(command.reason, 'Conflict reason', 1200);
    const conflict: ConflictEntry = { id: randomUUID(), fileId: target?.id ?? command.fileId, path: command.path,
      reason: target && target.generation !== command.generation ? `${reason} The local document belongs to an earlier generation.` : reason,
      generation: target?.generation ?? command.generation, revision: target?.revision ?? command.revision,
      baseHash: command.baseHash, localHash, remoteHash: command.remoteHash, localStateHash,
      actorId: actor.id, createdAt: Date.now(), status: 'open' };
    this.save('recovery_conflicts', conflict, conflict.createdAt);
    return { conflictId: conflict.id };
  }

  private resolveConflict(command: Extract<ProjectCommand, { kind: 'conflict-resolve' }>, actor: Actor): Record<string, unknown> {
    const conflict = this.row<ConflictEntry>('recovery_conflicts', command.conflictId);
    if (conflict.status !== 'open') fail('CONFLICT_RESOLVED', 'This conflict was already resolved.');
    const current = conflict.fileId ? this.store.file(conflict.fileId) : this.store.files(true).find((file) => fold(file.path) === fold(conflict.path));
    integer(command.expectedRevision, 'Expected file version');
    // Every generation change also advances this file's revision. Comparing the
    // reviewed current revision therefore covers generation CAS without making
    // an older preserved conflict permanently impossible to resolve.
    if ((current?.revision ?? 0) !== command.expectedRevision) fail('STALE_REVISION', 'The target file changed. Preserve this conflict and review the current file before resolving it.');
    if (current) this.guard(current.id, actor, command);
    this.requirePath({ path: current?.path ?? conflict.path, kind: current?.kind ?? 'binary' });
    let selected: string | null;
    if (command.choice === 'merged') {
      const hashes = [conflict.baseHash, conflict.localHash, conflict.remoteHash].filter((value): value is string => value !== null);
      if (current?.kind === 'binary' || hashes.some((hash) => classifyBytes(conflict.path, this.store.getBlob(hash)).kind !== 'text')) fail('BINARY_MERGE', 'Binary versions can only be kept individually or as separate files.');
      if (command.data === undefined) fail('INVALID_COMMAND', 'Manual text content is required.');
      const bytes = unb64(command.data, MAX_BLOB_BYTES);
      if (classifyBytes(conflict.path, bytes).kind !== 'text') fail('BINARY_MERGE', 'Manual merge content must be supported UTF-8 text.');
      selected = this.store.putBlob(bytes);
    } else if (command.choice === 'local') selected = conflict.localHash;
    else if (command.choice === 'remote' || command.choice === 'both') selected = current && !current.deleted ? current.hash : null;
    else fail('INVALID_COMMAND', 'Choose a local, remote, separate-copy, or manual text resolution.');
    const base = current ?? { id: conflict.fileId ?? this.store.newFileId(), path: conflict.path, kind: 'binary', generation: 0, revision: 0,
      hash: '', size: 0, stateHash: null, lineEnding: null, deleted: true } satisfies ProjectFile;
    let copy: ProjectFile | undefined;
    if (command.choice === 'both') {
      if (!conflict.localHash || !selected) fail('INVALID_COMMAND', 'Keeping both requires a local version and a current remote file.');
      const name = this.copyPath(base.path);
      copy = this.fileFromHash({ ...base, id: this.store.newFileId(), path: name, generation: 0, deleted: true }, conflict.localHash, base.kind === 'binary' && base.generation > 0);
    }
    this.store.db.prepare('UPDATE recovery_conflicts SET resolved_before=? WHERE id=?').run(current ? JSON.stringify(current) : null, conflict.id);
    if (command.choice === 'remote' || command.choice === 'both') {
      // Keeping the reviewed canonical side is a metadata-only decision; its
      // current CRDT identity and any newer content are retained unchanged.
    } else if (selected === null) {
      if (current && !current.deleted) { this.recordTrash([current], actor); this.store.stageFile({ ...current, generation: current.generation + 1, deleted: true }); }
    } else this.store.stageFile(this.fileFromHash(base, selected));
    if (copy) this.store.stageFile(copy);
    conflict.status = 'resolved'; conflict.resolution = command.choice;
    this.save('recovery_conflicts', conflict, conflict.createdAt);
    return { conflictId: conflict.id, ...(copy ? { copyFileId: copy.id, copyPath: copy.path } : {}) };
  }

  private fileFromHash(base: ProjectFile, hash: string, forceBinary = base.kind === 'binary' && base.generation > 0): ProjectFile {
    this.requireBlob(hash);
    const bytes = this.store.getBlob(hash), classification = forceBinary ? { kind: 'binary' as const, reason: base.reason } : classifyBytes(base.path, bytes);
    const version: ProjectFile = { ...base, kind: classification.kind, hash, size: bytes.length, deleted: false,
      stateHash: null, lineEnding: classification.kind === 'text' ? classification.lineEnding! : null,
      revision: this.store.nextRevision(), reason: classification.reason };
    if (classification.kind === 'text') return this.store.textFile(version, new TextDecoder('utf-8', { fatal: true }).decode(bytes), true);
    return { ...version, generation: base.generation + 1 };
  }

  private copyPath(original: string): string {
    const slash = original.lastIndexOf('/'), dot = original.lastIndexOf('.');
    const hasExtension = dot > slash + 1, stem = hasExtension ? original.slice(0, dot) : original, extension = hasExtension ? original.slice(dot) : '';
    const occupied = new Set(this.store.files(true).map((file) => fold(file.path)));
    for (let i = 1; i <= 1000; i++) {
      const candidate = `${stem} (local ${i})${extension}`;
      const policy = this.policy();
      if (!occupied.has(fold(candidate)) && policy.check(candidate).allowed && !existsSync(policy.resolve(candidate, { allowMissing: true }))) return candidate;
    }
    return fail('PATH_CONFLICT', 'A safe name for the local copy could not be found.');
  }

  private excludedCurrent(): Excluded[] {
    const policy = this.policy();
    return this.store.files().flatMap((file) => { const check = policy.check(file.path, file.kind === 'directory'); return check.allowed ? [] : [{ path: file.path, reason: check.reason! }]; });
  }
  private createCheckpoint(name: string, actor: Actor, protective: boolean): Checkpoint {
    const policy = this.policy();
    const checkpoint: Checkpoint = { id: randomUUID(), name, createdAt: Date.now(), revision: this.store.revision(), actorName: actor.name,
      protected: protective, files: this.store.files().filter((file) => this.allowed(file, policy)).map((file) => ({ ...file })) };
    this.save('recovery_checkpoints', checkpoint, checkpoint.createdAt);
    return checkpoint;
  }

  previewCheckpoint(checkpointId: string, fileIds?: string[]): RestorePreview {
    const checkpoint = this.row<Checkpoint>('recovery_checkpoints', checkpointId);
    const all = this.store.files(true), current = new Map(all.map((file) => [file.id, file]));
    const originals = new Map(checkpoint.files.map((file) => [file.id, file]));
    let selected: Set<string> | undefined;
    if (fileIds !== undefined) {
      if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > MAX_RECORDS || fileIds.some((id) => typeof id !== 'string')) fail('INVALID_COMMAND', 'Select one or more checkpoint files.');
      selected = new Set(fileIds);
      for (const id of fileIds) {
        const file = originals.get(id) ?? current.get(id);
        if (!file) fail('NOT_FOUND', 'A selected file is not part of the checkpoint or current project.');
        if (file.kind === 'directory') for (const child of [...checkpoint.files, ...all]) if (child.path.startsWith(`${file.path}/`)) selected.add(child.id);
      }
      // A single-file restore can re-create its missing checkpoint parent folders.
      for (const id of [...selected]) {
        const file = originals.get(id);
        if (!file) continue;
        for (const parent of checkpoint.files) if (parent.kind === 'directory' && file.path.startsWith(`${parent.path}/`) && (!current.get(parent.id) || current.get(parent.id)!.deleted)) selected.add(parent.id);
      }
    }
    const policy = this.policy(), changes: FileChange[] = [], excluded: Excluded[] = [];
    let unchanged = 0;
    for (const source of checkpoint.files) {
      if (selected && !selected.has(source.id)) continue;
      const check = policy.check(source.path, source.kind === 'directory');
      if (!check.allowed) { excluded.push({ path: source.path, reason: check.reason! }); continue; }
      const before = current.get(source.id) ?? null;
      if (before && !this.allowed(before, policy)) { excluded.push({ path: before.path, reason: 'The current file is excluded from sharing.' }); continue; }
      // Even byte-identical selected files receive a fresh generation: an old
      // offline edit must not arrive later and silently undo an explicit restore.
      if (before && sameVersion(before, source)) unchanged++;
      changes.push({ before, after: { ...source, generation: Math.max(source.generation, before?.generation ?? 0) + 1, revision: this.store.revision() + 1, deleted: false } });
    }
    for (const before of all) {
      if (before.deleted || originals.has(before.id) || (selected && !selected.has(before.id))) continue;
      const check = policy.check(before.path, before.kind === 'directory');
      if (!check.allowed) { excluded.push({ path: before.path, reason: check.reason! }); continue; }
      changes.push({ before, after: { ...before, generation: before.generation + 1, revision: this.store.revision() + 1, deleted: true } });
    }
    const byId = new Map(all.filter((file) => !file.deleted).map((file) => [file.id, file]));
    for (const change of changes) { if (change.after.deleted) byId.delete(change.after.id); else byId.set(change.after.id, change.after); }
    const paths = new Set<string>();
    for (const file of byId.values()) { const key = fold(file.path); if (paths.has(key)) fail('PATH_CONFLICT', 'A restored path is occupied by another file. Restore the project or move the existing file first.'); paths.add(key); }
    changes.sort((a, b) => a.after.path.localeCompare(b.after.path, 'en') || a.after.id.localeCompare(b.after.id, 'en'));
    return { checkpointId, revision: this.store.revision(), paths: changes.map((change) => change.after.path), files: changes,
      creates: changes.filter(({ before, after }) => (!before || before.deleted) && !after.deleted).length,
      updates: changes.filter(({ before, after }) => before && !before.deleted && !after.deleted).length,
      deletes: changes.filter(({ after }) => after.deleted).length,
      bytes: changes.reduce((sum, { after }) => sum + (after.deleted ? 0 : after.size), 0), excluded, unchanged };
  }

  private applyRestore(changes: FileChange[], actor: Actor, command: ProjectCommand): void {
    for (const change of changes) if (change.before) this.guard(change.before.id, actor, command);
    // Vacate deleted/moved catalog paths before restoring a different file there.
    const deleting = changes.filter((change) => change.after.deleted).sort((a, b) => b.after.path.length - a.after.path.length);
    this.recordTrash(deleting.flatMap(({ before }) => before && !before.deleted ? [before] : []), actor);
    for (const { after } of deleting) this.store.stageFile(after);
    const restoring = changes.filter((change) => !change.after.deleted).sort((a, b) => a.after.path.length - b.after.path.length || a.after.path.localeCompare(b.after.path, 'en'));
    for (const { before, after } of restoring) if (before && !before.deleted && before.path !== after.path)
      this.store.stageFile({ ...before, deleted: true });
    for (const { after } of restoring) {
      this.requirePath(after);
      this.validateVersion(after);
      if (after.kind === 'directory') this.store.stageFile(after);
      else this.store.stageFile(this.fileFromHash({ ...after, generation: after.generation - 1 }, after.hash));
    }
  }

  private recordTrash(files: ProjectFile[], actor: Actor): void {
    const now = Date.now();
    this.expireTrash(now);
    for (const file of files) {
      const entry: TrashEntry = { id: randomUUID(), fileId: file.id, path: file.path, kind: file.kind, size: file.size,
        deletedAt: now, actorName: actor.name, generation: file.generation, file: { ...file } };
      this.save('recovery_trash', entry, now);
    }
    this.checkBounds();
  }
  private expireTrash(now: number): string[] {
    const threshold = now - this.settings().retentionDays * DAY;
    const expired = this.rows<TrashEntry>('recovery_trash').filter((entry) => entry.deletedAt <= threshold).map((entry) => entry.id);
    for (const id of expired) this.store.db.prepare('DELETE FROM recovery_trash WHERE id=?').run(id);
    return expired;
  }
  private restoreTrash(command: Extract<ProjectCommand, { kind: 'trash-restore' }>, actor: Actor): Record<string, unknown> {
    this.expectedRevision(command.expectedRevision);
    const entry = this.row<TrashEntry>('recovery_trash', command.trashId);
    const entries = this.rows<TrashEntry>('recovery_trash').filter((candidate) => candidate.id === entry.id || (entry.kind === 'directory' && candidate.path.startsWith(`${entry.path}/`) && candidate.deletedAt === entry.deletedAt && candidate.actorName === entry.actorName));
    const changes: FileChange[] = [];
    for (const item of entries) {
      this.requirePath(item.file);
      const before = this.store.file(item.fileId) ?? null;
      if (before && !before.deleted) fail('PATH_CONFLICT', 'This file has already been restored or replaced.');
      if (this.store.files().some((file) => fold(file.path) === fold(item.path))) fail('PATH_CONFLICT', 'The restore location is occupied. Move the current file before restoring.');
      changes.push({ before, after: { ...item.file, generation: Math.max(item.generation, before?.generation ?? 0) + 1, revision: this.store.nextRevision(), deleted: false } });
    }
    const protective = this.createCheckpoint(`Before restoring ${entry.path}`, actor, true);
    this.applyRestore(changes, actor, command);
    for (const item of entries) this.store.db.prepare('DELETE FROM recovery_trash WHERE id=?').run(item.id);
    return { restored: entries.map((item) => item.id), protectiveCheckpointId: protective.id };
  }

  private updateSettings(command: Extract<ProjectCommand, { kind: 'settings' }>, actor: Actor): Record<string, unknown> {
    this.requireOwner(actor);
    const previous = this.settings(), settings: Settings = { ignorePatterns: command.ignorePatterns ?? previous.ignorePatterns,
      retentionDays: command.retentionDays ?? previous.retentionDays, strictClaims: command.strictClaims ?? previous.strictClaims };
    this.validateSettings(settings);
    const policy = this.store.configurePolicy(new ProjectPolicy(this.store.root, settings.ignorePatterns)), excluded: Excluded[] = [];
    for (const file of this.store.files()) {
      const check = policy.check(file.path, file.kind === 'directory');
      if (!check.allowed) { excluded.push({ path: file.path, reason: check.reason! }); this.store.stageFile({ ...file, deleted: true, generation: file.generation + 1 }, true); }
    }
    this.store.db.prepare('UPDATE recovery_settings SET data=? WHERE id=1').run(JSON.stringify(settings));
    return { excluded, purgedTrash: this.expireTrash(Date.now()), scope: 'ignored-files-remain-on-disk' };
  }
}
