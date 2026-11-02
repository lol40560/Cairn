import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import * as Y from 'yjs';
import { modifyAwarenessUpdate } from 'y-protocols/awareness';
import {
  CairnError,
  b64,
  checkLineEnding,
  hash,
  publicError,
  readBounded,
  textBytes,
  transaction,
  unb64,
} from '../common.js';
import {
  MAX_UPDATE_BYTES,
  type ClientSnapshot,
  type Projection,
  type Role,
} from '../../shared/types.js';
import type {
  ChangeSource,
  CommandInput,
  ConflictEntry,
  ProjectCommand,
  ProjectEvent,
  ProjectFile,
  ProjectionRecord,
  ReplicaStatus,
  SharedMetadata,
  SnapshotManifest,
  StoreQuery,
  TeamInvite,
  TeamStatus,
  TransferState,
} from '../../shared/project.js';
import {
  MAX_BLOB_BYTES,
  MAX_ENTRIES,
  MAX_PROJECT_BYTES,
  mkdirProjected,
  projectBytes,
  removeEmptyDirectory,
  removeProjected,
} from './filesystem.js';
import { ProjectStore } from './store.js';
import { RecoveryService } from './recovery.js';
import { TeamConnection } from './transport.js';

interface LocalRow {
  file_id: string;
  generation: number;
  state: Uint8Array | null;
  content_hash: string;
  disk_hash: string | null;
  disk_path: string;
  baseline_hash: string | null;
  baseline_revision: number;
  observed_hash: string | null;
  projection: Projection | 'held';
  error: string | null;
}
interface OutboxRow {
  seq: number;
  op_id: string;
  command: string;
  file_id: string | null;
  generation: number | null;
  state: 'pending' | 'rejected';
  reason: string | null;
  external: number;
}
type Awareness = { fileId: string; generation: number; update: string };
const emptyTransfer = (): TransferState => ({
  stage: 'idle',
  doneBytes: 0,
  totalBytes: 0,
  doneFiles: 0,
  totalFiles: 0,
});
const digest = /^[a-f0-9]{64}$/;

