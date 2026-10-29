import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { watch, type FSWatcher } from 'chokidar';
import { diffChars, diffLines } from 'diff';
import * as Y from 'yjs';
import {
  acquireOwnership,
  b64,
  CairnError,
  checkLineEnding,
  hash,
  openDb,
  privateDir,
  publicError,
  readBounded,
  textBytes,
  transaction,
  unb64,
  utf8,
} from '../common.js';
import { MAX_TEXT_BYTES, MAX_UPDATE_BYTES } from '../../shared/types.js';
import type {
  Actor,
  ActivityEntry,
  BlobObject,
  CommandKind,
  FileChange,
  ProjectCommand,
  ProjectEvent,
  ProjectFile,
  ProjectStatus,
  ProjectionRecord,
  SharedMetadata,
  SnapshotManifest,
  StoreQuery,
} from '../../shared/project.js';
import {
  classifyBytes,
  MAX_BLOB_BYTES,
  MAX_ENTRIES,
  MAX_PROJECT_BYTES,
  mkdirProjected,
  ProjectPolicy,
  projectBytes,
  removeEmptyDirectory,
  removeProjected,
  type ScannedEntry,
} from './filesystem.js';

interface Options {
  root: string;
  mode: 'authority' | 'replica';
  name?: string;
  projectId?: string;
  ownerId?: string;
  autoProject?: boolean;
}
type Handler = (command: ProjectCommand, actor: Actor) => Record<string, unknown> | void;
interface ProjectionRow {
  file_id: string;
  desired: string;
  previous_path: string | null;
  previous_hash: string | null;
  state: ProjectionRecord['state'];
  error: string | null;
  preserve_disk: number;
}
interface Baseline {
  file_id: string;
  path: string;
  hash: string;
  revision: number;
  generation: number;
}
interface Context {
  command: ProjectCommand;
  actor: Actor;
  revision: number;
  changes: Map<string, FileChange>;
  external: boolean;
}
const EMPTY_METADATA = (): SharedMetadata => ({
  claims: [],
  conflicts: [],
  checkpoints: [],
  trash: [],
  ignorePatterns: [],
  retentionDays: 30,
  strictClaims: false,
});
// Leave room for transport envelopes below the 24 MiB frame limit. Every
// committed event also reserves the brackets of a one-event history page.
const MAX_WIRE_JSON_BYTES = 20 * 1024 * 1024;
const operationTooLarge = (): never =>
  fail(
    'OPERATION_TOO_LARGE',
    'This change is too large to synchronize as one operation. Work on smaller groups or folders; nothing was committed.',
  );