function document(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content');
  try {
    Y.applyUpdate(doc, state);
    validateDocument(doc);
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
function validateDocument(doc: Y.Doc, ending?: 'lf' | 'crlf' | null): void {
  if ([...doc.share.keys()].some((key) => key !== 'content'))
    throw new CairnError('INVALID_DOCUMENT', 'Only plain text documents are editable.');
  const text = doc.getText('content');
  for (const part of text.toDelta())
    if (typeof part.insert !== 'string' || (part.attributes && Object.keys(part.attributes).length))
      throw new CairnError('INVALID_DOCUMENT', 'Only plain text documents are editable.');
  textBytes(text.toString());
  if (ending) checkLineEnding(text.toString(), ending);
  if (Y.encodeStateAsUpdate(doc).byteLength > MAX_UPDATE_BYTES)
    throw new CairnError('STATE_LIMIT', 'The document history exceeds the supported limit.');
}
function fileHashes(files: ProjectFile[]): string[] {
  return files.flatMap((file) =>
    file.kind === 'directory' ? [] : [file.hash, ...(file.stateHash ? [file.stateHash] : [])],
  );
}
/** Recovery references are immutable blobs too; download them before installing metadata. */
function metadataHashes(metadata: SharedMetadata): string[] {
  return [
    ...metadata.conflicts.flatMap((c) =>
      [c.baseHash, c.localHash, c.remoteHash, c.localStateHash].filter((v): v is string => !!v),
    ),
    ...metadata.checkpoints.flatMap((c) => fileHashes(c.files)),
    ...metadata.trash.flatMap((t) => fileHashes([t.file])),
  ];
}

/** A replica is both a durable offline editing cache and the sole writer of its workcopy. */
export class ProjectReplica extends EventEmitter {
  readonly store: ProjectStore;
  readonly clientId: string;
  private readonly invite: TeamInvite;
  private name: string;
  private readonly recovery: RecoveryService;
  private readonly recoveryDir: string;
  private role: Role;
  private connection: ReplicaStatus['connection'] = 'offline';
  private team: TeamStatus | null = null;
  private transfer: TransferState = emptyTransfer();
  private lastProgressEmission = Number.NEGATIVE_INFINITY;
  private initialized = false;
  private ready = false;
  private closed = false;
  private epoch = 0;
  private wantsConnection = false;
  private link: TeamConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private serial: Promise<void> = Promise.resolve();
  private buffered: ProjectEvent[] = [];
  private inFlight: string | null = null;
  private retryTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private retryDelay = 500;
  private watcher: FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private watching = false;
  private source: ChangeSource = { kind: 'unknown' };
  private selected: string | undefined;
  private lastAwareness: Awareness | undefined;
  private lastError: { code: string; message: string } | undefined;
  private confirmScheduled = false;
  private confirmationTimer: NodeJS.Timeout | undefined;
  private confirmationDelay = 25;
  private lastConfirmedKey = '';
  private heldFiles = new Set<string>();
  private waiters = new Map<
    string,
    { resolve: (event: ProjectEvent) => void; reject: (error: Error) => void }
  >();

  constructor(options: { root: string; invite: TeamInvite; name: string; watch?: boolean }) {
    super();
    this.invite = { ...options.invite };
    this.name = options.name.trim().slice(0, 60) || 'Member';
    this.role = options.invite.role;
    this.store = new ProjectStore({
      root: options.root,
      mode: 'replica',
      projectId: options.invite.projectId,
      name: options.invite.projectName,
      autoProject: false,
    });
    try {
      this.recovery = new RecoveryService(this.store);
      this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS replica_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_docs (file_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state BLOB,content_hash TEXT NOT NULL,disk_hash TEXT,disk_path TEXT NOT NULL,baseline_hash TEXT,baseline_revision INTEGER NOT NULL DEFAULT -1,observed_hash TEXT,projection TEXT NOT NULL DEFAULT 'pending',error TEXT);
        CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT UNIQUE NOT NULL,command TEXT NOT NULL,file_id TEXT,generation INTEGER,state TEXT NOT NULL DEFAULT 'pending',reason TEXT,external INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS receipts (op_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,manifest_hash TEXT NOT NULL,event_hash TEXT NOT NULL,received_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS local_conflicts (id TEXT PRIMARY KEY,body TEXT NOT NULL,observed_key TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS command_failures (op_id TEXT PRIMARY KEY,command TEXT NOT NULL,reason TEXT NOT NULL,failed_at INTEGER NOT NULL);
      `);
      const known = this.setting('identity');
      const identity = JSON.stringify({
        projectId: this.invite.projectId,
        teamId: this.invite.teamId,
        memberId: this.invite.memberId,
      });
      if (known && known !== identity)
        throw new CairnError(
          'IDENTITY_MISMATCH',
          'This workcopy belongs to a different project or member.',
        );
      this.clientId = this.setting('clientId') ?? randomUUID();
      transaction(this.store.db, () => {
        this.setSetting('identity', identity);
        this.setSetting('clientId', this.clientId);
        const rejected = this.store.db
          .prepare("SELECT * FROM outbox WHERE state='rejected'")
          .all() as unknown as OutboxRow[];
        for (const row of rejected) {
          let command: ProjectCommand;
          try {
            command = JSON.parse(row.command) as ProjectCommand;
          } catch {
            continue;
          }
          if (this.isNonDraftCommand(command, row.external !== 0))
            this.archiveCommandFailure(row, row.reason ?? 'COMMAND_REJECTED');
        }
      });
      this.initialized = this.setting('initialized') === 'true';
      this.recoveryDir = path.join(this.store.dataDir, 'replica-recovery');
      if (
        fs.existsSync(this.recoveryDir) &&
        (!fs.lstatSync(this.recoveryDir).isDirectory() ||
          fs.lstatSync(this.recoveryDir).isSymbolicLink())
      )
        throw new CairnError('UNSAFE_PATH', 'The recovery directory is not an ordinary directory.');
      fs.mkdirSync(this.recoveryDir, { recursive: true, mode: 0o700 });
      this.refreshHolds();
      if (this.initialized) {
        this.inspectWorkcopy();
        this.projectAll();
      }
      this.setWatching(options.watch ?? true);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  connect(): Promise<void> {
    this.assertOpen();
    this.wantsConnection = true;
    if (this.ready) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const attempt = ++this.epoch;
    const link = new TeamConnection({
      invite: this.invite,
      clientId: this.clientId,
      name: this.name,
    });
    this.link = link;
    this.buffered = [];
    this.connection = 'connecting';
    this.transfer = { ...emptyTransfer(), stage: 'authenticating' };
    this.lastError = undefined;
    link.on('event', (event: ProjectEvent) => {
      if (!this.current(attempt, link)) return;
      this.lastConfirmedKey = '';
      if (!this.ready) {
        this.buffered.push(event);
        return;
      }
      void this.enqueue(async () => {
        await this.acceptLive(event, attempt, link);
      }).catch((error) => this.fail(error, attempt));
    });
    link.on('status', (status: TeamStatus) => {
      if (!this.current(attempt, link)) return;
      if (status.projectId !== this.invite.projectId || status.teamId !== this.invite.teamId) {
        this.fail(
          new CairnError('IDENTITY_MISMATCH', 'The connected project identity changed.'),
          attempt,
        );
        return;
      }
      this.team = status;
      const self = status.peers.find((peer) => peer.clientId === this.clientId);
      if (self && self.role !== this.role) {
        this.role = self.role;
        if (this.role === 'viewer') this.rejectAll('READ_ONLY', 'Your access is now read-only.');
      }
      this.emitState();
    });
    link.on('awareness', (value: Awareness) => {
      if (this.current(attempt, link)) this.emit('awareness', value);
    });
    link.on('disconnect', (error: unknown) => {
      if (this.current(attempt, link)) this.fail(error, attempt);
    });
    this.emitState();
    const operation = this.initialize(attempt, link).catch((error) => {
      if (this.current(attempt, link)) this.fail(error, attempt);
      throw error;
    });
    this.connectPromise = operation;
    void operation
      .finally(() => {
        if (this.connectPromise === operation) this.connectPromise = null;
      })
      .catch(() => {});
    return operation;
  }

  disconnect(): void {
    if (this.closed) return;
    this.wantsConnection = false;
    this.dropConnection();
    this.connection = 'offline';
    this.team = null;
    this.emitState();
  }
  async setName(name: string): Promise<void> {
    this.assertOpen();
    const next = typeof name === 'string' ? name.trim() : '';
    if (!next || next.length > 60)
      throw new CairnError('INVALID_NAME', 'Choose a display name between 1 and 60 characters.');
    if (next === this.name) return;
    const reconnect = this.wantsConnection;
    this.name = next;
    if (!reconnect) {
      this.emitState();
      return;
    }
    // Authentication owns the public peer/activity/awareness name. Reuse the
    // identity and durable queue while invalidating every old connection callback.
    this.disconnect();
    await this.connect();
  }
  cancel(): void {
    this.disconnect();
    this.transfer = { ...this.transfer, stage: 'cancelled' };
    this.emitState();
  }
  close(): void {
    if (this.closed) return;
    this.disconnect();
    this.setWatching(false);
    this.closed = true;
    for (const waiter of this.waiters.values())
      waiter.reject(
        new CairnError('CLIENT_CLOSED', 'The project was closed; queued changes remain saved.'),
      );
    this.waiters.clear();
    this.store.close();
    this.removeAllListeners();
  }
  status(): ReplicaStatus {
    const counts = this.counts();
    const metadata = this.metadata();
    const projections = this.projections();
    const clean =
      counts.pending === 0 &&
      counts.rejected === 0 &&
      !metadata.conflicts.some((c) => c.status === 'open') &&
      projections.every((p) => p.state === 'applied');
    const revision = this.store.revision();
    const manifestHash = this.store.manifestHash();
    return {
      projectId: this.invite.projectId,
      clientId: this.clientId,
      actorId: this.invite.memberId,
      name: this.name,
      role: this.role,
      root: this.store.root,
      connection: this.connection,
      initialized: this.initialized,
      ...counts,
      revision,
      manifestHash,
      confirmedRevision:
        this.ready &&
        clean &&
        this.team?.revision === revision &&
        this.team.manifestHash === manifestHash &&
        this.team.confirmedRevision === revision
          ? revision
          : null,
      team: this.team,
      transfer: { ...this.transfer },
      files: this.store.files(),
      projections,
      metadata,
      error: this.lastError,
      watching: this.watching,
    };
  }
  select(fileId: string): void {
    this.assertFile(fileId);
    if (this.lastAwareness && this.lastAwareness.fileId !== fileId && this.ready && this.link) {
      this.link.awareness({
        ...this.lastAwareness,
        update: b64(modifyAwarenessUpdate(unb64(this.lastAwareness.update, 32 * 1024), () => null)),
      });
      this.lastAwareness = undefined;
    }
    this.selected = fileId;
    this.emitState();
  }
  editorSnapshot(fileId: string, precomputedStatus?: ReplicaStatus): ClientSnapshot {
    const file = this.assertFile(fileId);
    const row = this.local(fileId);
    if (file.kind !== 'text' || !row?.state)
      throw new CairnError(
        'NOT_TEXT',
        'This file is transferred as binary and cannot be edited as text.',
      );
    const doc = document(row.state);
    let text: string;
    try {
      text = doc.getText('content').toString();
    } finally {
      doc.destroy();
    }
    const status = precomputedStatus ?? this.status();
    return {
      connection: status.connection,
      error: status.error,
      initialized: this.initialized,
      clientId: this.clientId,
      name: this.name,
      role: this.role,
      projectId: this.invite.projectId,
      fileId,
      generation: file.generation,
      fileName: file.path,
      lineEnding: file.lineEnding ?? 'lf',
      text,
      state: b64(row.state),
      pending: this.countFor(fileId, 'pending'),
      rejected: this.countFor(fileId, 'rejected'),
      localSaved: true,
      serverRevision: file.revision,
      serverHash: file.hash,
      serverProjection: 'applied',
      localProjection: row.projection === 'held' ? 'pending' : row.projection,
      peers:
        status.team?.peers.map((p) => ({
          clientId: p.clientId,
          name: p.name,
          role: p.role,
          appliedRevision: p.appliedRevision,
          projection: p.projection,
        })) ?? [],
      confirmedRevision: status.confirmedRevision,
      directory: this.store.root,
    };
  }

  applyLocalUpdate(fileId: string, generation: number, update: Uint8Array): ClientSnapshot {
    this.assertOpen();
    this.assertEditable();
    const file = this.assertFile(fileId);
    const row = this.local(fileId);
    if (!this.initialized || file.kind !== 'text' || !row?.state)
      throw new CairnError('NOT_INITIALIZED', 'Download this text file before editing it.');
    if (generation !== file.generation || generation !== row.generation)
      throw new CairnError(
        'STALE_GENERATION',
        'This document was restored or replaced. Reopen its current version.',
      );
    if (!(update instanceof Uint8Array) || update.byteLength > MAX_UPDATE_BYTES)
      throw new CairnError('SIZE_LIMIT', 'The update exceeds the supported limit.');
    const candidate = document(row.state);
    try {
      Y.applyUpdate(candidate, update, 'local');
      try {
        validateDocument(candidate, file.lineEnding);
      } catch (error) {
        transaction(this.store.db, () =>
          this.preserveConflict(
            file,
            row,
            publicError(error).code,
            Buffer.from(candidate.getText('content').toString()),
            Y.encodeStateAsUpdate(candidate),
          ),
        );
        this.emitState();
        throw error;
      }
      const state = Y.encodeStateAsUpdate(candidate);
      const bytes = Buffer.from(candidate.getText('content').toString());
      if (Buffer.from(state).equals(Buffer.from(row.state))) return this.editorSnapshot(fileId);
      const command: ProjectCommand = {
        opId: randomUUID(),
        kind: 'text',
        fileId,
        generation,
        update: b64(update),
        source: { kind: 'app' },
      };
      transaction(this.store.db, () => {
        const contentHash = this.store.putBlob(bytes);
        this.store.putBlob(state);
        this.store.db
          .prepare(
            "UPDATE local_docs SET state=?,content_hash=?,projection='pending',error=NULL WHERE file_id=?",
          )
          .run(state, contentHash, fileId);
        this.persistCommand(command, false);
      });
      this.lastConfirmedKey = '';
      this.projectAll();
      this.emitState();
      this.flush();
      this.confirm();
      return this.editorSnapshot(fileId);
    } finally {
      candidate.destroy();
    }
  }

  async command(input: CommandInput): Promise<ProjectEvent> {
    this.assertOpen();
    this.assertEditable();
    if (!this.ready)
      throw new CairnError(
        'OFFLINE_COMMAND',
        'Connect before changing project structure or shared recovery records.',
      );
    if (input.kind === 'conflict-resolve' && this.localConflict(input.conflictId))
      return this.resolveLocal(input);
    if (input.kind === 'text') {
      const before = Number(
        this.store.db.prepare('SELECT coalesce(max(seq),0) seq FROM outbox').get()!.seq,
      );
      this.applyLocalUpdate(input.fileId, input.generation, unb64(input.update));
      const row = this.store.db
        .prepare('SELECT op_id FROM outbox WHERE seq>? ORDER BY seq DESC LIMIT 1')
        .get(before) as { op_id: string } | undefined;
      if (row)
        return new Promise<ProjectEvent>((resolve, reject) =>
          this.waiters.set(row.op_id, { resolve, reject }),
        );
    }
    const command = { ...input, opId: randomUUID() } as ProjectCommand;
    return this.queueCommand(command, false);
  }
  async query(query: StoreQuery): Promise<unknown> {
    this.assertOpen();
    if (query.kind === 'metadata') return this.metadata();
    if (query.kind === 'conflicts') return this.metadata().conflicts;
    // Initial snapshots contain the current catalog, not the earlier activity journal.
    if (query.kind === 'activity' && this.ready && this.link) {
      const { link, attempt } = this.online();
      const result = await link.request<unknown>('query', { query });
      this.guard(attempt, link);
      return result;
    }
    // Offline activity is limited to events this workcopy has received.
    return this.store.query(query);
  }
  async blob(blobHash: string): Promise<Uint8Array> {
    this.assertOpen();
    if (this.store.hasBlob(blobHash)) return this.store.getBlob(blobHash);
    const { link, attempt } = this.online();
    await this.downloadBlob(blobHash, undefined, attempt, link, false);
    return this.store.getBlob(blobHash);
  }
  async snapshot(): Promise<SnapshotManifest> {
    this.assertOpen();
    if (!this.initialized)
      throw new CairnError('NOT_INITIALIZED', 'The project download is incomplete.');
    return this.store.snapshot();
  }
  retryProjection(): void {
    this.assertOpen();
    this.inspectWorkcopy();
    this.projectAll();
    this.emitState();
    this.confirm();
  }
  setWatching(enabled: boolean): void {
    if (this.closed || enabled === this.watching) return;
    this.watching = enabled;
    if (!enabled) {
      void this.watcher?.close();
      this.watcher = undefined;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
      return;
    }
    this.watcher = watch(this.store.root, {
      ignoreInitial: true,
      ignored: (entry: string, stats?: fs.Stats) => {
        const relative = path.relative(this.store.root, entry).split(path.sep).join('/');
        return relative
          ? !this.store.policy.check(relative, stats?.isDirectory() ?? false).allowed
          : false;
      },
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
    });
    this.watcher.on('all', () => {
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = undefined;
        if (!this.closed) {
          this.inspectWorkcopy();
          this.emitState();
          this.confirm();
        }
      }, 100);
    });
    this.watcher.on('error', () => {
      if (!this.closed) {
        this.lastError = {
          code: 'WATCH_FAILED',
          message:
            'External file monitoring stopped. Reopen the project or retry after checking folder access.',
        };
        this.emitState();
      }
    });
  }
  setSource(source: ChangeSource): void {
    if (!['unknown', 'external', 'declared-ai', 'app', 'recovery', 'system'].includes(source.kind))
      throw new CairnError('INVALID_SOURCE', 'Unknown change source.');
    this.source = {
      kind: source.kind,
      ...(source.tool ? { tool: source.tool.slice(0, 120) } : {}),
    };
  }
  awareness(envelope: Awareness): void {
    if (!this.ready || !this.link) return;
    const file = this.store.file(envelope.fileId);
    if (!file || file.deleted || file.generation !== envelope.generation) return;
    unb64(envelope.update, 32 * 1024);
    this.lastAwareness = { ...envelope };
    this.link.awareness(envelope);
  }

  private async initialize(attempt: number, link: TeamConnection): Promise<void> {
    if (this.initialized) this.inspectWorkcopy();
    const authenticated = await link.connect();
    this.guard(attempt, link);
    this.role = authenticated.role;
    this.team = authenticated.status;
    if (this.team.projectId !== this.invite.projectId || this.team.teamId !== this.invite.teamId)
      throw new CairnError(
        'IDENTITY_MISMATCH',
        'The connected project identity differs from this invitation.',
      );
    this.transfer.stage = 'manifest';
    this.emitState();
    const manifest = await link.request<SnapshotManifest>('snapshot', {});
    this.guard(attempt, link);
    if (
      manifest.projectId !== this.invite.projectId ||
      !Array.isArray(manifest.blobs) ||
      manifest.files.length > MAX_ENTRIES ||
      manifest.blobs.length > MAX_ENTRIES * 20
    )
      throw new CairnError(
        'INVALID_SNAPSHOT',
        'The project manifest is invalid or exceeds the supported limit.',
      );
    if (manifest.revision < this.store.revision())
      throw new CairnError(
        'STALE_SERVER',
        'The server is older than this verified workcopy. Local changes were preserved.',
      );
    const descriptors = new Map<string, number>();
    let total = 0;
    for (const blob of manifest.blobs) {
      if (
        !digest.test(blob.hash) ||
        !Number.isSafeInteger(blob.size) ||
        blob.size < 0 ||
        blob.size > MAX_BLOB_BYTES
      )
        throw new CairnError('INVALID_BLOB', 'The project contains an invalid blob descriptor.');
      if (!descriptors.has(blob.hash)) {
        descriptors.set(blob.hash, blob.size);
        total += blob.size;
      }
    }
    if (total > MAX_PROJECT_BYTES * 20)
      throw new CairnError(
        'SIZE_LIMIT',
        'The project and recovery download exceeds the supported limit.',
      );
    for (const h of [...fileHashes(manifest.files), ...metadataHashes(manifest.metadata)])
      if (!descriptors.has(h))
        throw new CairnError('INVALID_SNAPSHOT', 'The manifest omitted required content.');
    this.transfer = {
      stage: 'downloading',
      doneBytes: 0,
      totalBytes: total,
      doneFiles: 0,
      totalFiles: descriptors.size,
    };
    this.lastProgressEmission = performance.now();
    this.emitState();
    for (const [h, size] of descriptors) {
      await this.downloadBlob(h, size, attempt, link, true);
      this.guard(attempt, link);
      this.transfer.doneFiles++;
      this.emitTransferProgress();
    }
    this.guard(attempt, link);
    this.store.installSnapshot(manifest, [], () => this.mergeCatalog());
    this.transfer.stage = 'catching-up';
    this.emitState();
    const barrier = await link.request<{ revision: number; manifestHash: string }>('barrier', {});
    this.guard(attempt, link);
    await this.catchUp(barrier.revision, attempt, link);
    this.transfer.stage = 'verifying';
    this.emitState();
    if (
      this.store.revision() !== barrier.revision ||
      this.store.manifestHash() !== barrier.manifestHash
    )
      throw new CairnError(
        'MANIFEST_MISMATCH',
        'The downloaded project did not match its verified barrier.',
      );
    transaction(this.store.db, () => this.setSetting('initialized', 'true'));
    this.initialized = true;
    this.ready = true;
    this.connection = 'online';
    this.retryDelay = 500;
    this.transfer.stage = 'ready';
    this.refreshHolds();
    this.inspectWorkcopy();
    this.projectAll();
    this.emitState();
    const pending = this.buffered.splice(0).sort((a, b) => a.revision - b.revision);
    await this.enqueue(async () => {
      for (const event of pending) {
        this.guard(attempt, link);
        await this.acceptLive(event, attempt, link);
      }
    });
    this.guard(attempt, link);
    this.flush();
    this.confirm();
  }

  private async downloadBlob(
    blobHash: string,
    size: number | undefined,
    attempt: number,
    link: TeamConnection,
    progress: boolean,
  ): Promise<void> {
    if (!digest.test(blobHash))
      throw new CairnError('INVALID_HASH', 'The content hash is invalid.');
    if (this.store.hasBlob(blobHash)) {
      const bytes = this.store.getBlob(blobHash);
      if (size !== undefined && bytes.byteLength !== size)
        throw new CairnError('INVALID_BLOB', 'Cached content has an unexpected length.');
      if (progress) this.transfer.doneBytes += bytes.byteLength;
      return;
    }
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let total = size;
    do {
      const chunk = await link.request<{
        hash: string;
        offset: number;
        total: number;
        data: string;
      }>('blob', { hash: blobHash, offset, length: 256 * 1024 });
      this.guard(attempt, link);
      if (
        chunk.hash !== blobHash ||
        chunk.offset !== offset ||
        !Number.isSafeInteger(chunk.total) ||
        chunk.total < 0 ||
        chunk.total > MAX_BLOB_BYTES ||
        (total !== undefined && total !== chunk.total)
      )
        throw new CairnError('INVALID_BLOB', 'The content chunk did not match the requested blob.');
      total = chunk.total;
      const bytes = unb64(chunk.data, 256 * 1024);
      if (offset + bytes.byteLength > total || (!bytes.byteLength && offset < total))
        throw new CairnError('INVALID_BLOB', 'The content chunk was truncated.');
      chunks.push(bytes);
      offset += bytes.byteLength;
      if (progress) {
        this.transfer.doneBytes += bytes.byteLength;
        this.emitTransferProgress();
      }
    } while (total === undefined || offset < total);
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== blobHash)
      throw new CairnError('BLOB_HASH_MISMATCH', 'The downloaded content did not match its hash.');
    this.guard(attempt, link);
    this.store.putBlob(bytes);
  }
  private async ensureEventBlobs(
    event: ProjectEvent,
    attempt: number,
    link: TeamConnection,
  ): Promise<void> {
    const hashes = new Set([
      ...fileHashes(event.changes.flatMap((c) => [c.after, ...(c.before ? [c.before] : [])])),
      ...metadataHashes(event.metadata),
    ]);
    for (const h of hashes) await this.downloadBlob(h, undefined, attempt, link, false);
  }
  private async catchUp(target: number, attempt: number, link: TeamConnection): Promise<void> {
    if (!Number.isSafeInteger(target) || target < this.store.revision())
      throw new CairnError('INVALID_BARRIER', 'The project barrier moved backwards.');
    while (this.store.revision() < target) {
      const before = this.store.revision();
      const events = await link.request<ProjectEvent[]>('events', {
        after: this.store.revision(),
        limit: 256,
      });
      this.guard(attempt, link);
      if (!Array.isArray(events) || !events.length)
        throw new CairnError(
          'MISSING_EVENTS',
          'The server did not provide the required project history.',
        );
      for (const event of events) {
        if (event.revision > target) break;
        await this.ingest(event, attempt, link);
      }
      if (events[0].revision > target)
        throw new CairnError('MISSING_EVENTS', 'The project history skipped the captured barrier.');
      if (this.store.revision() === before)
        throw new CairnError(
          'MISSING_EVENTS',
          'The project history made no progress toward the captured barrier.',
        );
    }
  }
  private async ingest(event: ProjectEvent, attempt: number, link: TeamConnection): Promise<void> {
    this.guard(attempt, link);
    if (event.revision <= this.store.revision()) return;
    if (event.revision !== this.store.revision() + 1)
      throw new CairnError('EVENT_GAP', 'A project update is missing.');
    await this.ensureEventBlobs(event, attempt, link);
    this.guard(attempt, link);
    this.store.ingest(event, [], () => this.mergeCatalog(event));
    this.lastConfirmedKey = '';
  }
  private async acceptLive(
    event: ProjectEvent,
    attempt: number,
    link: TeamConnection,
  ): Promise<void> {
    this.guard(attempt, link);
    if (event.revision > this.store.revision() + 1)
      await this.catchUp(event.revision - 1, attempt, link);
    await this.ingest(event, attempt, link);
    this.refreshHolds();
    this.projectAll();
    this.emitState();
    this.confirm();
  }

  /** Called only by Store's transaction callback: catalog and pending Yjs state never split. */
  private mergeCatalog(event?: ProjectEvent): void {
    const files = this.store.files(true);
    const seen = new Set(files.map((f) => f.id));
    for (const file of files) {
      const local = this.local(file.id);
      let state: Uint8Array | null = null;
      let contentHash = file.hash;
      const pending = this.pendingDocuments(file.id, event?.opId);
      if (
        local &&
        (file.deleted ||
          file.generation !== local.generation ||
          (file.kind === 'text') !== !!local.state) &&
        pending.length
      ) {
        const reason = file.deleted ? 'REMOTE_DELETION' : 'GENERATION_CHANGED';
        if (pending.some((command) => command.kind === 'text'))
          this.preserveConflict(file, local, reason);
        for (const command of pending) {
          if (command.kind === 'write')
            this.preserveConflict(file, local, reason, unb64(command.data, MAX_BLOB_BYTES), null);
          this.store.db
            .prepare("UPDATE outbox SET state='rejected',reason=? WHERE op_id=?")
            .run(reason, command.opId);
        }
      }
      if (file.kind === 'text' && !file.deleted) {
        if (!file.stateHash)
          throw new CairnError(
            'INVALID_DOCUMENT',
            'A text file is missing its binary document state.',
          );
        const doc = document(this.store.getBlob(file.stateHash));
        try {
          validateDocument(doc, file.lineEnding);
          if (hash(doc.getText('content').toString()) !== file.hash)
            throw new CairnError(
              'STATE_HASH_MISMATCH',
              'The document state does not match its content.',
            );
          if (
            local?.state &&
            local.generation === file.generation &&
            this.countFor(file.id, 'pending')
          )
            Y.applyUpdate(doc, local.state, 'pending');
          validateDocument(doc, file.lineEnding);
          state = Y.encodeStateAsUpdate(doc);
          contentHash = this.store.putBlob(Buffer.from(doc.getText('content').toString()));
          this.store.putBlob(state);
        } finally {
          doc.destroy();
        }
      }
      let initialDisk: string | null = null;
      if (!local && !file.deleted && file.kind !== 'directory') {
        const bytes = this.readDisk(file.path);
        if (bytes && hash(bytes) === file.hash) initialDisk = file.hash;
      }
      this.store.db
        .prepare(
          `INSERT INTO local_docs(file_id,generation,state,content_hash,disk_hash,disk_path,baseline_hash,baseline_revision,projection)
        VALUES(?,?,?,?,?,?,?,?, 'pending') ON CONFLICT(file_id) DO UPDATE SET generation=excluded.generation,state=excluded.state,content_hash=excluded.content_hash,projection=CASE WHEN local_docs.projection='blocked' THEN 'blocked' ELSE 'pending' END,error=NULL`,
        )
        .run(
          file.id,
          file.generation,
          state,
          contentHash,
          local?.disk_hash ?? initialDisk,
          local?.disk_path ?? file.path,
          local?.baseline_hash ?? file.hash,
          local?.baseline_revision ?? file.revision,
        );
    }
    // A new snapshot omits tombstones. Preserve locally pending deleted documents before discarding the view.
    for (const local of this.locals())
      if (!seen.has(local.file_id)) {
        const pending = this.pendingDocuments(local.file_id, event?.opId);
        if (pending.length) {
          const old: ProjectFile = {
            id: local.file_id,
            path: local.disk_path,
            kind: local.state ? 'text' : 'binary',
            generation: local.generation,
            revision: local.baseline_revision,
            hash: local.content_hash,
            size: 0,
            stateHash: null,
            lineEnding: null,
            deleted: true,
          };
          if (pending.some((command) => command.kind === 'text'))
            this.preserveConflict(old, local, 'REMOTE_DELETION');
          for (const command of pending) {
            if (command.kind === 'write')
              this.preserveConflict(
                old,
                local,
                'REMOTE_DELETION',
                unb64(command.data, MAX_BLOB_BYTES),
                null,
              );
            this.store.db
              .prepare("UPDATE outbox SET state='rejected',reason='REMOTE_DELETION' WHERE op_id=?")
              .run(command.opId);
          }
        }
        // Keep the projection row for safe removal of the former working file.
        this.store.db
          .prepare("UPDATE local_docs SET projection='pending' WHERE file_id=?")
          .run(local.file_id);
      }
  }

  private persistCommand(command: ProjectCommand, external: boolean): void {
    const fileId = 'fileId' in command ? command.fileId : null;
    const generation = 'generation' in command ? command.generation : null;
    this.store.db
      .prepare('INSERT INTO outbox(op_id,command,file_id,generation,external) VALUES(?,?,?,?,?)')
      .run(command.opId, JSON.stringify(command), fileId, generation, external ? 1 : 0);
  }
  private queueCommand(command: ProjectCommand, external: boolean): Promise<ProjectEvent> {
    transaction(this.store.db, () => this.persistCommand(command, external));
    const promise = new Promise<ProjectEvent>((resolve, reject) =>
      this.waiters.set(command.opId, { resolve, reject }),
    );
    this.emitState();
    this.flush();
    return promise;
  }
  private flush(): void {
    if (!this.ready || !this.link || this.inFlight || this.closed) return;
    const row = this.store.db
      .prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY seq LIMIT 1")
      .get() as unknown as OutboxRow | undefined;
    if (!row) {
      this.confirm();
      return;
    }
    // A rejected predecessor is never silently skipped for dependent edits on the same file.
    const command = JSON.parse(row.command) as ProjectCommand;
    const link = this.link;
    const attempt = this.epoch;
    if (
      (command.kind === 'text' ||
        command.kind === 'write' ||
        command.kind === 'move' ||
        command.kind === 'delete') &&
      row.file_id &&
      this.countFor(row.file_id, 'rejected')
    ) {
      this.rejectRow(row, new CairnError('DEPENDENCY_REJECTED', 'An earlier edit needs review.'));
      queueMicrotask(() => this.flush());
      return;
    }
    this.inFlight = row.op_id;
    void link
      .request<ProjectEvent>('command', { command })
      .then((ack) =>
        this.enqueue(async () => {
          this.guard(attempt, link);
          if (
            ack.opId !== row.op_id ||
            ack.kind !== command.kind ||
            ack.actor.id !== this.invite.memberId ||
            !Number.isSafeInteger(ack.revision) ||
            ack.revision < 1 ||
            !digest.test(ack.manifestHash)
          )
            throw new CairnError(
              'INVALID_ACK',
              'The save confirmation did not match the queued operation.',
            );
          await this.ensureEventBlobs(ack, attempt, link);
          this.verifyCommandResult(command, ack);
          if (ack.revision > this.store.revision() + 1)
            await this.catchUp(ack.revision - 1, attempt, link);
          this.guard(attempt, link);
          const recorded = this.store.eventsSince(ack.revision - 1, 1)[0];
          if (recorded && recorded.revision === ack.revision && !isDeepStrictEqual(recorded, ack))
            throw new CairnError(
              'INVALID_ACK',
              'The save confirmation conflicts with committed project history.',
            );
          const receipt = () => {
            this.store.db
              .prepare(
                'INSERT OR IGNORE INTO receipts(op_id,revision,manifest_hash,event_hash,received_at) VALUES(?,?,?,?,?)',
              )
              .run(
                row.op_id,
                ack.revision,
                ack.manifestHash,
                hash(JSON.stringify(ack)),
                Date.now(),
              );
            this.store.db.prepare('DELETE FROM outbox WHERE op_id=?').run(row.op_id);
            this.reviewStructuralConflicts(command, ack);
            this.reviewFailedCommandDraft(command, ack);
            if (row.external && row.file_id) {
              const file = this.store.file(row.file_id);
              const after = ack.changes.find((c) => c.after.id === row.file_id)?.after;
              if (file && after)
                this.store.db
                  .prepare(
                    'UPDATE local_docs SET baseline_hash=?,baseline_revision=? WHERE file_id=?',
                  )
                  .run(after.hash, after.revision, row.file_id);
            }
          };
          if (ack.revision > this.store.revision())
            this.store.ingest(ack, [], () => {
              this.mergeCatalog(ack);
              receipt();
            });
          else transaction(this.store.db, receipt);
          this.inFlight = null;
          this.refreshHolds();
          this.projectAll();
          this.lastError = undefined;
          this.emitState();
          this.waiters.get(row.op_id)?.resolve(ack);
          this.waiters.delete(row.op_id);
          this.flush();
          this.confirm();
        }),
      )
      .catch((error) => {
        if (!this.current(attempt, link)) return;
        this.inFlight = null;
        const safe = publicError(error);
        if (
          [
            'INVALID_ACK',
            'STATE_HASH_MISMATCH',
            'MANIFEST_MISMATCH',
            'BLOB_HASH_MISMATCH',
            'EVENT_GAP',
          ].includes(safe.code)
        ) {
          this.fail(error, attempt);
          return;
        }
        if (
          [
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'DISCONNECTED',
            'CONNECTION_CLOSED',
            'REQUEST_TIMEOUT',
            'SERVER_SAVE_FAILED',
            'INTERNAL_ERROR',
            'ENOSPC',
            'EIO',
            'SQLITE_FULL',
            'SQLITE_BUSY',
          ].includes(safe.code)
        ) {
          this.lastError = safe;
          this.emitState();
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.flush();
          }, 1000);
          this.retryTimer.unref();
          return;
        }
        this.rejectRow(row, error);
        this.flush();
      });
  }
  private verifyCommandResult(command: ProjectCommand, event: ProjectEvent): void {
    if (command.kind !== 'text' && command.kind !== 'write') return;
    const after = event.changes.find((change) => change.after.id === command.fileId)?.after;
    if (!after || after.deleted || after.generation !== command.generation)
      throw new CairnError('INVALID_ACK', 'The save confirmation changed the document identity.');
    if (command.kind === 'write') {
      if (after.hash !== hash(unb64(command.data, MAX_BLOB_BYTES)))
        throw new CairnError(
          'INVALID_ACK',
          'The save confirmation did not retain the external bytes.',
        );
      return;
    }
    if (!after.stateHash)
      throw new CairnError('INVALID_ACK', 'The save confirmation omitted its document state.');
    const doc = document(this.store.getBlob(after.stateHash));
    try {
      validateDocument(doc, after.lineEnding);
      if (hash(doc.getText('content').toString()) !== after.hash)
        throw new CairnError('INVALID_ACK', 'The saved document content does not match its hash.');
      const before = Y.encodeStateAsUpdate(doc);
      Y.applyUpdate(doc, unb64(command.update));
      if (!Buffer.from(before).equals(Buffer.from(Y.encodeStateAsUpdate(doc))))
        throw new CairnError(
          'INVALID_ACK',
          'The saved document does not contain the acknowledged update.',
        );
    } finally {
      doc.destroy();
    }
  }
  private rejectRow(row: OutboxRow, error: unknown): void {
    const safe = publicError(error);
    transaction(this.store.db, () => {
      const command = JSON.parse(row.command) as ProjectCommand;
      if (
        this.isNonDraftCommand(command, row.external !== 0) ||
        (!row.external && this.preserveFailedCommandDraft(command, safe.code))
      ) {
        this.archiveCommandFailure(row, safe.code);
        return;
      }
      if (row.file_id) {
        const file = this.store.file(row.file_id);
        const local = this.local(row.file_id);
        if (file && local) {
          if (file.kind === 'directory') this.preserveExternal(file, file.path, null, safe.code);
          else if (command.kind === 'write')
            this.preserveConflict(
              file,
              local,
              safe.code,
              unb64(command.data, MAX_BLOB_BYTES),
              null,
            );
          else this.preserveConflict(file, local, safe.code);
        }
      } else if (command.kind === 'create')
        this.preserveExternal(
          this.store.files().find((file) => file.path === command.path) ?? null,
          command.path,
          command.nodeKind === 'directory' ? null : unb64(command.data ?? '', MAX_BLOB_BYTES),
          safe.code,
        );
      this.store.db
        .prepare("UPDATE outbox SET state='rejected',reason=? WHERE op_id=?")
        .run(safe.code, row.op_id);
    });
    this.lastError = safe;
    this.waiters.get(row.op_id)?.reject(new CairnError(safe.code, safe.message));
    this.waiters.delete(row.op_id);
    this.emitState();
  }

  /** Failed structural/advisory intents have not changed the local document.
   * Keep their exact payload for diagnostics without making an editable draft
   * appear rejected. Unknown kinds and any data-bearing drafts stay active. */
  private isNonDraftCommand(command: ProjectCommand, external: boolean): boolean {
    if (external || !command || typeof command !== 'object') return false;
    switch (command.kind) {
      case 'create':
        return command.nodeKind === 'directory';
      case 'conflict-create':
        return command.localData === null && !command.localState;
      case 'conflict-resolve':
        return command.choice !== 'merged' || command.data === undefined;
      case 'move':
      case 'delete':
      case 'rescan':
      case 'claim-create':
      case 'claim-renew':
      case 'claim-complete':
      case 'claim-cancel':
      case 'claim-expire':
      case 'checkpoint-create':
      case 'checkpoint-delete':
      case 'checkpoint-restore':
      case 'trash-restore':
      case 'trash-purge':
      case 'settings':
        return true;
      default:
        return false;
    }
  }

  /** Caller owns the same SQLite transaction as outbox removal. */
  private archiveCommandFailure(row: OutboxRow, reason: string): void {
    const existing = this.store.db
      .prepare('SELECT command FROM command_failures WHERE op_id=?')
      .get(row.op_id) as { command: string } | undefined;
    if (existing && existing.command !== row.command)
      throw new CairnError(
        'OPERATION_COLLISION',
        'A failed operation identity has conflicting saved payloads. Both records were retained.',
      );
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO command_failures(op_id,command,reason,failed_at) VALUES(?,?,?,?)',
      )
      .run(row.op_id, row.command, reason, Date.now());
    this.store.db.prepare('DELETE FROM outbox WHERE op_id=?').run(row.op_id);
  }

  /** A failed metadata command can itself carry a manual merge or uploaded
   * conflict version. Give those bytes an independently reviewable local draft
   * before moving the failed request out of the active causal queue. */
  private preserveFailedCommandDraft(command: ProjectCommand, reason: string): boolean {
    let file: ProjectFile | undefined;
    let relative: string;
    let bytes: Uint8Array;
    let state: Uint8Array | undefined;
    let baseHash: string | null = null;
    let prefix: string;
    if (
      command.kind === 'conflict-resolve' &&
      command.choice === 'merged' &&
      command.data !== undefined
    ) {
      const original = this.metadata().conflicts.find(
        (conflict) => conflict.id === command.conflictId,
      );
      file = original?.fileId
        ? (this.store.file(original.fileId) ?? original.current ?? undefined)
        : undefined;
      relative = original?.path ?? `recovered-merge-${command.opId}.txt`;
      bytes = unb64(command.data, MAX_BLOB_BYTES);
      baseHash = original?.baseHash ?? null;
      prefix = `failed-merge:${command.conflictId}:${hash(bytes)}:`;
    } else if (
      command.kind === 'conflict-create' &&
      (command.localData !== null || command.localState)
    ) {
      file = command.fileId
        ? this.store.file(command.fileId)
        : this.store.files(true).find((item) => item.path === command.path);
      relative = command.path;
      state = command.localState ? unb64(command.localState, MAX_UPDATE_BYTES) : undefined;
      if (command.localData !== null) bytes = unb64(command.localData, MAX_BLOB_BYTES);
      else {
        const doc = document(state!);
        try {
          bytes = Buffer.from(doc.getText('content').toString());
        } finally {
          doc.destroy();
        }
      }
      baseHash = command.baseHash;
      prefix = `failed-conflict-create:${command.fileId ?? command.path}:${hash(bytes)}:`;
    } else return false;
    if (file?.kind === 'directory' || !this.store.policy.check(relative).allowed) {
      file = undefined;
      relative = `recovered-draft-${command.opId}.txt`;
    }
    const localHash = this.store.putBlob(bytes);
    const localStateHash = state ? this.store.putBlob(state) : null;
    const key = `${prefix}${file?.revision ?? 0}:${localStateHash ?? ''}`;
    const existing = this.store.db
      .prepare('SELECT body FROM local_conflicts WHERE observed_key=?')
      .get(key) as { body: string } | undefined;
    if (existing && (JSON.parse(existing.body) as ConflictEntry).status === 'open') return true;
    const conflict: ConflictEntry = {
      id: `local-${randomUUID()}`,
      fileId: file?.id ?? null,
      path: relative,
      reason,
      generation: file?.generation ?? 0,
      revision: file?.revision ?? 0,
      baseHash: baseHash && digest.test(baseHash) && this.store.hasBlob(baseHash) ? baseHash : null,
      localHash,
      localStateHash,
      remoteHash: file && !file.deleted ? file.hash : null,
      actorId: this.invite.memberId,
      createdAt: Date.now(),
      status: 'open',
    };
    this.store.db
      .prepare('INSERT INTO local_conflicts(id,body,observed_key) VALUES(?,?,?)')
      .run(conflict.id, JSON.stringify(conflict), existing ? `${key}:${command.opId}` : key);
    return true;
  }

  private reviewFailedCommandDraft(command: ProjectCommand, event: ProjectEvent): void {
    let prefix: string;
    if (
      command.kind === 'conflict-resolve' &&
      command.choice === 'merged' &&
      command.data !== undefined
    ) {
      const contentHash = hash(unb64(command.data, MAX_BLOB_BYTES));
      if (
        !event.changes.some((change) => !change.after.deleted && change.after.hash === contentHash)
      )
        return;
      prefix = `failed-merge:${command.conflictId}:${contentHash}:`;
    } else if (command.kind === 'conflict-create' && command.localData !== null) {
      const contentHash = hash(unb64(command.localData, MAX_BLOB_BYTES));
      if (
        !event.metadata.conflicts.some(
          (conflict) =>
            conflict.id === event.result?.conflictId && conflict.localHash === contentHash,
        )
      )
        return;
      prefix = `failed-conflict-create:${command.fileId ?? command.path}:${contentHash}:`;
    } else return;
    const rows = this.store.db
      .prepare('SELECT id,body FROM local_conflicts WHERE substr(observed_key,1,?)=?')
      .all(prefix.length, prefix) as { id: string; body: string }[];
    for (const row of rows) {
      const conflict = JSON.parse(row.body) as ConflictEntry;
      if (conflict.status === 'open')
        this.store.db
          .prepare('UPDATE local_conflicts SET body=? WHERE id=?')
          .run(
            JSON.stringify({ ...conflict, status: 'resolved', resolution: 'reviewed-retry' }),
            row.id,
          );
    }
  }
  private rejectAll(code: string, message: string): void {
    const rows = this.store.db
      .prepare("SELECT * FROM outbox WHERE state='pending'")
      .all() as unknown as OutboxRow[];
    for (const row of rows) this.rejectRow(row, new CairnError(code, message));
  }

  private reviewStructuralConflicts(command: ProjectCommand, event: ProjectEvent): void {
    if (command.kind !== 'create' && command.kind !== 'delete') return;
    for (const conflict of this.localConflicts()) {
      if (conflict.status !== 'open') continue;
      const created =
        command.kind === 'create'
          ? event.changes.find(
              (change) => change.after.path === command.path && !change.after.deleted,
            )?.after
          : undefined;
      const reviewed =
        command.kind === 'create'
          ? conflict.path === command.path &&
            !!created &&
            (created.kind === 'directory'
              ? conflict.reason === 'EXTERNAL_DIRECTORY'
              : conflict.localHash === created.hash)
          : conflict.fileId === command.fileId &&
            conflict.localHash === null &&
            ['EXTERNAL_DELETION', 'EXTERNAL_DIRECTORY_DELETION'].includes(conflict.reason);
      if (reviewed)
        this.store.db.prepare('UPDATE local_conflicts SET body=? WHERE id=?').run(
          JSON.stringify({
            ...conflict,
            status: 'resolved',
            resolution: `explicit-${command.kind}`,
          }),
          conflict.id,
        );
    }
  }

  private pendingDocuments(
    fileId: string,
    excludeOpId?: string,
  ): Extract<ProjectCommand, { kind: 'text' | 'write' }>[] {
    const rows = this.store.db
      .prepare("SELECT command FROM outbox WHERE file_id=? AND state='pending'")
      .all(fileId) as { command: string }[];
    return rows
      .map((row) => JSON.parse(row.command) as ProjectCommand)
      .filter(
        (command): command is Extract<ProjectCommand, { kind: 'text' | 'write' }> =>
          (command.kind === 'text' || command.kind === 'write') && command.opId !== excludeOpId,
      );
  }
  private preserveConflict(
    file: ProjectFile,
    local: LocalRow,
    reason: string,
    bytes?: Uint8Array,
    state?: Uint8Array | null,
  ): ConflictEntry {
    const actual =
      bytes ??
      (local.content_hash && this.store.hasBlob(local.content_hash)
        ? this.store.getBlob(local.content_hash)
        : Buffer.alloc(0));
    const stateBytes = state === undefined ? local.state : state;
    const localHash = this.store.putBlob(actual);
    const localStateHash = stateBytes ? this.store.putBlob(stateBytes) : null;
    const key = `${file.id}:${local.generation}:${reason}:${localHash}`;
    const prior = this.store.db
      .prepare('SELECT body FROM local_conflicts WHERE observed_key=?')
      .get(key) as { body: string } | undefined;
    if (prior) return JSON.parse(prior.body) as ConflictEntry;
    const conflict: ConflictEntry = {
      id: `local-${randomUUID()}`,
      fileId: file.id,
      path: local.disk_path,
      reason,
      generation: local.generation,
      revision: file.revision,
      baseHash: local.baseline_hash,
      localHash,
      remoteHash: file.deleted ? null : file.hash,
      localStateHash,
      actorId: this.invite.memberId,
      createdAt: Date.now(),
      status: 'open',
    };
    this.store.db
      .prepare('INSERT INTO local_conflicts(id,body,observed_key) VALUES(?,?,?)')
      .run(conflict.id, JSON.stringify(conflict), key);
    return conflict;
  }
  private preserveExternal(
    file: ProjectFile | null,
    relative: string,
    bytes: Uint8Array | null,
    reason: string,
  ): void {
    const local = file ? this.local(file.id) : undefined;
    const localHash = bytes ? this.store.putBlob(bytes) : null;
    const key = `external:${relative}:${localHash ?? 'missing'}:${file?.generation ?? 0}:${reason}`;
    if (this.store.db.prepare('SELECT id FROM local_conflicts WHERE observed_key=?').get(key))
      return;
    const conflict: ConflictEntry = {
      id: `local-${randomUUID()}`,
      fileId: file?.id ?? null,
      path: relative,
      reason,
      generation: file?.generation ?? 0,
      revision: file?.revision ?? this.store.revision(),
      baseHash: local?.baseline_hash ?? null,
      localHash,
      remoteHash: file?.hash ?? null,
      actorId: this.invite.memberId,
      createdAt: Date.now(),
      status: 'open',
    };
    this.store.db
      .prepare('INSERT INTO local_conflicts(id,body,observed_key) VALUES(?,?,?)')
      .run(conflict.id, JSON.stringify(conflict), key);
    if (file)
      this.store.db
        .prepare("UPDATE local_docs SET projection='blocked',error=? WHERE file_id=?")
        .run(reason, file.id);
  }
  private async resolveLocal(
    input: Extract<CommandInput, { kind: 'conflict-resolve' }>,
  ): Promise<ProjectEvent> {
    const conflict = this.localConflict(input.conflictId)!;
    if (conflict.status !== 'open')
      throw new CairnError('CONFLICT_RESOLVED', 'This local conflict has already been reviewed.');
    const file = conflict.fileId ? this.store.file(conflict.fileId) : undefined;
    if (file?.kind === 'directory' || conflict.reason === 'EXTERNAL_DIRECTORY')
      throw new CairnError(
        'STRUCTURAL_REVIEW',
        'Review this folder using an explicit create, move, or delete operation. Folder changes are not text or binary conflict versions.',
      );
    if (file && file.revision !== input.expectedRevision)
      throw new CairnError(
        'STALE_REVISION',
        'The file changed again. Review its current version before resolving.',
      );
    // Publish both immutable sides for shared review. Use the current target identity only after explicit review.
    const published = await this.queueCommand(
      {
        opId: randomUUID(),
        kind: 'conflict-create',
        fileId: file?.deleted ? null : conflict.fileId,
        path: conflict.path,
        reason: conflict.reason,
        generation: file?.generation ?? conflict.generation,
        revision: file?.revision ?? conflict.revision,
        baseHash: conflict.baseHash,
        localData: conflict.localHash ? b64(this.store.getBlob(conflict.localHash)) : null,
        remoteHash: file && !file.deleted ? file.hash : null,
        ...(conflict.localStateHash
          ? { localState: b64(this.store.getBlob(conflict.localStateHash)) }
          : {}),
        source: { kind: 'recovery' },
      },
      false,
    );
    const conflictId = published.result?.conflictId;
    if (typeof conflictId !== 'string')
      throw new CairnError('INVALID_ACK', 'The shared conflict confirmation omitted its identity.');
    const target = published.metadata.conflicts.find((entry) => entry.id === conflictId)?.current;
    // A live snapshot omits tombstones. An unchanged deletion can be explicitly restored,
    // but a new live version arriving after the user's review requires another review.
    if ((file && target?.revision !== file.revision) || (!file && target && !target.deleted))
      throw new CairnError(
        'STALE_REVISION',
        'The target changed while this conflict was being prepared. Review its current version again.',
      );
    const result = await this.queueCommand(
      {
        opId: randomUUID(),
        kind: 'conflict-resolve',
        conflictId,
        choice: input.choice,
        expectedRevision: target?.revision ?? 0,
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
      false,
    );
    transaction(this.store.db, () => {
      this.store.db
        .prepare('UPDATE local_conflicts SET body=? WHERE id=?')
        .run(
          JSON.stringify({ ...conflict, status: 'resolved', resolution: input.choice }),
          conflict.id,
        );
      const rejectedCreates = this.store.db
        .prepare("SELECT * FROM outbox WHERE state='rejected' AND file_id IS NULL")
        .all() as unknown as OutboxRow[];
      for (const row of rejectedCreates) {
        const failed = JSON.parse(row.command) as ProjectCommand;
        if (
          failed.kind === 'create' &&
          failed.nodeKind !== 'directory' &&
          failed.path === conflict.path &&
          hash(unb64(failed.data ?? '', MAX_BLOB_BYTES)) === conflict.localHash
        )
          this.archiveCommandFailure(row, row.reason ?? 'COMMAND_REJECTED');
      }
      if (conflict.fileId) {
        this.store.db
          .prepare("DELETE FROM outbox WHERE file_id=? AND state='rejected'")
          .run(conflict.fileId);
        const row = this.local(conflict.fileId);
        if (row) {
          const current = this.readDisk(row.disk_path);
          if ((current ? hash(current) : null) === conflict.localHash)
            this.store.db
              .prepare(
                "UPDATE local_docs SET disk_hash=?,projection='pending',error=NULL WHERE file_id=?",
              )
              .run(conflict.localHash, conflict.fileId);
        }
      }
    });
    this.projectAll();
    this.emitState();
    this.flush();
    this.confirm();
    return result;
  }

  private refreshHolds(): void {
    const next = new Set(
      this.store
        .metadata()
        .claims.filter(
          (claim) =>
            claim.status === 'active' &&
            claim.external &&
            claim.ownerId === this.invite.memberId &&
            claim.expiresAt > Date.now(),
        )
        .map((claim) => claim.fileId),
    );
    const released = [...this.heldFiles].some((id) => !next.has(id));
    for (const id of next)
      if (!this.heldFiles.has(id)) {
        const file = this.store.file(id);
        const local = this.local(id);
        if (file && local) {
          const actual = this.readDisk(local.disk_path);
          if (actual && hash(actual) === file.hash)
            this.store.db
              .prepare('UPDATE local_docs SET baseline_hash=?,baseline_revision=? WHERE file_id=?')
              .run(file.hash, file.revision, id);
        }
      }
    this.heldFiles = next;
    if (released) this.inspectWorkcopy();
  }
  private projectAll(): void {
    if (!this.initialized || this.closed) return;
    const files = this.store.files(true);
    const byId = new Map(files.map((file) => [file.id, file]));
    const rows = this.locals().sort(
      (a, b) => a.disk_path.split('/').length - b.disk_path.split('/').length,
    );
    const conflicts = this.localConflicts().filter((c) => c.status === 'open');
    const directoryCleanup: { row: LocalRow; file: ProjectFile }[] = [];
    // Parent directories first; deleted directories last. File helpers never recursively remove user data.
    rows.sort((a, b) => {
      const fa = byId.get(a.file_id),
        fb = byId.get(b.file_id);
      const da = !fa || fa.deleted,
        db = !fb || fb.deleted;
      if (da !== db) return da ? 1 : -1;
      return da ? b.disk_path.length - a.disk_path.length : a.disk_path.length - b.disk_path.length;
    });
    for (const row of rows) {
      const file = byId.get(row.file_id);
      const pendingExternal = this.store.db
        .prepare("SELECT 1 FROM outbox WHERE file_id=? AND external=1 AND state='pending' LIMIT 1")
        .get(row.file_id);
      if (
        (!file || file.deleted) &&
        !this.store.policy.check(row.disk_path, row.content_hash === '').allowed
      ) {
        this.recordProjection(row.file_id, { state: 'applied', path: row.disk_path });
        continue;
      }
      if (this.heldFiles.has(row.file_id) || pendingExternal) {
        this.recordProjection(row.file_id, { state: 'held', path: file?.path ?? row.disk_path });
        continue;
      }
      if (
        conflicts.some((c) => c.fileId === row.file_id || c.path === (file?.path ?? row.disk_path))
      ) {
        this.recordProjection(row.file_id, {
          state: 'blocked',
          path: file?.path ?? row.disk_path,
          error: 'Review the preserved local conflict before replacing this file.',
        });
        continue;
      }
      let result: { state: Projection | 'held'; hash?: string; error?: string };
      if (!file || file.deleted) {
        result =
          row.state === null && row.content_hash === ''
            ? removeEmptyDirectory(this.store.policy, row.disk_path)
            : removeProjected(this.store.policy, row.disk_path, row.disk_hash, this.recoveryDir);
      } else if (file.kind === 'directory') {
        result = mkdirProjected(this.store.policy, file.path);
        if (result.state === 'applied' && row.disk_path !== file.path) {
          directoryCleanup.push({ row, file });
          continue;
        }
      } else {
        const hasPrevious =
          row.disk_path !== file.path &&
          (row.disk_hash !== null ||
            fs.existsSync(this.store.policy.resolve(row.disk_path, { allowMissing: true })));
        result = projectBytes(this.store.policy, {
          path: file.path,
          bytes: this.store.getBlob(row.content_hash),
          expectedHash: row.disk_hash,
          recoveryDir: this.recoveryDir,
          ...(hasPrevious ? { previousPath: row.disk_path } : {}),
        });
      }
      const diskPath = result.state === 'applied' ? (file?.path ?? row.disk_path) : row.disk_path;
      this.recordProjection(row.file_id, { ...result, fileId: row.file_id, path: diskPath });
      if (result.state === 'applied')
        this.store.db
          .prepare('UPDATE local_docs SET disk_hash=?,disk_path=?,observed_hash=? WHERE file_id=?')
          .run(
            file && !file.deleted && file.kind !== 'directory' ? row.content_hash : null,
            diskPath,
            file && !file.deleted && file.kind !== 'directory' ? row.content_hash : 'missing',
            row.file_id,
          );
      if (result.state === 'blocked') {
        try {
          const bytes = this.readDisk(row.disk_path);
          transaction(this.store.db, () =>
            this.preserveExternal(file ?? null, row.disk_path, bytes, 'EXTERNAL_CONFLICT'),
          );
        } catch {
          /* helper already retained the immutable recovery version */
        }
      }
    }
    for (const { row, file } of directoryCleanup.sort(
      (a, b) => b.row.disk_path.length - a.row.disk_path.length,
    )) {
      const result = removeEmptyDirectory(this.store.policy, row.disk_path);
      this.recordProjection(row.file_id, {
        ...result,
        path: result.state === 'applied' ? file.path : row.disk_path,
      });
      if (result.state === 'applied')
        this.store.db
          .prepare('UPDATE local_docs SET disk_path=?,disk_hash=NULL WHERE file_id=?')
          .run(file.path, row.file_id);
    }
  }
  private inspectWorkcopy(): void {
    if (!this.initialized || this.closed) return;
    try {
      const scan = this.store.policy.scan();
      const paths = new Map(scan.entries.map((entry) => [entry.path, entry]));
      const files = this.store.files();
      const known = new Set(files.map((file) => file.path));
      for (const file of files) {
        const row = this.local(file.id);
        if (!row) continue;
        if (file.kind === 'directory') {
          if (row.projection === 'applied' && !paths.has(row.disk_path))
            transaction(this.store.db, () =>
              this.preserveExternal(file, row.disk_path, null, 'EXTERNAL_DIRECTORY_DELETION'),
            );
          continue;
        }
        const entry = paths.get(row.disk_path);
        const bytes = entry?.bytes ?? null;
        const actual = bytes ? hash(bytes) : null;
        // During a rename, canonical target might be absent while the old projection still exists.
        if (actual === row.disk_hash || actual === row.content_hash) continue;
        const observation = actual ?? 'missing';
        if (row.observed_hash === observation) continue;
        transaction(this.store.db, () =>
          this.store.db
            .prepare('UPDATE local_docs SET observed_hash=? WHERE file_id=?')
            .run(observation, file.id),
        );
        const canWrite =
          !!bytes &&
          this.ready &&
          this.role !== 'viewer' &&
          row.baseline_hash === file.hash &&
          row.baseline_revision === file.revision &&
          row.content_hash === file.hash &&
          !this.countFor(file.id, 'pending') &&
          !this.countFor(file.id, 'rejected');
        if (canWrite) {
          const command: ProjectCommand = {
            opId: randomUUID(),
            kind: 'write',
            fileId: file.id,
            generation: file.generation,
            baseHash: file.hash,
            baseRevision: file.revision,
            data: b64(bytes!),
            source: this.source,
          };
          transaction(this.store.db, () => {
            this.store.putBlob(bytes!);
            this.store.db
              .prepare("UPDATE local_docs SET disk_hash=?,projection='held' WHERE file_id=?")
              .run(actual, file.id);
            this.persistCommand(command, true);
          });
          this.flush();
        } else
          transaction(this.store.db, () =>
            this.preserveExternal(
              file,
              row.disk_path,
              bytes,
              bytes
                ? this.ready
                  ? 'STALE_EXTERNAL_BASELINE'
                  : 'OFFLINE_EXTERNAL_SAVE'
                : 'EXTERNAL_DELETION',
            ),
          );
      }
      for (const entry of scan.entries)
        if (!known.has(entry.path) && !this.locals().some((row) => row.disk_path === entry.path)) {
          transaction(this.store.db, () =>
            this.preserveExternal(
              null,
              entry.path,
              entry.bytes ?? null,
              entry.kind === 'directory' ? 'EXTERNAL_DIRECTORY' : 'EXTERNAL_CREATE',
            ),
          );
        }
    } catch (error) {
      this.lastError = publicError(error);
    }
  }
  private readDisk(relative: string): Uint8Array | null {
    const target = this.store.policy.resolve(relative, { allowMissing: true });
    if (!fs.existsSync(target)) return null;
    return readBounded(target, MAX_BLOB_BYTES);
  }
  private recordProjection(
    fileId: string,
    value: Omit<ProjectionRecord, 'fileId'> & { fileId?: string },
  ): void {
    this.store.db
      .prepare('UPDATE local_docs SET projection=?,error=? WHERE file_id=?')
      .run(value.state, value.error ?? null, fileId);
  }

  private confirm(): void {
    if (!this.ready || !this.link || this.confirmScheduled || this.confirmationTimer || this.closed)
      return;
    const status = this.status();
    const clean =
      status.pending === 0 &&
      status.rejected === 0 &&
      !status.metadata.conflicts.some((c) => c.status === 'open') &&
      status.projections.every((p) => p.state === 'applied');
    const key = `${status.revision}:${status.manifestHash}:${clean}`;
    if (key === this.lastConfirmedKey) return;
    this.confirmScheduled = true;
    let matched = false;
    const link = this.link,
      attempt = this.epoch;
    void link
      .request<{ revision: number; manifestHash: string }>('barrier', {})
      .then((barrier) => {
        if (!this.current(attempt, link) || !this.ready) return;
        const current = this.status();
        const nowClean =
          current.pending === 0 &&
          current.rejected === 0 &&
          !current.metadata.conflicts.some((c) => c.status === 'open') &&
          current.projections.every((p) => p.state === 'applied');
        if (barrier.revision !== current.revision || barrier.manifestHash !== current.manifestHash)
          return;
        link.sendApplied({
          revision: current.revision,
          manifestHash: current.manifestHash,
          projection: nowClean
            ? 'applied'
            : current.projections.some((p) => p.state === 'blocked' || p.state === 'error')
              ? 'blocked'
              : 'pending',
        });
        this.lastConfirmedKey = `${current.revision}:${current.manifestHash}:${nowClean}`;
        matched = true;
        this.confirmationDelay = 25;
      })
      .catch(() => {})
      .finally(() => {
        if (this.current(attempt, link)) {
          this.confirmScheduled = false;
          const current = this.status();
          const desiredClean =
            current.pending === 0 &&
            current.rejected === 0 &&
            !current.metadata.conflicts.some((c) => c.status === 'open') &&
            current.projections.every((p) => p.state === 'applied');
          const desiredKey = `${current.revision}:${current.manifestHash}:${desiredClean}`;
          if (this.ready && desiredKey !== this.lastConfirmedKey) {
            // A durable ACK can clear the queue without advancing the catalog.
            // Retry that state transition too, outside this promise's microtasks.
            // A mismatching/failed barrier backs off instead of spinning.
            const delay = this.confirmationDelay;
            if (!matched) this.confirmationDelay = Math.min(delay * 2, 1000);
            this.confirmationTimer = setTimeout(() => {
              this.confirmationTimer = undefined;
              if (this.current(attempt, link)) this.confirm();
            }, delay);
            this.confirmationTimer.unref();
          }
        }
      });
  }
  private fail(error: unknown, attempt: number): void {
    if (this.closed || attempt !== this.epoch) return;
    const safe = publicError(error);
    this.dropConnection();
    this.connection = 'error';
    this.team = null;
    this.lastError = safe;
    this.transfer = { ...this.transfer, stage: 'error', error: safe };
    this.emitState();
    const permanent =
      /INVITE|IDENTITY|CERT|TLS|UNAUTHORIZED|FORBIDDEN|REVOKED|EXPIRED|INVALID_|MANIFEST_|BLOB_|WORKCOPY_|MISSING_EVENTS|STALE_SERVER|UNSAFE_PATH/.test(
        safe.code,
      );
    if (this.wantsConnection && !permanent) {
      const delay = this.retryDelay;
      this.retryDelay = Math.min(10000, delay * 2);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.closed && this.wantsConnection) void this.connect().catch(() => {});
      }, delay);
      this.reconnectTimer.unref();
    }
  }
  private dropConnection(): void {
    ++this.epoch;
    this.ready = false;
    this.inFlight = null;
    this.confirmScheduled = false;
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = undefined;
    this.confirmationDelay = 25;
    this.lastConfirmedKey = '';
    this.connectPromise = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.retryTimer = undefined;
    this.reconnectTimer = undefined;
    const link = this.link;
    this.link = null;
    link?.removeAllListeners();
    link?.close();
  }
  private online(): { link: TeamConnection; attempt: number } {
    if (!this.ready || !this.link)
      throw new CairnError('OFFLINE', 'Connect to download this content.');
    return { link: this.link, attempt: this.epoch };
  }
  private current(attempt: number, link: TeamConnection): boolean {
    return !this.closed && this.epoch === attempt && this.link === link;
  }
  private guard(attempt: number, link: TeamConnection): void {
    if (!this.current(attempt, link))
      throw new CairnError('CANCELLED', 'The transfer attempt was cancelled.');
  }
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => {});
    return next;
  }
  private local(fileId: string): LocalRow | undefined {
    return this.store.db
      .prepare('SELECT * FROM local_docs WHERE file_id=?')
      .get(fileId) as unknown as LocalRow | undefined;
  }
  private locals(): LocalRow[] {
    return this.store.db.prepare('SELECT * FROM local_docs').all() as unknown as LocalRow[];
  }
  private setting(key: string): string | undefined {
    return (
      this.store.db.prepare('SELECT value FROM replica_settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  private setSetting(key: string, value: string): void {
    this.store.db
      .prepare(
        'INSERT INTO replica_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  private countFor(id: string, state: 'pending' | 'rejected'): number {
    return Number(
      this.store.db
        .prepare('SELECT count(*) AS count FROM outbox WHERE file_id=? AND state=?')
        .get(id, state)!.count,
    );
  }
  private counts(): { pending: number; rejected: number } {
    return {
      pending: Number(
        this.store.db.prepare("SELECT count(*) AS count FROM outbox WHERE state='pending'").get()!
          .count,
      ),
      rejected: Number(
        this.store.db.prepare("SELECT count(*) AS count FROM outbox WHERE state='rejected'").get()!
          .count,
      ),
    };
  }
  private projections(): ProjectionRecord[] {
    return this.locals().map((row) => ({
      fileId: row.file_id,
      path: this.store.file(row.file_id)?.path ?? row.disk_path,
      state: row.projection,
      ...(row.error ? { error: row.error } : {}),
      ...(row.disk_hash ? { hash: row.disk_hash } : {}),
    }));
  }
  private localConflicts(): ConflictEntry[] {
    return (
      this.store.db.prepare('SELECT body FROM local_conflicts ORDER BY rowid').all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as ConflictEntry);
  }
  private localConflict(id: string): ConflictEntry | undefined {
    const row = this.store.db.prepare('SELECT body FROM local_conflicts WHERE id=?').get(id) as
      { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ConflictEntry) : undefined;
  }
  private metadata(): SharedMetadata {
    const metadata = this.store.metadata();
    return {
      ...metadata,
      conflicts: [
        ...metadata.conflicts,
        ...this.localConflicts().map((conflict) => ({
          ...conflict,
          current: conflict.fileId
            ? (this.store.file(conflict.fileId) ?? null)
            : (this.store.files(true).find((file) => file.path === conflict.path) ?? null),
        })),
      ],
    };
  }
  private assertFile(id: string): ProjectFile {
    this.assertOpen();
    const file = this.store.file(id);
    if (!file || file.deleted)
      throw new CairnError('FILE_NOT_FOUND', 'This file is no longer in the shared project.');
    return file;
  }
  private assertEditable(): void {
    if (this.role === 'viewer') throw new CairnError('READ_ONLY', 'This membership is read-only.');
  }
  private assertOpen(): void {
    if (this.closed) throw new CairnError('CLIENT_CLOSED', 'The project has been closed.');
  }
  private emitState(): void {
    if (this.closed) return;
    for (const [id, waiter] of this.waiters) {
      const rejected = this.store.db
        .prepare("SELECT reason FROM outbox WHERE op_id=? AND state='rejected'")
        .get(id) as { reason: string } | undefined;
      if (rejected) {
        waiter.reject(
          new CairnError(
            rejected.reason,
            'The saved operation requires review before it can be applied.',
          ),
        );
        this.waiters.delete(id);
      }
    }
    this.emit('state', this.status());
  }

  private emitTransferProgress(): void {
    const now = performance.now();
    if (now - this.lastProgressEmission < 100) return;
    this.lastProgressEmission = now;
    this.emitState();
  }
}