function wireBytes(serialized: string, reserve = 0): number {
  const bytes = Buffer.byteLength(serialized);
  if (bytes + reserve > MAX_WIRE_JSON_BYTES) operationTooLarge();
  return bytes;
}
const folded = (value: string) => value.toUpperCase().toLowerCase().normalize('NFC');
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(code: string, message: string): never {
  throw new CairnError(code, message);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** The digest includes identity, CRDT state and generations, never local disk/projection state. */
export function projectManifestHash(files: ProjectFile[]): string {
  return hash(
    stable(files.filter((f) => !f.deleted).sort((a, b) => a.id.localeCompare(b.id, 'en'))),
  );
}
function validateDocument(doc: Y.Doc): void {
  const content = doc.getText('content');
  if ([...doc.share.keys()].some((key) => key !== 'content'))
    fail('INVALID_UPDATE', 'Only the content text can be edited.');
  for (const part of content.toDelta())
    if (typeof part.insert !== 'string' || (part.attributes && Object.keys(part.attributes).length))
      fail('INVALID_UPDATE', 'Rich text and embedded objects are unsupported.');
  textBytes(content.toString());
  if (Y.encodeStateAsUpdate(doc).byteLength > MAX_UPDATE_BYTES)
    fail(
      'STATE_LIMIT',
      'The document history exceeds 4 MiB. Preserve the local version for review.',
    );
}

/** Canonical catalog and receipts share one FULL-synchronous SQLite commit. Disk is a recoverable projection. */
export class ProjectStore extends EventEmitter {
  readonly db!: DatabaseSync;
  readonly root: string;
  readonly dataDir: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly policy: ProjectPolicy;
  readonly mode: Options['mode'];
  private readonly autoProject: boolean;
  private readonly release: () => void;
  private readonly recoveryDir: string;
  private handlers = new Map<string, Handler>();
  private queries = new Map<string, (query: StoreQuery) => unknown>();
  private provider?: () => SharedMetadata;
  private metadataInstaller?: (metadata: SharedMetadata) => void;
  private deleteObserver?: (files: ProjectFile[], actor: Actor) => void;
  private writeGuard?: (fileId: string, actor: Actor, command: ProjectCommand) => void;
  private projectionHold?: (fileId: string) => boolean;
  private current?: Context;
  private watcher?: FSWatcher;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private projectionTask?: ReturnType<typeof setImmediate>;
  private closed = false;
  private projecting = false;
  private scanning = false;
  private externalActor?: Actor;
  private excluded: { path: string; reason: string }[] = [];

  constructor(options: Options) {
    super();
    this.mode = options.mode;
    this.autoProject = options.autoProject !== false && options.mode === 'authority';
    this.root = path.resolve(options.root);
    let existingAncestor = this.root;
    while (!fs.existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
    new ProjectPolicy(existingAncestor); // Reject redirected ancestors before creating a workcopy.
    fs.mkdirSync(this.root, { recursive: true });
    this.policy = new ProjectPolicy(this.root);
    if (fs.existsSync(path.join(this.root, '.cairn')))
      fail(
        'LEGACY_PROJECT',
        'This folder contains an earlier Cairn project. Import a separate copy instead.',
      );
    if (fs.existsSync(path.join(this.root, '.cairn-next-client')))
      fail('LEGACY_PROJECT', 'An earlier client owns this folder. Use a separate workcopy.');
    this.dataDir = privateDir(this.root, '.cairn-next');
    if (
      ['server.sqlite', 'client.sqlite'].some((name) =>
        fs.existsSync(path.join(this.dataDir, name)),
      )
    )
      fail(
        'LEGACY_PROJECT',
        'The earlier project database must be preserved. Use a separate workcopy.',
      );
    this.release = acquireOwnership(this.dataDir);
    try {
      this.db = openDb(path.join(this.dataDir, 'project.sqlite'));
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_blobs(hash TEXT PRIMARY KEY,data BLOB NOT NULL,size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS project_files(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_files_path ON project_files(json_extract(record,'$.path'));
        CREATE TABLE IF NOT EXISTS project_journal(revision INTEGER PRIMARY KEY,event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_operations(op_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,payload_hash TEXT NOT NULL,event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_projections(file_id TEXT PRIMARY KEY,desired TEXT NOT NULL,previous_path TEXT,previous_hash TEXT,state TEXT NOT NULL,error TEXT,preserve_disk INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS project_baselines(file_id TEXT PRIMARY KEY,path TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS project_observed(path TEXT PRIMARY KEY,signature TEXT NOT NULL);
      `);
      const existing = this.meta<string>('projectId');
      if (existing) {
        if (options.projectId && options.projectId !== existing)
          fail('PROJECT_MISMATCH', 'This workcopy belongs to another project.');
        if (this.meta<string>('mode') !== this.mode)
          fail('ROOT_IN_USE', 'Authority and joined workcopies must use separate folders.');
        this.projectId = existing;
        this.ownerId = this.meta<string>('ownerId')!;
        this.policy.refresh(this.meta<SharedMetadata>('metadata')?.ignorePatterns ?? []);
      } else {
        this.projectId = options.projectId ?? randomUUID();
        this.ownerId = options.ownerId ?? randomUUID();
        transaction(this.db, () => {
          this.setMeta('projectId', this.projectId);
          this.setMeta('ownerId', this.ownerId);
          this.setMeta('name', options.name?.trim().slice(0, 120) || path.basename(this.root));
          this.setMeta('mode', this.mode);
          this.setMeta('revision', 0);
          this.setMeta('metadata', EMPTY_METADATA());
          this.setMeta('initialized', this.mode === 'authority');
          if (this.mode === 'authority') {
            this.initialImport();
            this.assertSnapshotWireBudget(this.files(), EMPTY_METADATA());
          }
        });
      }
      this.configurePolicy(this.policy);
      this.recoveryDir = path.join(this.dataDir, 'recovery');
      if (this.autoProject) this.scheduleProjection();
    } catch (error) {
      try {
        this.db!.close();
      } catch {
        /* Failed opening has no live database. */
      }
      this.release();
      throw error;
    }
  }
  private checkOpen(): void {
    if (this.closed) fail('STORE_CLOSED', 'The project is closed.');
  }
  private meta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM project_meta WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private setMeta(key: string, value: unknown): string {
    const serialized = JSON.stringify(value);
    this.db
      .prepare(
        'INSERT INTO project_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, serialized);
    return serialized;
  }
  /** Candidate settings policies must evaluate the same transaction's canonical ignore files. */
  configurePolicy(policy: ProjectPolicy): ProjectPolicy {
    policy.setIgnoreFileResolver((relative) => {
      const rows = this.db
        .prepare(
          "SELECT record FROM project_files WHERE json_extract(record,'$.path')=? AND json_extract(record,'$.deleted')=0",
        )
        .all(relative) as { record: string }[];
      const record = rows[0] ? (JSON.parse(rows[0].record) as ProjectFile) : undefined;
      if (!record || record.kind === 'directory') return undefined;
      const bytes = this.getBlob(record.hash);
      if (bytes.length > MAX_TEXT_BYTES)
        fail('INVALID_IGNORE', 'An ignore file cannot exceed 1 MiB.');
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        fail('INVALID_IGNORE', 'Ignore files must contain valid UTF-8.');
      }
    });
    return policy;
  }
  revision(): number {
    this.checkOpen();
    return this.meta<number>('revision') ?? 0;
  }
  files(includeDeleted = false): ProjectFile[] {
    this.checkOpen();
    return (this.db.prepare('SELECT record FROM project_files').all() as { record: string }[])
      .map((row) => JSON.parse(row.record) as ProjectFile)
      .filter((f) => includeDeleted || !f.deleted)
      .sort((a, b) => a.path.localeCompare(b.path, 'en') || a.id.localeCompare(b.id, 'en'));
  }
  file(id: string): ProjectFile | undefined {
    this.checkOpen();
    const row = this.db.prepare('SELECT record FROM project_files WHERE id=?').get(id) as
      { record: string } | undefined;
    return row ? (JSON.parse(row.record) as ProjectFile) : undefined;
  }
  manifestHash(): string {
    return projectManifestHash(this.files());
  }
  newFileId(): string {
    return randomUUID();
  }
  nextRevision(): number {
    if (!this.current) fail('TRANSACTION_REQUIRED', 'File changes require an active command.');
    return this.current.revision;
  }
  putBlob(bytes: Uint8Array): string {
    this.checkOpen();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BLOB_BYTES)
      fail('FILE_SIZE_LIMIT', 'Blob exceeds the 16 MiB limit.');
    const digest = hash(bytes);
    this.db
      .prepare('INSERT OR IGNORE INTO project_blobs VALUES (?,?,?)')
      .run(digest, bytes, bytes.byteLength);
    return digest;
  }
  getBlob(digest: string): Uint8Array {
    this.checkOpen();
    if (!validHash(digest)) fail('INVALID_HASH', 'A valid SHA-256 digest is required.');
    const row = this.db.prepare('SELECT data,size FROM project_blobs WHERE hash=?').get(digest) as
      { data: Uint8Array; size: number } | undefined;
    if (!row) fail('MISSING_BLOB', 'The requested immutable content is unavailable.');
    if (row.size > MAX_BLOB_BYTES || row.data.byteLength !== row.size || hash(row.data) !== digest)
      fail('BLOB_CORRUPT', 'Stored content failed its integrity check.');
    return new Uint8Array(row.data);
  }
  hasBlob(digest: string): boolean {
    if (!validHash(digest)) fail('INVALID_HASH', 'A valid SHA-256 digest is required.');
    return !!this.db.prepare('SELECT 1 FROM project_blobs WHERE hash=?').get(digest);
  }
  blobSize(digest: string): number {
    return this.getBlob(digest).byteLength;
  }
  registerCommand(kind: CommandKind, handler: Handler): void {
    if (['text', 'write', 'create', 'move', 'delete', 'rescan'].includes(kind))
      fail('RESERVED_HANDLER', 'Core file commands cannot be replaced.');
    if (this.handlers.has(kind)) fail('DUPLICATE_HANDLER', 'This command already has a handler.');
    this.handlers.set(kind, handler);
  }
  registerQuery(kind: StoreQuery['kind'], handler: (query: StoreQuery) => unknown): void {
    this.queries.set(kind, handler);
  }
  setMetadataProvider(fn: () => SharedMetadata): void {
    this.provider = fn;
    this.policy.refresh(this.metadata().ignorePatterns);
  }
  setMetadataInstaller(fn: (metadata: SharedMetadata) => void): void {
    this.metadataInstaller = fn;
  }
  setDeleteObserver(fn: (files: ProjectFile[], actor: Actor) => void): void {
    this.deleteObserver = fn;
  }
  setWriteGuard(fn: (fileId: string, actor: Actor, command: ProjectCommand) => void): void {
    this.writeGuard = fn;
  }
  setProjectionHold(fn: (fileId: string) => boolean): void {
    this.projectionHold = fn;
  }
  setExternalActor(actor: Actor): void {
    if (
      actor.id !== this.ownerId ||
      actor.role !== 'owner' ||
      typeof actor.name !== 'string' ||
      !actor.name.trim() ||
      !['app', 'unknown', 'external', 'declared-ai'].includes(actor.source?.kind)
    )
      fail(
        'INVALID_ACTOR',
        'External attribution must identify this project owner and a supported declared source.',
      );
    this.externalActor = this.permission({ opId: randomUUID(), kind: 'rescan' }, actor);
  }
  metadata(): SharedMetadata {
    return clone(
      this.provider ? this.provider() : (this.meta<SharedMetadata>('metadata') ?? EMPTY_METADATA()),
    );
  }
  status(): ProjectStatus {
    const projections = (
      this.db.prepare('SELECT * FROM project_projections').all() as unknown as ProjectionRow[]
    ).map((row) => ({
      fileId: row.file_id,
      path: (JSON.parse(row.desired) as ProjectFile).path,
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      ...(row.previous_hash ? { hash: row.previous_hash } : {}),
    }));
    const storage = this.db
      .prepare('SELECT coalesce(sum(size),0) AS size FROM project_blobs')
      .get() as { size: number };
    return {
      projectId: this.projectId,
      name: this.meta<string>('name')!,
      root: this.root,
      revision: this.revision(),
      manifestHash: this.manifestHash(),
      files: this.files(),
      projections,
      metadata: this.metadata(),
      watching: !!this.watcher,
      excluded: [...this.excluded],
      storageBytes: storage.size,
    };
  }
  private initialImport(): void {
    const scan = this.policy.scan();
    this.excluded = scan.excluded;
    for (const excluded of scan.excluded)
      if (path.posix.basename(excluded.path) === '.gitignore')
        fail(
          'INVALID_IGNORE',
          'An ignore control file cannot itself be excluded while its folder is shared. Keep .gitignore shareable before opening this project.',
        );
    for (const entry of scan.entries) {
      const file = this.fromEntry(entry, 0);
      this.saveFile(file);
      this.db
        .prepare('INSERT INTO project_projections VALUES (?,?,?,?,?,?,?)')
        .run(
          file.id,
          JSON.stringify(file),
          file.path,
          file.kind === 'directory' ? null : file.hash,
          'applied',
          null,
          0,
        );
      this.recordBaseline(file);
    }
  }
  private fromEntry(
    entry: ScannedEntry,
    revision: number,
    id = this.newFileId(),
    generation = 1,
  ): ProjectFile {
    const file: ProjectFile = {
      id,
      path: entry.path,
      kind: entry.kind,
      generation,
      revision,
      hash: '',
      size: 0,
      stateHash: null,
      lineEnding: null,
      deleted: false,
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
    if (entry.kind === 'directory') return file;
    if (entry.kind === 'text')
      return { ...this.textFile(file, utf8(entry.bytes!), false), revision };
    return { ...file, hash: this.putBlob(entry.bytes!), size: entry.bytes!.byteLength };
  }
  textFile(file: ProjectFile, text: string, bumpGeneration: boolean): ProjectFile {
    textBytes(text);
    const doc = new Y.Doc();
    doc.getText('content');
    try {
      if (!bumpGeneration && file.kind === 'text' && file.stateHash) {
        Y.applyUpdate(doc, this.getBlob(file.stateHash), 'stored');
        const current = doc.getText('content');
        const before = current.toString();
        if (file.lineEnding) checkLineEnding(text, file.lineEnding);
        const changes = diffChars(before, text, { timeout: 80, maxEditLength: 20000 });
        if (!changes)
          fail(
            'DIFF_LIMIT',
            'The external change is too complex for safe automatic merging. Preserve it as a conflict.',
          );
        doc.transact(() => {
          let position = 0;
          for (const change of changes) {
            if (change.removed) current.delete(position, change.value.length);
            else if (change.added) {
              current.insert(position, change.value);
              position += change.value.length;
            } else position += change.value.length;
          }
        }, 'external');
      } else if (text) doc.getText('content').insert(0, text);
      validateDocument(doc);
      return {
        ...file,
        kind: 'text',
        deleted: false,
        generation: file.generation + (bumpGeneration ? 1 : 0),
        hash: this.putBlob(Buffer.from(text)),
        size: Buffer.byteLength(text),
        stateHash: this.putBlob(Y.encodeStateAsUpdate(doc)),
        lineEnding: file.lineEnding ?? (text.includes('\r\n') ? 'crlf' : 'lf'),
        reason: undefined,
      };
    } finally {
      doc.destroy();
    }
  }
  private saveFile(file: ProjectFile): void {
    this.db
      .prepare(
        'INSERT INTO project_files VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
      )
      .run(file.id, JSON.stringify(file));
  }
  private ensurePath(file: ProjectFile, ignoreIds = new Set<string>()): void {
    const allowed = this.policy.check(file.path, file.kind === 'directory');
    if (!allowed.allowed) {
      const previous = this.current?.changes.get(file.id)?.before ?? this.file(file.id);
      if (
        previous &&
        previous.kind !== 'directory' &&
        previous.path !== file.path &&
        folded(previous.path) === folded(file.path)
      )
        this.policy.resolveRenameTarget(file.path, previous.path);
      else fail('EXCLUDED_PATH', allowed.reason!);
    }
    const key = folded(file.path);
    for (const existing of this.files())
      if (existing.id !== file.id && !ignoreIds.has(existing.id)) {
        if (folded(existing.path) === key)
          fail('PATH_COLLISION', 'Another project entry already uses this path.');
        if (key.startsWith(`${folded(existing.path)}/`) && existing.kind !== 'directory')
          fail('PATH_COLLISION', 'A parent path is a file.');
        if (folded(existing.path).startsWith(`${key}/`) && file.kind !== 'directory')
          fail('PATH_COLLISION', 'This file would replace a non-empty project directory.');
      }
  }
  private validateFile(file: ProjectFile, verifyContent = true): void {
    if (
      !file ||
      typeof file.id !== 'string' ||
      !file.id ||
      file.id.length > 128 ||
      !['text', 'binary', 'directory'].includes(file.kind) ||
      !Number.isSafeInteger(file.generation) ||
      file.generation < 1 ||
      !Number.isSafeInteger(file.revision) ||
      file.revision < 0 ||
      typeof file.deleted !== 'boolean'
    )
      fail('INVALID_FILE', 'The file record is invalid.');
    if (file.kind === 'directory') {
      if (
        file.hash !== '' ||
        file.size !== 0 ||
        file.stateHash !== null ||
        file.lineEnding !== null
      )
        fail('INVALID_FILE', 'Directory records cannot contain file content.');
      return;
    }
    if (
      !validHash(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BLOB_BYTES
    )
      fail('INVALID_FILE', 'The file size or content digest is invalid.');
    if (
      file.kind === 'text' &&
      (!validHash(file.stateHash) ||
        !['lf', 'crlf'].includes(file.lineEnding ?? '') ||
        file.size > MAX_TEXT_BYTES)
    )
      fail('INVALID_FILE', 'Text identity is missing or exceeds its size limit.');
    if (file.kind === 'binary' && (file.stateHash !== null || file.lineEnding !== null))
      fail('INVALID_FILE', 'Binary content cannot masquerade as a text document.');
    if (!verifyContent) return;
    const bytes = this.getBlob(file.hash);
    if (bytes.byteLength !== file.size) fail('BLOB_MISMATCH', 'File size and blob disagree.');
    if (file.kind === 'text') {
      const state = this.getBlob(file.stateHash!);
      if (state.byteLength > MAX_UPDATE_BYTES) fail('STATE_LIMIT', 'Document state exceeds 4 MiB.');
      const doc = new Y.Doc();
      doc.getText('content');
      try {
        Y.applyUpdate(doc, state);
        validateDocument(doc);
        const text = doc.getText('content').toString();
        checkLineEnding(text, file.lineEnding!);
        if (hash(text) !== file.hash)
          fail('STATE_MISMATCH', 'Text and persisted CRDT state disagree.');
      } finally {
        doc.destroy();
      }
    }
  }
  stageFile(input: ProjectFile, preserveDisk = false): void {
    const context = this.current;
    if (!context) fail('TRANSACTION_REQUIRED', 'File changes require an active command.');
    const before = this.file(input.id);
    const file = { ...input, revision: context.revision };
    if (before) this.writeGuard?.(file.id, context.actor, context.command);
    this.validateFile(file);
    if (!file.deleted) this.ensurePath(file);
    const existing = context.changes.get(file.id);
    context.changes.set(file.id, {
      before: existing?.before ?? before ?? null,
      after: clone(file),
      ...(preserveDisk ? { preserveDisk: true } : {}),
    });
    this.saveFile(file);
    const previous = this.db
      .prepare('SELECT * FROM project_projections WHERE file_id=?')
      .get(file.id) as unknown as ProjectionRow | undefined;
    // A persisted null means this entry has never been projected. In particular,
    // create -> move before the first projection must still be a no-replace create.
    const previousPath = previous ? previous.previous_path : before ? before.path : null;
    const previousHash = previous?.previous_hash ?? null;
    this.db
      .prepare(
        'INSERT INTO project_projections VALUES (?,?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET desired=excluded.desired,state=excluded.state,error=NULL,preserve_disk=excluded.preserve_disk',
      )
      .run(
        file.id,
        JSON.stringify(file),
        previousPath,
        previousHash,
        preserveDisk ? 'applied' : 'pending',
        null,
        preserveDisk ? 1 : 0,
      );
  }
  private permission(command: ProjectCommand, actor: Actor): Actor {
    if (
      !actor ||
      !['owner', 'editor', 'viewer'].includes(actor.role) ||
      typeof actor.id !== 'string' ||
      !actor.id ||
      actor.id.length > 128 ||
      typeof actor.name !== 'string'
    )
      fail('AUTH_REQUIRED', 'A validated project actor is required.');
    if (actor.role === 'viewer')
      fail('READ_ONLY', 'Read-only participants cannot change this project.');
    const internal =
      actor.id === 'system' && actor.source?.kind === 'system' && command.kind === 'claim-expire';
    if (actor.role === 'owner' && actor.id !== this.ownerId && !internal)
      fail('OWNER_REQUIRED', 'The owner identity does not match this project.');
    if (
      ['settings', 'checkpoint-delete', 'checkpoint-restore', 'trash-purge'].includes(
        command.kind,
      ) &&
      actor.role !== 'owner'
    )
      fail('OWNER_REQUIRED', 'This operation requires the project owner.');
    if (command.kind === 'claim-expire' && !internal)
      fail('SYSTEM_REQUIRED', 'Claim expiry is an internal operation.');
    const source =
      command.kind === 'rescan' && (!actor.source || actor.source.kind === 'app')
        ? { kind: 'unknown' as const }
        : ('source' in command && command.source) || actor.source || { kind: 'unknown' as const };
    if (
      !source ||
      !['app', 'unknown', 'external', 'declared-ai', 'recovery', 'system'].includes(source.kind) ||
      (source.kind === 'system' && !internal)
    )
      fail(
        'INVALID_SOURCE',
        'The change source is invalid. AI tools can only be explicitly declared.',
      );
    return {
      id: actor.id,
      name: actor.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100),
      role: actor.role,
      source: {
        kind: source.kind,
        ...(typeof source.tool === 'string' ? { tool: source.tool.slice(0, 100) } : {}),
      },
      ...(actor.clientId ? { clientId: actor.clientId.slice(0, 128) } : {}),
    };
  }
  apply(command: ProjectCommand, actor: Actor): ProjectEvent {
    this.checkOpen();
    if (this.mode !== 'authority')
      fail('AUTHORITY_REQUIRED', 'Commands must be sent to the project authority.');
    if (this.current) fail('NESTED_COMMAND', 'Commands cannot open a nested transaction.');
    if (
      !command ||
      typeof command.kind !== 'string' ||
      typeof command.opId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(command.opId)
    )
      fail('INVALID_COMMAND', 'The command identity is invalid.');
    const trusted = this.permission(command, actor);
    const payloadHash = hash(stable(command));
    const previous = this.db
      .prepare('SELECT * FROM project_operations WHERE op_id=?')
      .get(command.opId) as { actor_id: string; payload_hash: string; event: string } | undefined;
    if (previous) {
      if (previous.actor_id !== trusted.id || previous.payload_hash !== payloadHash)
        fail('OP_ID_COLLISION', 'This operation ID already names a different operation.');
      return JSON.parse(previous.event) as ProjectEvent;
    }
    let event: ProjectEvent;
    try {
      event = transaction(this.db, () => {
        const revision = this.revision() + 1;
        this.current = { command, actor: trusted, revision, changes: new Map(), external: false };
        if (command.kind === 'conflict-resolve') this.prepareConflictProjection(command.conflictId);
        const result = this.dispatch(command, trusted);
        const effectivePolicy = this.configurePolicy(
          new ProjectPolicy(this.root, this.metadata().ignorePatterns),
        );
        const sharedParent = (relative: string) => {
          const parent = path.posix.dirname(relative);
          return parent === '.' || effectivePolicy.check(parent, true).allowed;
        };
        for (const change of this.current.changes.values())
          if (
            change.preserveDisk &&
            change.before &&
            !change.before.deleted &&
            change.after.deleted &&
            path.posix.basename(change.before.path) === '.gitignore' &&
            sharedParent(change.before.path)
          )
            fail(
              'INVALID_IGNORE',
              'Keep .gitignore shared while its folder is shared; excluding the rules would lose its protection.',
            );
        // A newly committed .gitignore takes effect before snapshot/event visibility,
        // even while its own filesystem projection is pending or blocked.
        const policyDecisions = this.files().map((file) => ({
          file,
          allowed: effectivePolicy.check(file.path, file.kind === 'directory'),
        }));
        for (const { file, allowed } of policyDecisions) {
          if (!allowed.allowed) {
            if (path.posix.basename(file.path) === '.gitignore' && sharedParent(file.path))
              fail(
                'INVALID_IGNORE',
                'Ignore rules must keep their .gitignore control file shareable.',
              );
            const previous = this.current.changes.get(file.id)?.before;
            if (
              previous &&
              file.kind !== 'directory' &&
              previous.path !== file.path &&
              folded(previous.path) === folded(file.path)
            ) {
              effectivePolicy.resolveRenameTarget(file.path, previous.path);
            } else
              this.stageFile({ ...file, deleted: true, generation: file.generation + 1 }, true);
          }
        }
        const files = this.files();
        if (files.length > MAX_ENTRIES || files.reduce((n, f) => n + f.size, 0) > MAX_PROJECT_BYTES)
          fail('PROJECT_LIMIT', 'The project exceeds the shared entry or content limit.');
        const changes = [...this.current.changes.values()];
        const time = Date.now();
        const metadata = this.metadata();
        const metadataJson = this.setMeta('metadata', metadata);
        this.setMeta('revision', revision);
        const activity = this.activity(command, trusted, changes, revision, time);
        const committed: ProjectEvent = {
          opId: command.opId,
          revision,
          time,
          actor: trusted,
          kind: command.kind,
          changes,
          metadata,
          manifestHash: this.manifestHash(),
          activity,
          ...(result ? { result } : {}),
        };
        const serialized = JSON.stringify(committed);
        wireBytes(serialized, 2);
        this.assertSnapshotWireBudget(files, metadata, Buffer.byteLength(metadataJson));
        this.db.prepare('INSERT INTO project_journal VALUES (?,?)').run(revision, serialized);
        this.db
          .prepare('INSERT INTO project_operations VALUES (?,?,?,?)')
          .run(command.opId, trusted.id, payloadHash, serialized);
        return committed;
      });
    } finally {
      this.current = undefined;
    }
    // Callback failures must not turn a committed command into an apparent failed save.
    try {
      this.policy.refresh(event.metadata.ignorePatterns);
      this.emit('change', clone(event));
      this.emitStatus();
    } catch (error) {
      this.emitSafeError(error);
    }
    // No callback, acknowledgement or filesystem projection is allowed before this point.
    if (this.autoProject) this.scheduleProjection();
    return event;
  }
  private live(id: string, generation?: number): ProjectFile {
    const file = this.file(id);
    if (!file || file.deleted)
      fail(
        'FILE_DELETED',
        'This file is missing or deleted. Preserve the pending change for review.',
      );
    if (generation !== undefined && file.generation !== generation)
      fail(
        'STALE_GENERATION',
        'This document was restored or replaced. Its old changes need review.',
      );
    return file;
  }
  private cas(file: ProjectFile, revision: number, digest?: string): void {
    if (file.revision !== revision || (digest !== undefined && file.hash !== digest))
      fail('STALE_REVISION', 'The file changed since this operation was prepared.');
  }
  private parents(relative: string): void {
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const found = this.files().find((f) => folded(f.path) === folded(p));
      if (found) {
        if (found.kind !== 'directory') fail('PATH_COLLISION', 'A parent path is a file.');
        continue;
      }
      this.stageFile({
        id: this.newFileId(),
        path: p,
        kind: 'directory',
        generation: 1,
        revision: this.nextRevision(),
        hash: '',
        size: 0,
        stateHash: null,
        lineEnding: null,
        deleted: false,
      });
    }
  }
  private dispatch(command: ProjectCommand, actor: Actor): Record<string, unknown> | void {
    switch (command.kind) {
      case 'text': {
        const file = this.live(command.fileId, command.generation);
        if (file.kind !== 'text')
          fail('BINARY_FILE', 'This file is not an editable text document.');
        const doc = new Y.Doc();
        doc.getText('content');
        try {
          Y.applyUpdate(doc, this.getBlob(file.stateHash!), 'stored');
          Y.applyUpdate(doc, unb64(command.update, MAX_UPDATE_BYTES), 'remote');
          validateDocument(doc);
          const text = doc.getText('content').toString();
          checkLineEnding(text, file.lineEnding!);
          this.stageFile({
            ...file,
            hash: this.putBlob(Buffer.from(text)),
            size: Buffer.byteLength(text),
            stateHash: this.putBlob(Y.encodeStateAsUpdate(doc)),
          });
        } catch (error) {
          if (error instanceof CairnError) throw error;
          fail('INVALID_UPDATE', 'The document update is invalid.');
        } finally {
          doc.destroy();
        }
        return;
      }
      case 'write': {
        const file = this.live(command.fileId, command.generation);
        if (file.kind === 'directory') fail('DIRECTORY_WRITE', 'A directory has no file content.');
        this.cas(file, command.baseRevision, command.baseHash);
        const bytes = unb64(command.data, MAX_BLOB_BYTES);
        const classification = classifyBytes(file.path, bytes);
        if (file.kind === 'text' && classification.kind !== 'text')
          fail(
            'TEXT_FORMAT_CHANGED',
            'This text file needs an explicit replacement or conflict review before changing format.',
          );
        this.stageFile(
          file.kind === 'text'
            ? this.textFile(file, utf8(bytes), false)
            : { ...file, hash: this.putBlob(bytes), size: bytes.byteLength },
          this.current!.external,
        );
        return;
      }
      case 'create': {
        if (!['text', 'binary', 'directory'].includes(command.nodeKind))
          fail('INVALID_FILE', 'Unknown file type.');
        const bytes = unb64(command.data ?? '', MAX_BLOB_BYTES);
        if (command.nodeKind === 'directory' && bytes.length)
          fail('DIRECTORY_WRITE', 'A directory cannot contain bytes.');
        const classification =
          command.nodeKind === 'directory'
            ? { kind: 'directory' as const }
            : classifyBytes(command.path, bytes);
        if (command.nodeKind === 'text' && classification.kind !== 'text')
          fail('TEXT_FORMAT_CHANGED', 'This content must be shared as binary.');
        const file = this.fromEntry(
          {
            path: command.path,
            kind: command.nodeKind,
            bytes,
            ...(command.nodeKind === 'text' ? classification : {}),
          },
          this.nextRevision(),
        );
        this.ensurePath(file);
        this.parents(file.path);
        this.stageFile(file, this.current!.external);
        return { fileId: file.id };
      }
      case 'move': {
        const root = this.live(command.fileId);
        this.cas(root, command.baseRevision);
        if (command.expectedRevision !== undefined && command.expectedRevision !== this.revision())
          fail('STALE_PREVIEW', 'The project changed after preview.');
        if (command.path === root.path) return;
        if (
          root.kind === 'directory' &&
          (folded(command.path).startsWith(`${folded(root.path)}/`) ||
            folded(command.path) === folded(root.path))
        )
          fail(
            'UNSAFE_MOVE',
            'A directory cannot move into itself or change only its letter casing.',
          );
        const affected = this.files().filter(
          (f) =>
            f.id === root.id || (root.kind === 'directory' && f.path.startsWith(`${root.path}/`)),
        );
        const ids = new Set(affected.map((f) => f.id));
        const changed = affected.map((f) => ({
          ...f,
          path: command.path + f.path.slice(root.path.length),
        }));
        for (const f of changed) this.ensurePath(f, ids);
        this.parents(command.path);
        for (const file of changed) this.stageFile(file);
        return;
      }
      case 'delete': {
        const root = this.live(command.fileId);
        this.cas(root, command.baseRevision);
        if (command.expectedRevision !== this.revision())
          fail('STALE_PREVIEW', 'The project changed after the deletion preview.');
        const affected = this.files().filter(
          (f) =>
            f.id === root.id || (root.kind === 'directory' && f.path.startsWith(`${root.path}/`)),
        );
        this.deleteObserver?.(affected, actor);
        for (const file of affected)
          this.stageFile({ ...file, deleted: true, generation: file.generation + 1 });
        return;
      }
      case 'rescan':
        return this.rescanInside(actor);
      default: {
        const handler = this.handlers.get(command.kind);
        if (!handler) fail('UNSUPPORTED_COMMAND', 'This project feature is unavailable.');
        return handler(command, actor);
      }
    }
  }
  private activity(
    command: ProjectCommand,
    actor: Actor,
    files: FileChange[],
    revision: number,
    time: number,
  ): ActivityEntry {
    let added = 0,
      removed = 0;
    for (const change of files) {
      const before =
        change.before && change.before.kind === 'text' && !change.before.deleted
          ? Buffer.from(this.getBlob(change.before.hash)).toString('utf8')
          : '';
      const after =
        change.after.kind === 'text' && !change.after.deleted
          ? Buffer.from(this.getBlob(change.after.hash)).toString('utf8')
          : '';
      if (before !== after) {
        const parts = diffLines(before, after, { timeout: 30, maxEditLength: 10000 });
        if (parts)
          for (const part of parts) {
            if (part.added) added += part.count;
            if (part.removed) removed += part.count;
          }
        else {
          added += after ? after.split('\n').length : 0;
          removed += before ? before.split('\n').length : 0;
        }
      }
    }
    return {
      id: randomUUID(),
      opId: command.opId,
      revision,
      time,
      actor,
      kind: command.kind,
      paths: [
        ...new Set(files.flatMap((f) => [...(f.before ? [f.before.path] : []), f.after.path])),
      ],
      files,
      added,
      removed,
      summary: `${command.kind}: ${files.length} ${files.length === 1 ? 'entry' : 'entries'}`,
      sessionId: `${actor.clientId ?? actor.id}:${Math.floor(time / 1800000)}`,
    };
  }
  query(query: StoreQuery): unknown {
    this.checkOpen();
    if (query.kind === 'metadata') return this.metadata();
    if (query.kind === 'activity') {
      const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
      const search = query.search?.toLocaleLowerCase();
      const result: ActivityEntry[] = [];
      let totalBytes = 2;
      for (const row of this.db
        .prepare(
          "SELECT json_extract(event,'$.activity') AS activity FROM project_journal ORDER BY revision DESC",
        )
        .iterate()) {
        const serialized = row.activity as string;
        const activity = JSON.parse(serialized) as ActivityEntry;
        if (
          (!query.fileId || activity.files.some((f) => f.after.id === query.fileId)) &&
          (!query.actorId || activity.actor.id === query.actorId) &&
          (!query.source || activity.actor.source.kind === query.source) &&
          (!search ||
            `${activity.summary} ${activity.paths.join(' ')} ${activity.actor.name}`
              .toLocaleLowerCase()
              .includes(search))
        ) {
          const bytes = Buffer.byteLength(serialized);
          const nextBytes = totalBytes + bytes + (result.length ? 1 : 0);
          if (nextBytes > MAX_WIRE_JSON_BYTES) {
            if (!result.length) operationTooLarge();
            break;
          }
          result.push(activity);
          totalBytes = nextBytes;
        }
        if (result.length >= limit) break;
      }
      return result;
    }
    if (query.kind === 'preview-delete') {
      const file = this.live(query.fileId);
      const affected = this.files().filter(
        (f) =>
          f.id === file.id || (file.kind === 'directory' && f.path.startsWith(`${file.path}/`)),
      );
      return {
        revision: this.revision(),
        paths: affected.map((f) => f.path),
        files: affected.map((f) => ({
          before: f,
          after: {
            ...f,
            deleted: true,
            generation: f.generation + 1,
            revision: this.revision() + 1,
          },
        })),
        creates: 0,
        updates: 0,
        deletes: affected.length,
        bytes: affected.reduce((n, f) => n + f.size, 0),
      };
    }
    const handler = this.queries.get(query.kind);
    if (handler) return handler(query);
    fail('UNSUPPORTED_QUERY', 'This project query is unavailable.');
  }
  private referenced(files: ProjectFile[], metadata: SharedMetadata): Set<string> {
    const digests = new Set<string>();
    const add = (value: unknown): void => {
      if (validHash(value)) digests.add(value);
    };
    for (const f of files) {
      add(f.hash);
      add(f.stateHash);
    }
    for (const c of metadata.conflicts) {
      add(c.baseHash);
      add(c.localHash);
      add(c.remoteHash);
      add(c.localStateHash);
    }
    for (const c of metadata.checkpoints)
      for (const f of c.files) {
        add(f.hash);
        add(f.stateHash);
      }
    for (const t of metadata.trash) {
      add(t.file.hash);
      add(t.file.stateHash);
    }
    for (const claim of metadata.claims) add(claim.baseHash);
    return digests;
  }
  private snapshotRecord(files: ProjectFile[], metadata: SharedMetadata): SnapshotManifest {
    return {
      id: randomUUID(),
      projectId: this.projectId,
      name: this.meta<string>('name')!,
      revision: this.revision(),
      manifestHash: projectManifestHash(files),
      files,
      blobs: [...this.referenced(files, metadata)]
        .sort()
        .map((digest) => ({ hash: digest, size: this.blobSize(digest) })),
      metadata,
      createdAt: Date.now(),
    };
  }
  /** Common edits use SQL record lengths and bounded descriptor sizes. A full
   * snapshot (and its blob reads) is built only near the wire cap. */
  private assertSnapshotWireBudget(
    files: ProjectFile[],
    metadata: SharedMetadata,
    metadataBytes?: number,
  ): void {
    const catalog = this.db
      .prepare(
        "SELECT count(*) AS count,coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM project_files WHERE json_extract(record,'$.deleted')=0",
      )
      .get() as { count: number; bytes: number };
    const fileBytes = 2 + catalog.bytes + Math.max(0, catalog.count - 1);
    const references = this.referenced(files, metadata).size;
    const descriptorBytes = Buffer.byteLength(
      JSON.stringify({ hash: '0'.repeat(64), size: MAX_BLOB_BYTES }),
    );
    const skeleton = {
      id: '0'.repeat(36),
      projectId: this.projectId,
      name: this.meta<string>('name')!,
      revision: this.revision(),
      manifestHash: '0'.repeat(64),
      files: [],
      blobs: [],
      metadata: {},
      createdAt: Date.now(),
    };
    const fixedBytes =
      Buffer.byteLength(JSON.stringify(skeleton)) +
      fileBytes -
      2 +
      (metadataBytes ?? Buffer.byteLength(JSON.stringify(metadata))) -
      2;
    const descriptorCommas = Math.max(0, references - 1);
    const upperBound = fixedBytes + references * descriptorBytes + descriptorCommas;
    if (upperBound <= MAX_WIRE_JSON_BYTES) return;
    const minDescriptorBytes = Buffer.byteLength(JSON.stringify({ hash: '0'.repeat(64), size: 0 }));
    if (fixedBytes + references * minDescriptorBytes + descriptorCommas > MAX_WIRE_JSON_BYTES)
      operationTooLarge();
    wireBytes(JSON.stringify(this.snapshotRecord(files, metadata)));
  }
  snapshot(): SnapshotManifest {
    const snapshot = this.snapshotRecord(this.files(), this.metadata());
    wireBytes(JSON.stringify(snapshot));
    return snapshot;
  }
  eventsSince(revision: number, limit = 256): ProjectEvent[] {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.revision())
      fail('INVALID_REVISION', 'The requested history position is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      fail('INVALID_LIMIT', 'History pages must contain 1 to 1000 events.');
    const result: ProjectEvent[] = [];
    let totalBytes = 2;
    for (const row of this.db
      .prepare('SELECT event FROM project_journal WHERE revision>? ORDER BY revision LIMIT ?')
      .iterate(revision, limit)) {
      const serialized = row.event as string;
      const bytes = Buffer.byteLength(serialized);
      const nextBytes = totalBytes + bytes + (result.length ? 1 : 0);
      if (nextBytes > MAX_WIRE_JSON_BYTES) {
        if (!result.length) operationTooLarge();
        break;
      }
      result.push(JSON.parse(serialized) as ProjectEvent);
      totalBytes = nextBytes;
    }
    return result;
  }
  private importBlobs(blobs: BlobObject[]): void {
    for (const blob of blobs) {
      if (!validHash(blob.hash)) fail('INVALID_HASH', 'Invalid incoming blob digest.');
      const bytes = unb64(blob.data, MAX_BLOB_BYTES);
      if (hash(bytes) !== blob.hash)
        fail('BLOB_MISMATCH', 'Downloaded content failed its integrity check.');
      this.putBlob(bytes);
    }
  }
  installSnapshot(
    snapshot: SnapshotManifest,
    blobs: BlobObject[],
    afterInstall?: () => void,
  ): void {
    this.checkOpen();
    wireBytes(JSON.stringify(snapshot));
    if (this.mode !== 'replica')
      fail('REPLICA_REQUIRED', 'An authority cannot install a remote snapshot.');
    if (snapshot.projectId !== this.projectId)
      fail('PROJECT_MISMATCH', 'This snapshot belongs to another project.');
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      snapshot.files.length > MAX_ENTRIES ||
      snapshot.files.reduce((n, f) => n + f.size, 0) > MAX_PROJECT_BYTES ||
      projectManifestHash(snapshot.files) !== snapshot.manifestHash
    )
      fail('INVALID_SNAPSHOT', 'The snapshot manifest is inconsistent.');
    if (this.meta<boolean>('initialized') && snapshot.revision < this.revision())
      fail('STALE_SNAPSHOT', 'An older snapshot cannot replace the current catalog.');
    // First adoption accepts only an empty or content-identical workcopy. No remote bytes touch disk.
    if (!this.meta<boolean>('initialized')) {
      const scan = this.policy.scan();
      this.excluded = scan.excluded;
      for (const entry of scan.entries) {
        const wanted = snapshot.files.find((f) => f.path === entry.path && !f.deleted);
        if (
          !wanted ||
          (wanted.kind === 'directory') !== (entry.kind === 'directory') ||
          (entry.bytes && hash(entry.bytes) !== wanted.hash)
        )
          fail(
            'WORKCOPY_NOT_EMPTY',
            'The chosen folder contains files that do not match this project. Choose an empty workcopy.',
          );
      }
    }
    const previousPatterns = this.metadata().ignorePatterns;
    try {
      this.policy.refresh(snapshot.metadata.ignorePatterns);
      transaction(this.db, () => {
        this.importBlobs(blobs);
        const descriptors = new Map(snapshot.blobs.map((b) => [b.hash, b.size]));
        for (const digest of this.referenced(snapshot.files, snapshot.metadata))
          if (descriptors.get(digest) !== this.blobSize(digest))
            fail('BLOB_MISMATCH', 'Snapshot content descriptors are incomplete.');
        this.db.prepare('DELETE FROM project_files').run();
        const ids = new Set<string>();
        for (const file of snapshot.files) {
          this.validateFile(file);
          if (file.revision > snapshot.revision || file.deleted || ids.has(file.id))
            fail('INVALID_SNAPSHOT', 'Snapshot file identity or revision is invalid.');
          ids.add(file.id);
          this.saveFile(file);
        }
        for (const file of this.files()) this.ensurePath(file);
        this.setMeta('revision', snapshot.revision);
        this.setMeta('name', snapshot.name);
        this.setMeta('metadata', snapshot.metadata);
        this.setMeta('initialized', true);
        this.metadataInstaller?.(snapshot.metadata);
        afterInstall?.();
      });
    } catch (error) {
      this.policy.refresh(previousPatterns);
      throw error;
    }
    this.policy.refresh(snapshot.metadata.ignorePatterns);
    this.emitStatus();
  }
  ingest(event: ProjectEvent, blobs: BlobObject[], afterInstall?: () => void): void {
    this.checkOpen();
    const serialized = JSON.stringify(event);
    wireBytes(serialized, 2);
    if (this.mode !== 'replica')
      fail('REPLICA_REQUIRED', 'Only a joined workcopy ingests remote events.');
    if (event.revision <= this.revision()) {
      const prior = this.db
        .prepare('SELECT event FROM project_journal WHERE revision=?')
        .get(event.revision) as { event: string } | undefined;
      if (prior && stable(JSON.parse(prior.event)) !== stable(event))
        fail('EVENT_COLLISION', 'A committed revision has conflicting history.');
      return;
    }
    if (event.revision !== this.revision() + 1)
      fail('REVISION_GAP', 'Project events must arrive in order.');
    const previousPatterns = this.metadata().ignorePatterns;
    try {
      this.policy.refresh(event.metadata.ignorePatterns);
      transaction(this.db, () => {
        this.importBlobs(blobs);
        // Validate all previous records before staging moves, then validate the final catalog.
        for (const change of event.changes) {
          const previous = this.file(change.after.id) ?? null;
          // Live-only snapshots intentionally omit tombstones. A subsequent restore carries
          // that old tombstone in its immutable before record, which must predate our barrier.
          const omittedTombstone =
            previous === null &&
            change.before?.deleted &&
            change.before.id === change.after.id &&
            change.before.revision <= this.revision();
          if (!omittedTombstone && stable(previous) !== stable(change.before))
            fail('EVENT_BASE_MISMATCH', 'The event does not follow this catalog.');
          this.validateFile(change.after);
          if (change.after.revision !== event.revision)
            fail('INVALID_EVENT', 'The event file revision is invalid.');
        }
        for (const change of event.changes) this.saveFile(change.after);
        for (const file of this.files()) this.ensurePath(file);
        if (
          this.files().length > MAX_ENTRIES ||
          this.files().reduce((n, f) => n + f.size, 0) > MAX_PROJECT_BYTES ||
          this.manifestHash() !== event.manifestHash
        )
          fail('MANIFEST_MISMATCH', 'The event did not produce the expected manifest.');
        for (const digest of this.referenced(this.files(), event.metadata)) this.getBlob(digest);
        this.setMeta('revision', event.revision);
        const metadataJson = this.setMeta('metadata', event.metadata);
        this.metadataInstaller?.(event.metadata);
        this.assertSnapshotWireBudget(
          this.files(),
          event.metadata,
          Buffer.byteLength(metadataJson),
        );
        this.db.prepare('INSERT INTO project_journal VALUES (?,?)').run(event.revision, serialized);
        afterInstall?.();
      });
    } catch (error) {
      this.policy.refresh(previousPatterns);
      throw error;
    }
    this.policy.refresh(event.metadata.ignorePatterns);
    this.emit('change', clone(event));
    this.emitStatus();
  }
  private recordBaseline(file: ProjectFile): void {
    if (file.kind === 'directory') return;
    this.db
      .prepare(
        'INSERT INTO project_baselines VALUES (?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET path=excluded.path,hash=excluded.hash,revision=excluded.revision,generation=excluded.generation',
      )
      .run(file.id, file.path, file.hash, file.revision, file.generation);
    this.observe(file.path, file.hash);
  }
  adoptExternalBaseline(fileId: string): void {
    const file = this.live(fileId);
    if (file.kind === 'directory')
      fail('DIRECTORY_WRITE', 'An external edit claim requires a file.');
    const bytes = readBounded(this.policy.resolve(file.path), MAX_BLOB_BYTES);
    if (hash(bytes) !== file.hash)
      fail(
        'EXTERNAL_DIVERGED',
        'The file on disk differs from the project. Preserve it as a conflict before claiming.',
      );
    this.recordBaseline(file);
  }
  private observe(relative: string, signature: string): void {
    this.db
      .prepare(
        'INSERT INTO project_observed VALUES (?,?) ON CONFLICT(path) DO UPDATE SET signature=excluded.signature',
      )
      .run(relative, signature);
  }
  /** Reviewing an external conflict authorizes exactly the observed local bytes.
   * A newer save never inherits that authorization and continues to block CAS. */
  private prepareConflictProjection(conflictId: string): void {
    const conflict = this.metadata().conflicts.find(
      (entry) => entry.id === conflictId && entry.status === 'open',
    );
    if (!conflict?.fileId || conflict.actorId !== this.ownerId) return;
    const file = this.file(conflict.fileId);
    if (!file || file.kind === 'directory' || file.path !== conflict.path) return;
    const projection = this.db
      .prepare('SELECT * FROM project_projections WHERE file_id=?')
      .get(file.id) as unknown as ProjectionRow | undefined;
    if (!projection) return;
    try {
      const target = this.policy.resolve(file.path, { allowMissing: true });
      const actual = fs.existsSync(target) ? hash(readBounded(target, MAX_BLOB_BYTES)) : null;
      if (actual !== conflict.localHash) return;
      this.db
        .prepare(
          "UPDATE project_projections SET previous_path=?,previous_hash=?,state='pending',error=NULL,preserve_disk=0 WHERE file_id=?",
        )
        .run(file.path, actual, file.id);
    } catch {
      /* An unreadable, unsafe or newer disk version still blocks projection. */
    }
  }
  private seen(relative: string, signature: string): boolean {
    return (
      (
        this.db.prepare('SELECT signature FROM project_observed WHERE path=?').get(relative) as
          { signature: string } | undefined
      )?.signature === signature
    );
  }
  private externalConflict(
    file: ProjectFile | null,
    relative: string,
    bytes: Uint8Array | null,
    reason: string,
    actor: Actor,
  ): void {
    const signature = bytes ? hash(bytes) : 'missing';
    if (this.seen(relative, `conflict:${signature}`)) return;
    if (file)
      this.db
        .prepare("UPDATE project_projections SET state='blocked',error=? WHERE file_id=?")
        .run(reason, file.id);
    const handler = this.handlers.get('conflict-create');
    if (!handler) {
      if (bytes) this.putBlob(bytes);
      this.excluded.push({
        path: relative,
        reason: 'A recovery service is required to preserve this external conflict.',
      });
      return;
    }
    const baseline = file
      ? (this.db
          .prepare('SELECT * FROM project_baselines WHERE file_id=?')
          .get(file.id) as unknown as Baseline | undefined)
      : undefined;
    const command: ProjectCommand = {
      opId: randomUUID(),
      kind: 'conflict-create',
      fileId: file?.id ?? null,
      path: relative,
      reason,
      generation: file?.generation ?? 1,
      revision: file?.revision ?? this.revision(),
      baseHash: baseline?.hash ?? null,
      localData: bytes ? b64(bytes) : null,
      remoteHash: file && !file.deleted && file.kind !== 'directory' ? file.hash : null,
      source: actor.source,
    };
    handler(command, actor);
    this.observe(relative, `conflict:${signature}`);
    if (file)
      this.db
        .prepare("UPDATE project_projections SET state='blocked',error=? WHERE file_id=?")
        .run(reason, file.id);
  }
  private rescanInside(actor: Actor): Record<string, unknown> {
    const scan = this.policy.scan();
    this.excluded = scan.excluded;
    const entries = new Map(scan.entries.map((entry) => [entry.path, entry]));
    const live = this.files();
    const knownByPath = new Map(live.map((file) => [file.path, file]));
    let imported = 0;
    let changed = 0;
    for (const entry of scan.entries) {
      if (!this.policy.check(entry.path, entry.kind === 'directory').allowed) continue;
      const known = knownByPath.get(entry.path);
      if (!known) {
        const tombstone = this.files(true).find((file) => file.deleted && file.path === entry.path);
        if (tombstone) {
          this.externalConflict(
            tombstone,
            entry.path,
            entry.bytes ?? null,
            'A deleted file reappeared on disk.',
            actor,
          );
          continue;
        }
        const created = this.fromEntry(entry, this.nextRevision());
        this.stageFile(created, true);
        this.db
          .prepare('UPDATE project_projections SET previous_path=?,previous_hash=? WHERE file_id=?')
          .run(created.path, created.kind === 'directory' ? null : created.hash, created.id);
        this.recordBaseline(created);
        imported++;
        continue;
      }
      if (known.kind === 'directory' && entry.kind === 'directory') continue;
      if (known.kind !== entry.kind) {
        this.externalConflict(
          known,
          entry.path,
          entry.bytes ?? null,
          'The external file type changed.',
          actor,
        );
        continue;
      }
      if (!entry.bytes) continue;
      const signature = hash(entry.bytes);
      if (signature === known.hash) {
        this.observe(entry.path, signature);
        continue;
      }
      if (this.seen(entry.path, `conflict:${signature}`)) continue;
      const projected = this.db
        .prepare('SELECT * FROM project_projections WHERE file_id=?')
        .get(known.id) as unknown as ProjectionRow | undefined;
      if (projected?.state === 'pending' && signature === projected.previous_hash) continue;
      const baseline = this.db
        .prepare('SELECT * FROM project_baselines WHERE file_id=?')
        .get(known.id) as unknown as Baseline | undefined;
      if (
        !baseline ||
        baseline.hash !== known.hash ||
        baseline.generation !== known.generation ||
        baseline.path !== known.path
      ) {
        this.externalConflict(
          known,
          entry.path,
          entry.bytes,
          'The external save used a stale or unknown baseline.',
          actor,
        );
        continue;
      }
      try {
        this.current!.external = true;
        this.dispatch(
          {
            opId: randomUUID(),
            kind: 'write',
            fileId: known.id,
            generation: known.generation,
            baseRevision: known.revision,
            baseHash: known.hash,
            data: b64(entry.bytes),
            source: { kind: 'unknown' },
          },
          actor,
        );
        const updated = this.file(known.id)!;
        this.recordBaseline(updated);
        this.db
          .prepare('UPDATE project_projections SET previous_path=?,previous_hash=? WHERE file_id=?')
          .run(updated.path, updated.hash, updated.id);
        changed++;
      } catch (error) {
        if (
          !(error instanceof CairnError) ||
          ![
            'DIFF_LIMIT',
            'TEXT_FORMAT_CHANGED',
            'LINE_ENDING_MISMATCH',
            'CLAIM_CONFLICT',
            'CLAIM_REQUIRED',
            'FILE_CLAIMED',
            'STRICT_CLAIM',
          ].includes(error.code)
        )
          throw error;
        this.externalConflict(known, entry.path, entry.bytes, error.message, actor);
      } finally {
        this.current!.external = false;
      }
    }
    for (const known of live) {
      if (entries.has(known.path)) continue;
      const check = this.policy.check(known.path, known.kind === 'directory');
      if (!check.allowed) {
        this.stageFile({ ...known, deleted: true, generation: known.generation + 1 }, true);
        continue;
      }
      // An unreadable/oversize file is not an external deletion. Never infer from omission alone.
      try {
        const target = this.policy.resolve(known.path, { allowMissing: true });
        if (fs.existsSync(target)) continue;
      } catch {
        continue;
      }
      const projection = this.db
        .prepare('SELECT * FROM project_projections WHERE file_id=?')
        .get(known.id) as unknown as ProjectionRow | undefined;
      if (projection?.state === 'pending' && projection.previous_path !== known.path) continue;
      if (known.kind !== 'directory')
        this.externalConflict(
          known,
          known.path,
          null,
          'The shared file was removed externally.',
          actor,
        );
    }
    return { imported, changed };
  }
  scanExternal(actor?: Actor): void {
    if (this.closed || this.mode !== 'authority' || this.scanning) return;
    this.scanning = true;
    try {
      const scan = this.policy.scan();
      this.excluded = scan.excluded;
      const catalog = this.files();
      const entries = new Map(scan.entries.map((entry) => [entry.path, entry]));
      for (const file of catalog) {
        const exclusion = scan.excluded.find((entry) => entry.path === file.path);
        if (exclusion && this.policy.check(file.path, file.kind === 'directory').allowed)
          this.db
            .prepare("UPDATE project_projections SET state='blocked',error=? WHERE file_id=?")
            .run(exclusion.reason, file.id);
      }
      const needsImport = scan.entries.some((entry) => {
        const current = catalog.find((file) => file.path === entry.path);
        if (!current)
          return !this.seen(entry.path, `conflict:${entry.bytes ? hash(entry.bytes) : 'missing'}`);
        if (current.kind !== entry.kind)
          return !this.seen(entry.path, `conflict:${entry.bytes ? hash(entry.bytes) : 'missing'}`);
        if (
          !entry.bytes ||
          hash(entry.bytes) === current.hash ||
          this.seen(entry.path, `conflict:${hash(entry.bytes)}`)
        )
          return false;
        const projection = this.db
          .prepare('SELECT * FROM project_projections WHERE file_id=?')
          .get(current.id) as unknown as ProjectionRow | undefined;
        return !(projection?.state === 'pending' && hash(entry.bytes) === projection.previous_hash);
      });
      const needsRemoval = catalog.some((file) => {
        if (entries.has(file.path)) return false;
        if (!this.policy.check(file.path, file.kind === 'directory').allowed) return true;
        if (file.kind === 'directory' || this.seen(file.path, 'conflict:missing')) return false;
        const projection = this.db
          .prepare('SELECT * FROM project_projections WHERE file_id=?')
          .get(file.id) as unknown as ProjectionRow | undefined;
        if (projection?.state === 'pending' && projection.previous_path !== file.path) return false;
        try {
          return !fs.existsSync(this.policy.resolve(file.path, { allowMissing: true }));
        } catch {
          return false;
        }
      });
      if (needsImport || needsRemoval)
        this.apply(
          { opId: randomUUID(), kind: 'rescan' },
          actor ??
            this.externalActor ?? {
              id: this.ownerId,
              name: 'External editor',
              role: 'owner',
              source: { kind: 'unknown' },
            },
        );
      else this.emitStatus();
    } catch (error) {
      this.db
        .prepare(
          "UPDATE project_projections SET state='blocked',error=? WHERE state='applied' AND preserve_disk=0",
        )
        .run(publicError(error).message);
      this.emitSafeError(error);
      this.emitStatus();
    } finally {
      this.scanning = false;
    }
  }
  startWatching(): void {
    this.checkOpen();
    if (this.mode !== 'authority' || this.watcher) return;
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (target, stats) => {
        const relative = path.relative(this.root, target).split(path.sep).join('/');
        return !!relative && !this.policy.check(relative, stats?.isDirectory() ?? false).allowed;
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on('all', () => {
      if (this.closed) return;
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scanTimer = setTimeout(() => {
        this.scanTimer = undefined;
        this.scanExternal();
      }, 150);
    });
    this.watcher.on('error', (error) => this.emitSafeError(error));
    this.emitStatus();
  }
  stopWatching(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    void watcher?.close();
    if (!this.closed) this.emitStatus();
  }
  private scheduleProjection(): void {
    if (this.closed || !this.autoProject || this.projectionTask) return;
    this.projectionTask = setImmediate(() => {
      this.projectionTask = undefined;
      this.projectPending();
    });
  }
  projectPending(): void {
    if (this.closed || this.mode !== 'authority' || this.projecting) return;
    this.projecting = true;
    try {
      const rows = this.db
        .prepare("SELECT * FROM project_projections WHERE state<>'applied'")
        .all() as unknown as ProjectionRow[];
      const work = rows.map((row) => ({ row, file: JSON.parse(row.desired) as ProjectFile }));
      work.sort((a, b) => {
        const rank = (f: ProjectFile) =>
          f.deleted ? (f.kind === 'directory' ? 3 : 2) : f.kind === 'directory' ? 0 : 1;
        return (
          rank(a.file) - rank(b.file) ||
          (a.file.deleted
            ? b.file.path.length - a.file.path.length
            : a.file.path.length - b.file.path.length)
        );
      });
      const directoryCleanup: { row: ProjectionRow; file: ProjectFile }[] = [];
      for (const { row, file } of work) {
        if (row.preserve_disk) continue;
        if (this.projectionHold?.(file.id)) {
          this.db
            .prepare("UPDATE project_projections SET state='held',error=NULL WHERE file_id=?")
            .run(file.id);
          continue;
        }
        let result;
        if (file.deleted)
          result =
            file.kind === 'directory'
              ? removeEmptyDirectory(this.policy, row.previous_path ?? file.path)
              : removeProjected(
                  this.policy,
                  row.previous_path ?? file.path,
                  row.previous_hash,
                  this.recoveryDir,
                );
        else if (file.kind === 'directory') {
          result = mkdirProjected(this.policy, file.path);
          if (result.state === 'applied' && row.previous_path && row.previous_path !== file.path)
            directoryCleanup.push({ row, file });
        } else
          result = projectBytes(this.policy, {
            path: file.path,
            bytes: this.getBlob(file.hash),
            expectedHash: row.previous_hash,
            recoveryDir: this.recoveryDir,
            ...(row.previous_path && row.previous_path !== file.path
              ? { previousPath: row.previous_path }
              : {}),
          });
        this.db
          .prepare(
            'UPDATE project_projections SET state=?,error=?,previous_path=?,previous_hash=? WHERE file_id=?',
          )
          .run(
            result.state,
            result.error ?? null,
            result.state === 'applied' ? file.path : row.previous_path,
            result.state === 'applied'
              ? file.deleted || file.kind === 'directory'
                ? null
                : file.hash
              : row.previous_hash,
            file.id,
          );
        if (result.state === 'applied' && !file.deleted)
          this.observe(file.path, file.kind === 'directory' ? 'directory' : file.hash);
      }
      for (const { row, file } of directoryCleanup.sort(
        (a, b) => b.row.previous_path!.length - a.row.previous_path!.length,
      )) {
        const result = removeEmptyDirectory(this.policy, row.previous_path!);
        if (result.state !== 'applied')
          this.db
            .prepare(
              'UPDATE project_projections SET state=?,error=?,previous_path=? WHERE file_id=?',
            )
            .run(result.state, result.error ?? null, row.previous_path, file.id);
      }
    } catch (error) {
      this.emitSafeError(error);
    } finally {
      this.projecting = false;
      this.emitStatus();
    }
  }
  retryProjection(): void {
    this.projectPending();
  }
  private emitStatus(): void {
    if (!this.closed) this.emit('status', this.status());
  }
  private emitSafeError(error: unknown): void {
    if (this.listenerCount('error')) this.emit('error', publicError(error));
    else this.emit('diagnostic', publicError(error));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    if (this.projectionTask) clearImmediate(this.projectionTask);
    this.emit('close');
    try {
      this.db.close();
    } finally {
      this.release();
    }
  }
}
