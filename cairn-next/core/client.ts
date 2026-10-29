import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { Agent } from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { z } from 'zod';
import { watch, type FSWatcher } from 'chokidar';
import {
  PROTOCOL_VERSION,
  MAX_TEXT_BYTES,
  MAX_UPDATE_BYTES,
  type ClientOptions,
  type ClientSnapshot,
  type Invite,
  type Projection,
  type Role,
  type ServerStatus,
  type ClientMessage,
  type LineEnding,
} from '../shared/types.js';
import {
  CairnError,
  acquireOwnership,
  b64,
  checkLineEnding,
  ensureRoot,
  fileName,
  hash,
  openDb,
  privateDir,
  projectFile,
  publicError,
  readBounded,
  safeChild,
  textBytes,
  transaction,
  unb64,
  writeDurable,
} from './common.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/);
const projection = z.enum(['pending', 'applied', 'blocked', 'error']);
const role = z.enum(['owner', 'editor', 'viewer']);
const inviteSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    serverId: uuid,
    projectId: uuid,
    fileId: uuid,
    generation: z.number().int().positive(),
    fileName: z.string().min(1).max(120),
    address: z.string().max(2048),
    certificate: z.string().min(100).max(16384),
    fingerprint: z.string().regex(/^(?:[a-fA-F0-9]{2}:?){32}$/),
    token: z.string().min(32).max(256),
    memberId: uuid,
    role,
    expiresAt: z.number().int().positive(),
  })
  .strict();
const statusSchema = z.object({
  serverId: uuid,
  projectId: uuid,
  fileId: uuid,
  generation: z.number().int().positive(),
  fileName: z.string().max(120),
  lineEnding: z.enum(['lf', 'crlf']),
  name: z.string().max(120),
  port: z.number().int().min(0).max(65535),
  addresses: z.array(z.string().max(2048)).max(64),
  revision: z.number().int().nonnegative(),
  hash: digest,
  projection,
  projectionError: z.string().max(2048).optional(),
  peers: z
    .array(
      z.object({
        clientId: uuid,
        name: z.string().max(120),
        role,
        appliedRevision: z.number().int().min(-1),
        projection,
      }),
    )
    .max(32),
  confirmedRevision: z.number().int().nonnegative().nullable(),
  lastSavedAt: z.number().nonnegative(),
});
const incomingSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    state: z.string().max(MAX_UPDATE_BYTES * 2),
    role,
    status: statusSchema,
  }),
  z.object({
    type: z.literal('update'),
    update: z.string().max(MAX_UPDATE_BYTES * 2),
    revision: z.number().int().nonnegative(),
    hash: digest,
    opId: uuid,
  }),
  z.object({
    type: z.literal('ack'),
    opId: uuid,
    revision: z.number().int().nonnegative(),
    hash: digest,
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1).max(80),
    message: z.string().max(2048),
    opId: uuid.optional(),
  }),
  z.object({ type: z.literal('status'), status: statusSchema }),
  z.object({ type: z.literal('awareness'), update: z.string().max(256 * 1024) }),
]);

function validateInvite(input: unknown, checkExpiry: boolean): Invite {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success)
    throw new CairnError(
      'INVALID_INVITE',
      '초대 형식 또는 프로토콜 버전이 올바르지 않습니다. 새 초대를 요청하세요.',
    );
  const invite = parsed.data;
  fileName(invite.fileName);
  let address: URL;
  try {
    address = new URL(invite.address);
  } catch {
    throw new CairnError('INVALID_ADDRESS', 'WSS 서버 주소가 올바르지 않습니다.');
  }
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    address.pathname !== '/cairn'
  ) {
    throw new CairnError(
      'INVALID_ADDRESS',
      '사용자 정보가 없는 wss://서버:포트/cairn 주소를 사용하세요.',
    );
  }
  if (checkExpiry && invite.expiresAt <= Date.now())
    throw new CairnError(
      'INVITE_EXPIRED',
      '초대가 만료되었습니다. 호스트에게 새 초대를 요청하세요.',
    );
  try {
    const certificate = new X509Certificate(invite.certificate);
    if (hash(certificate.raw) !== invite.fingerprint.replaceAll(':', '').toLowerCase())
      throw new Error('fingerprint');
    if (!certificate.checkHost(`cairn-${invite.serverId}`)) throw new Error('server name');
  } catch {
    throw new CairnError(
      'INVALID_CERTIFICATE',
      '초대의 서버 인증서와 fingerprint가 일치하지 않습니다.',
    );
  }
  return { ...invite, fingerprint: invite.fingerprint.replaceAll(':', '').toLowerCase() };
}

export function parseInvite(text: string): Invite {
  if (typeof text !== 'string' || text.length > 32768)
    throw new CairnError('INVALID_INVITE', '초대 정보가 너무 크거나 올바르지 않습니다.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CairnError('INVALID_INVITE', '복사한 초대 정보 전체를 붙여넣으세요.');
  }
  return validateInvite(value, true);
}

function createDoc(state?: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content');
  if (state) Y.applyUpdate(doc, state, 'storage');
  validateDoc(doc);
  return doc;
}

function validateDoc(doc: Y.Doc): void {
  if ([...doc.share.keys()].some((key) => key !== 'content'))
    throw new CairnError('INVALID_DOCUMENT', '허용하지 않은 문서 구조입니다.');
  const content = doc.getText('content');
  for (const segment of content.toDelta()) {
    if (
      typeof segment.insert !== 'string' ||
      (segment.attributes && Object.keys(segment.attributes).length)
    )
      throw new CairnError('INVALID_DOCUMENT', '일반 텍스트만 편집할 수 있습니다.');
  }
  textBytes(content.toString());
  if (Y.encodeStateAsUpdate(doc).byteLength > MAX_UPDATE_BYTES)
    throw new CairnError(
      'STATE_LIMIT',
      '문서 기록 크기 제한에 도달했습니다. 로컬 내용을 보존하고 새 파일로 옮겨주세요.',
    );
}

interface Metadata {
  serverId: string;
  projectId: string;
  fileId: string;
  generation: number;
  fileName: string;
  clientId: string;
}
interface StateRow {
  state: Uint8Array;
  server_state: Uint8Array;
  initialized: number;
  server_revision: number;
  server_hash: string;
  disk_hash: string | null;
  projection: Projection;
  role: Role;
  line_ending: LineEnding;
}
interface OutboxRow {
  seq: number;
  op_id: string;
  binary_update: Uint8Array;
  state: 'pending' | 'rejected';
}
const fatalCodes = new Set([
  'AUTH_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVITE_EXPIRED',
  'TOKEN_EXPIRED',
  'ACCESS_REVOKED',
  'REVOKED',
  'VERSION_MISMATCH',
  'PROTOCOL_MISMATCH',
  'GENERATION_MISMATCH',
  'STALE_GENERATION',
  'IDENTITY_MISMATCH',
  'INVALID_CERTIFICATE',
  'INVALID_INVITE',
  'WRONG_PROJECT',
  'WRONG_SERVER',
  'SERVER_ROLLBACK',
]);

/** A durable client owns a private working copy. Network credentials remain in memory. */
export class CairnClient extends EventEmitter {
  readonly directory: string;
  readonly clientId: string;
  readonly name: string;
  private readonly invite: Invite;
  private readonly dataDir: string;
  private readonly recoveryDir: string;
  private readonly db: DatabaseSync;
  private readonly releaseOwnership: () => void;
  private localDoc: Y.Doc;
  private serverDoc: Y.Doc;
  private initialized: boolean;
  private currentRole: Role;
  private currentLineEnding: LineEnding = 'lf';
  private serverRevision: number;
  private serverHash: string;
  private diskHash: string | null;
  private localProjection: Projection;
  private serverProjection: Projection = 'pending';
  private serverStatus: ServerStatus | null = null;
  private connection: ClientSnapshot['connection'] = 'offline';
  private lastError?: ClientSnapshot['error'];
  private socket: WebSocket | null = null;
  private tlsAgent: Agent | null = null;
  private watcher?: FSWatcher;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private handshakeTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatDeadline?: NodeJS.Timeout;
  private awaitingPongs = new Set<string>();
  private retryDelay = 500;
  private inFlight: string | null = null;
  private operationTimer?: NodeJS.Timeout;
  private operationRetryDelay = 1000;
  private wantsConnection = false;
  private closed = false;
  private ready = false;
  private connectionPromise: Promise<void> | null = null;
  private resolveConnect?: () => void;
  private rejectConnect?: (error: Error) => void;

  constructor(options: ClientOptions) {
    super();
    this.invite = validateInvite(options.invite, false);
    if (!options.name?.trim() || options.name.length > 60 || /[\x00-\x1f\x7f]/.test(options.name))
      throw new CairnError('INVALID_NAME', '이름은 1~60자의 일반 문자로 입력하세요.');
    this.name = options.name.trim();
    this.directory = ensureRoot(options.directory, 'client');
    const entries = fs.readdirSync(this.directory);
    const hasData = entries.includes('.cairn-next-client');
    if (!hasData && entries.length)
      throw new CairnError(
        'NONEMPTY_DIRECTORY',
        '최초 다운로드는 비어 있는 폴더를 선택하세요. 기존 파일을 덮어쓰지 않았습니다.',
      );
    this.dataDir = privateDir(this.directory, '.cairn-next-client');
    this.releaseOwnership = acquireOwnership(this.dataDir);
    let opened: DatabaseSync | undefined;
    try {
      opened = openDb(path.join(this.dataDir, 'client.sqlite'));
      this.db = opened;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK(id=1), state BLOB NOT NULL, server_state BLOB NOT NULL, initialized INTEGER NOT NULL, server_revision INTEGER NOT NULL, server_hash TEXT NOT NULL, disk_hash TEXT, projection TEXT NOT NULL, role TEXT NOT NULL, line_ending TEXT NOT NULL DEFAULT 'lf');
        CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, binary_update BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', reason TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (op_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, hash TEXT NOT NULL, received_at INTEGER NOT NULL);
      `);
      const metaRow = this.db.prepare('SELECT value FROM metadata WHERE id=1').get() as
        { value: string } | undefined;
      const ensureFormatColumn = () => {
        if (
          this.db
            .prepare('PRAGMA table_info(document)')
            .all()
            .some((column) => column.name === 'line_ending')
        )
          return;
        const old = this.db.prepare('SELECT state FROM document WHERE id=1').get() as
          { state: Uint8Array } | undefined;
        const doc = old ? createDoc(old.state) : null;
        try {
          const ending = doc?.getText('content').toString().includes('\r\n') ? 'crlf' : 'lf';
          transaction(this.db, () => {
            this.db.exec("ALTER TABLE document ADD COLUMN line_ending TEXT NOT NULL DEFAULT 'lf'");
            this.db.prepare('UPDATE document SET line_ending=? WHERE id=1').run(ending);
          });
        } finally {
          doc?.destroy();
        }
      };
      if (metaRow) {
        const meta = JSON.parse(metaRow.value) as Metadata;
        if (
          meta.serverId !== this.invite.serverId ||
          meta.projectId !== this.invite.projectId ||
          meta.fileId !== this.invite.fileId ||
          meta.generation !== this.invite.generation ||
          meta.fileName !== this.invite.fileName
        ) {
          throw new CairnError(
            'IDENTITY_MISMATCH',
            '다른 프로젝트 또는 문서 세대의 작업 폴더입니다. 기존 미전송 변경은 보존되었습니다. 새 빈 폴더를 선택하세요.',
          );
        }
        this.clientId = meta.clientId;
        ensureFormatColumn();
      } else {
        if (entries.some((entry) => entry !== '.cairn-next-client'))
          throw new CairnError(
            'NONEMPTY_DIRECTORY',
            '작업 사본 정보가 없는 비어 있지 않은 폴더입니다.',
          );
        this.clientId = randomUUID();
        ensureFormatColumn();
        const empty = createDoc();
        try {
          transaction(this.db, () => {
            const metadata: Metadata = {
              serverId: this.invite.serverId,
              projectId: this.invite.projectId,
              fileId: this.invite.fileId,
              generation: this.invite.generation,
              fileName: this.invite.fileName,
              clientId: this.clientId,
            };
            this.db
              .prepare('INSERT INTO metadata(id,value) VALUES(1,?)')
              .run(JSON.stringify(metadata));
            const state = Y.encodeStateAsUpdate(empty);
            this.db
              .prepare("INSERT INTO document VALUES(1,?,?,0,0,?,NULL,?,?,'lf')")
              .run(state, state, hash(''), 'pending', this.invite.role);
          });
        } finally {
          empty.destroy();
        }
      }
      const row = this.db.prepare('SELECT * FROM document WHERE id=1').get() as unknown as
        StateRow | undefined;
      if (!row)
        throw new CairnError(
          'CORRUPT_CACHE',
          '보관된 문서 기록이 없습니다. 작업 폴더를 보존하고 진단하세요.',
        );
      this.localDoc = createDoc(row.state);
      this.serverDoc = createDoc(row.server_state);
      if (hash(this.serverDoc.getText('content').toString()) !== row.server_hash)
        throw new CairnError(
          'CORRUPT_CACHE',
          '보관된 서버 상태와 hash가 일치하지 않습니다. 작업 사본과 DB를 보존하고 복구가 필요합니다.',
        );
      this.initialized = !!row.initialized;
      this.currentRole = row.role;
      this.currentLineEnding = row.line_ending;
      if (!['lf', 'crlf'].includes(this.currentLineEnding))
        throw new CairnError('CORRUPT_CACHE', '보관된 줄바꿈 정책이 올바르지 않습니다.');
      checkLineEnding(this.localDoc.getText('content').toString(), this.currentLineEnding);
      checkLineEnding(this.serverDoc.getText('content').toString(), this.currentLineEnding);
      this.serverRevision = row.server_revision;
      this.serverHash = row.server_hash;
      this.diskHash = row.disk_hash;
      this.localProjection = row.projection;
      this.recoveryDir = privateDir(this.dataDir, 'recovery');
      if (this.initialized) this.materialize();
      this.watcher = watch(path.join(this.directory, this.invite.fileName), {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        atomic: true,
      });
      this.watcher.on('all', () => this.inspectWorkingFile());
      this.watcher.on('error', () => {
        if (this.closed) return;
        this.localProjection = 'error';
        this.lastError = {
          code: 'WATCHER_FAILED',
          message: '작업 파일 감시가 중단되었습니다. 내용을 보관하고 앱을 다시 여세요.',
        };
        this.emitState();
        this.reportApplied();
      });
    } catch (error) {
      opened?.close();
      this.releaseOwnership();
      throw error;
    }
  }

  /** A detached copy prevents callers from mutating state without durable outbox insertion. */
  get doc(): Y.Doc {
    this.assertOpen();
    return createDoc(Y.encodeStateAsUpdate(this.localDoc));
  }

  snapshot(): ClientSnapshot {
    this.assertOpen();
    const pending = (
      this.db.prepare("SELECT count(*) AS count FROM outbox WHERE state='pending'").get() as {
        count: number;
      }
    ).count;
    const rejected = (
      this.db.prepare("SELECT count(*) AS count FROM outbox WHERE state='rejected'").get() as {
        count: number;
      }
    ).count;
    const text = this.localDoc.getText('content').toString();
    const isCurrent =
      this.connection === 'online' &&
      this.ready &&
      pending === 0 &&
      rejected === 0 &&
      this.localProjection === 'applied' &&
      hash(text) === this.serverHash;
    return {
      connection: this.connection,
      error: this.lastError,
      initialized: this.initialized,
      clientId: this.clientId,
      name: this.name,
      role: this.currentRole,
      lineEnding: this.currentLineEnding,
      projectId: this.invite.projectId,
      fileId: this.invite.fileId,
      generation: this.invite.generation,
      fileName: this.invite.fileName,
      text,
      state: b64(Y.encodeStateAsUpdate(this.localDoc)),
      pending,
      rejected,
      localSaved: true,
      serverRevision: this.serverRevision,
      serverHash: this.serverHash,
      serverProjection: this.serverProjection,
      localProjection: this.localProjection,
      peers: this.connection === 'online' ? (this.serverStatus?.peers ?? []) : [],
      confirmedRevision:
        isCurrent && this.serverStatus?.confirmedRevision === this.serverRevision
          ? this.serverRevision
          : null,
      directory: this.directory,
    };
  }

  connect(): Promise<void> {
    this.assertOpen();
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;
    this.wantsConnection = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    const promise = this.connectionPromise;
    if (this.invite.expiresAt <= Date.now()) {
      this.failConnection(
        new CairnError(
          'INVITE_EXPIRED',
          '초대가 만료되었습니다. 미전송 변경은 로컬에 보존됩니다. 새 초대를 요청하세요.',
        ),
        true,
      );
      return promise;
    }
    const attempt = ++this.attempt;
    this.connection = 'connecting';
    this.lastError = undefined;
    this.ready = false;
    this.serverStatus = null;
    this.emitState();
    const servername = `cairn-${this.invite.serverId}`;
    try {
      const agent = new Agent({
        ca: this.invite.certificate,
        rejectUnauthorized: true,
        servername,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_hostname, certificate) => {
          const identityError = checkServerIdentity(servername, certificate);
          if (identityError) return identityError;
          if (hash(certificate.raw) !== this.invite.fingerprint)
            return new CairnError('INVALID_CERTIFICATE', '서버 fingerprint가 초대와 다릅니다.');
          return undefined;
        },
      });
      this.tlsAgent = agent;
      // Explicit servername is needed because the movable LAN address is not the identity.
      const transportOptions = {
        agent,
        servername,
        handshakeTimeout: 10000,
        maxPayload: MAX_UPDATE_BYTES * 2 + 65536,
        perMessageDeflate: false,
      };
      const socket = new WebSocket(this.invite.address, transportOptions);
      this.socket = socket;
      const current = () => !this.closed && this.attempt === attempt && this.socket === socket;
      this.handshakeTimer = setTimeout(() => {
        if (current() && !this.ready)
          this.failConnection(
            new CairnError(
              'ETIMEDOUT',
              '서버 인증 응답이 없습니다. 주소와 서버 상태를 확인하세요.',
            ),
            false,
          );
      }, 12000);
      socket.on('open', () => {
        if (!current()) return;
        this.send({
          type: 'hello',
          version: PROTOCOL_VERSION,
          serverId: this.invite.serverId,
          projectId: this.invite.projectId,
          fileId: this.invite.fileId,
          generation: this.invite.generation,
          token: this.invite.token,
          clientId: this.clientId,
          name: this.name,
        });
      });
      socket.on('message', (bytes) => {
        if (!current()) return;
        try {
          this.receive(JSON.parse(bytes.toString()));
        } catch (error) {
          this.failConnection(
            error instanceof CairnError
              ? error
              : new CairnError(
                  'INVALID_MESSAGE',
                  '서버 응답을 검증하지 못했습니다. 로컬 변경은 보존되었습니다.',
                ),
            true,
          );
        }
      });
      socket.on('pong', (bytes) => {
        if (!current() || !this.ready) return;
        const nonce = bytes.toString();
        if (!this.awaitingPongs.delete(nonce)) return;
        this.resetHeartbeatDeadline(socket, attempt);
      });
      socket.on('error', (error) => {
        if (current()) this.failConnection(error, isCertificateError(error));
      });
      socket.on('close', () => {
        if (!current()) return;
        this.failConnection(
          new CairnError(
            'CONNECTION_CLOSED',
            '서버 연결이 끊겼습니다. 로컬 편집은 보존되며 다시 연결합니다.',
          ),
          false,
        );
      });
    } catch (error) {
      this.failConnection(error, false);
    }
    return promise;
  }

  disconnect(): void {
    if (this.closed) return;
    this.wantsConnection = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.dropSocket();
    this.connection = 'offline';
    this.lastError = undefined;
    this.serverStatus = null;
    this.finishConnect(new CairnError('CANCELLED', '연결을 취소했습니다.'));
    this.emitState();
  }

  close(): void {
    if (this.closed) return;
    this.disconnect();
    this.closed = true;
    void this.watcher?.close().catch(() => {});
    this.watcher = undefined;
    this.localDoc.destroy();
    this.serverDoc.destroy();
    this.db.close();
    this.releaseOwnership();
    this.removeAllListeners();
  }

  applyLocalUpdate(update: Uint8Array): ClientSnapshot {
    this.assertOpen();
    if (this.currentRole === 'viewer') throw new CairnError('READ_ONLY', '읽기 전용 권한입니다.');
    if (!this.initialized)
      throw new CairnError('NOT_INITIALIZED', '최초 다운로드와 검증을 먼저 완료하세요.');
    if (update.byteLength > MAX_UPDATE_BYTES)
      throw new CairnError('SIZE_LIMIT', '변경 크기가 제한을 초과했습니다.');
    const candidate = createDoc(Y.encodeStateAsUpdate(this.localDoc));
    try {
      Y.applyUpdate(candidate, update, 'local');
      try {
        validateDoc(candidate);
        checkLineEnding(candidate.getText('content').toString(), this.currentLineEnding);
      } catch (error) {
        this.preserveRejectedCandidate(candidate, error);
      }
      const before = Y.encodeStateAsUpdate(this.localDoc);
      const state = Y.encodeStateAsUpdate(candidate);
      if (Buffer.from(before).equals(Buffer.from(state))) return this.snapshot();
      const opId = randomUUID();
      transaction(this.db, () => {
        this.db
          .prepare(
            "INSERT INTO outbox(op_id,binary_update,state,created_at) VALUES(?,?,'pending',?)",
          )
          .run(opId, update, Date.now());
        this.db.prepare("UPDATE document SET state=?,projection='pending' WHERE id=1").run(state);
      });
      const previous = this.localDoc;
      this.localDoc = candidate;
      previous.destroy();
      this.localProjection = 'pending';
      this.materialize();
      this.emitState();
      if (this.ready) this.flushOutbox();
      return this.snapshot();
    } finally {
      if (candidate !== this.localDoc) candidate.destroy();
    }
  }

  awareness(update: string): void {
    this.assertOpen();
    unb64(update, 64 * 1024);
    if (this.ready) this.send({ type: 'awareness', update });
  }
  retryProjection(): void {
    this.assertOpen();
    if (this.initialized) {
      this.materialize();
      this.reportApplied();
      this.emitState();
    }
    if (this.ready && this.currentRole === 'owner') this.send({ type: 'retry-projection' });
  }
  /** Test and diagnostic transport entrypoint; server authorization remains authoritative. */
  sendRaw(message: unknown): void {
    this.assertOpen();
    if (!this.ready || !this.socket)
      throw new CairnError('OFFLINE', '서버에 연결되어 있지 않습니다.');
    const encoded = JSON.stringify(message);
    if (encoded.length > MAX_UPDATE_BYTES * 2)
      throw new CairnError('SIZE_LIMIT', '메시지가 너무 큽니다.');
    this.socket.send(encoded);
  }

  private receive(input: unknown): void {
    const parsed = incomingSchema.safeParse(input);
    if (!parsed.success)
      throw new CairnError('INVALID_MESSAGE', '서버 응답의 구조가 올바르지 않습니다.');
    const message = parsed.data;
    if (message.type === 'error') {
      const error = {
        code: message.code,
        message: message.message.replaceAll(this.invite.token, '[redacted]'),
      };
      if (message.opId) {
        if (message.code === 'SERVER_SAVE_FAILED') {
          // An uncommitted server write must stay in the durable outbox and may be retried.
          this.lastError = error;
          this.scheduleOperationRetry();
          this.emitState();
          return;
        }
        this.db
          .prepare("UPDATE outbox SET state='rejected',reason=? WHERE op_id=? AND state='pending'")
          .run(JSON.stringify(error), message.opId);
        if (this.inFlight === message.opId) this.clearInFlight();
        this.lastError = error;
        this.emitState();
      }
      if (!this.ready || fatalCodes.has(message.code)) {
        this.failConnection(new CairnError(error.code, error.message), true);
      } else if (!message.opId) {
        this.lastError = error;
        this.emitState();
      }
      return;
    }
    if (message.type === 'welcome') {
      if (this.ready) throw new CairnError('INVALID_MESSAGE', '중복 초기화 응답입니다.');
      this.validateStatus(message.status);
      if (this.initialized && message.status.revision < this.serverRevision)
        throw new CairnError(
          'SERVER_ROLLBACK',
          '같은 문서 세대의 서버 기록이 과거로 돌아갔습니다. 로컬 변경을 보존했으며 자동 병합을 중지했습니다.',
        );
      if (
        this.initialized &&
        message.status.revision === this.serverRevision &&
        message.status.hash !== this.serverHash
      )
        throw new CairnError(
          'SERVER_STATE_MISMATCH',
          '같은 revision의 서버 내용이 달라졌습니다. 로컬 변경을 보존했으며 확인이 필요합니다.',
        );
      const server = createDoc(unb64(message.state));
      const local = createDoc(Y.encodeStateAsUpdate(this.localDoc));
      try {
        if (hash(server.getText('content').toString()) !== message.status.hash)
          throw new CairnError('HASH_MISMATCH', '최초 다운로드 내용의 무결성 검증이 실패했습니다.');
        Y.applyUpdate(local, Y.encodeStateAsUpdate(server), 'remote');
        validateDoc(local);
        checkLineEnding(server.getText('content').toString(), message.status.lineEnding);
        checkLineEnding(local.getText('content').toString(), message.status.lineEnding);
        transaction(this.db, () => {
          this.db
            .prepare(
              "UPDATE document SET state=?,server_state=?,initialized=1,server_revision=?,server_hash=?,projection='pending',role=?,line_ending=? WHERE id=1",
            )
            .run(
              Y.encodeStateAsUpdate(local),
              Y.encodeStateAsUpdate(server),
              message.status.revision,
              message.status.hash,
              message.role,
              message.status.lineEnding,
            );
          if (message.role === 'viewer')
            this.db
              .prepare("UPDATE outbox SET state='rejected',reason=? WHERE state='pending'")
              .run('읽기 전용 권한으로 변경되어 전송하지 않았습니다.');
        });
        this.replaceDocs(local, server);
        this.initialized = true;
        this.currentRole = message.role;
        this.currentLineEnding = message.status.lineEnding;
        this.serverRevision = message.status.revision;
        this.serverHash = message.status.hash;
        this.serverStatus = message.status;
        this.serverProjection = message.status.projection;
        this.ready = true;
        this.connection = 'online';
        this.lastError = undefined;
        this.retryDelay = 500;
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.startHeartbeat();
        this.materialize();
        this.finishConnect();
        this.emitState();
        this.flushOutbox();
        this.reportApplied();
      } finally {
        if (local !== this.localDoc) local.destroy();
        if (server !== this.serverDoc) server.destroy();
      }
      return;
    }
    if (!this.ready)
      throw new CairnError('UNAUTHENTICATED_DATA', '인증 완료 전에 문서 데이터가 도착했습니다.');
    if (message.type === 'update') {
      const update = unb64(message.update);
      const server = createDoc(Y.encodeStateAsUpdate(this.serverDoc));
      const local = createDoc(Y.encodeStateAsUpdate(this.localDoc));
      try {
        Y.applyUpdate(server, update, 'remote');
        Y.applyUpdate(local, update, 'remote');
        validateDoc(server);
        validateDoc(local);
        checkLineEnding(server.getText('content').toString(), this.currentLineEnding);
        checkLineEnding(local.getText('content').toString(), this.currentLineEnding);
        // WebSocket messages are ordered; a lower replay revision is harmless but never moves the cursor backwards.
        if (
          message.revision >= this.serverRevision &&
          hash(server.getText('content').toString()) !== message.hash
        )
          throw new CairnError(
            'HASH_MISMATCH',
            '서버 변경과 내용 hash가 일치하지 않습니다. 다시 연결해 검증하세요.',
          );
        const revision = Math.max(this.serverRevision, message.revision);
        const serverHash = message.revision >= this.serverRevision ? message.hash : this.serverHash;
        transaction(this.db, () => {
          this.db
            .prepare(
              "UPDATE document SET state=?,server_state=?,server_revision=?,server_hash=?,projection='pending' WHERE id=1",
            )
            .run(Y.encodeStateAsUpdate(local), Y.encodeStateAsUpdate(server), revision, serverHash);
        });
        this.replaceDocs(local, server);
        this.serverRevision = revision;
        this.serverHash = serverHash;
        this.materialize();
        this.emitState();
        this.reportApplied();
      } finally {
        if (local !== this.localDoc) local.destroy();
        if (server !== this.serverDoc) server.destroy();
      }
      return;
    }
    if (message.type === 'ack') {
      const pending = this.db
        .prepare("SELECT * FROM outbox WHERE op_id=? AND state='pending'")
        .get(message.opId) as unknown as OutboxRow | undefined;
      if (!pending) return;
      const server = createDoc(Y.encodeStateAsUpdate(this.serverDoc));
      try {
        Y.applyUpdate(server, pending.binary_update, 'ack');
        validateDoc(server);
        checkLineEnding(server.getText('content').toString(), this.currentLineEnding);
        const state = Y.encodeStateAsUpdate(server);
        const advances = message.revision === this.serverRevision + 1;
        if (advances) {
          if (hash(server.getText('content').toString()) !== message.hash)
            throw new CairnError(
              'INVALID_ACK',
              '저장 확인과 변경 내용이 일치하지 않습니다. 미전송 변경을 보존했습니다.',
            );
        } else if (
          message.revision > this.serverRevision ||
          !Buffer.from(state).equals(Buffer.from(Y.encodeStateAsUpdate(this.serverDoc)))
        )
          throw new CairnError(
            'INVALID_ACK',
            '누락된 서버 기록이 있어 저장 확인을 검증하지 못했습니다.',
          );
        transaction(this.db, () => {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO receipts(op_id,revision,hash,received_at) VALUES(?,?,?,?)',
            )
            .run(message.opId, message.revision, message.hash, Date.now());
          this.db.prepare('DELETE FROM outbox WHERE op_id=?').run(message.opId);
          if (advances)
            this.db
              .prepare(
                'UPDATE document SET server_state=?,server_revision=?,server_hash=? WHERE id=1',
              )
              .run(state, message.revision, message.hash);
        });
        if (advances) {
          this.serverDoc.destroy();
          this.serverDoc = server;
          this.serverRevision = message.revision;
          this.serverHash = message.hash;
        }
        if (this.inFlight === message.opId) this.clearInFlight();
        this.operationRetryDelay = 1000;
        if (this.lastError?.code === 'SERVER_SAVE_FAILED') this.lastError = undefined;
        this.emitState();
        this.reportApplied();
        this.flushOutbox();
        return;
      } finally {
        if (server !== this.serverDoc) server.destroy();
      }
    }
    if (message.type === 'status') {
      this.validateStatus(message.status);
      if (message.status.revision < this.serverRevision) return;
      this.serverStatus = message.status;
      this.serverProjection = message.status.projection;
      // A status is not a document update. Do not advance the durable content cursor from it.
      const self = message.status.peers.find((peer) => peer.clientId === this.clientId);
      if (self && self.role !== this.currentRole) {
        this.currentRole = self.role;
        transaction(this.db, () => {
          this.db.prepare('UPDATE document SET role=? WHERE id=1').run(self.role);
          if (self.role === 'viewer')
            this.db
              .prepare("UPDATE outbox SET state='rejected',reason=? WHERE state='pending'")
              .run('읽기 전용 권한으로 변경되었습니다.');
        });
      }
      this.emitState();
      return;
    }
    if (message.type === 'awareness') {
      unb64(message.update, 128 * 1024);
      this.emit('awareness', message.update);
    }
  }

  private validateStatus(status: ServerStatus): void {
    if (this.initialized && status.lineEnding !== this.currentLineEnding)
      throw new CairnError(
        'LINE_ENDING_MISMATCH',
        '같은 문서 세대의 줄바꿈 정책이 바뀌었습니다. 로컬 작업을 보존하고 확인하세요.',
      );
    if (
      status.serverId !== this.invite.serverId ||
      status.projectId !== this.invite.projectId ||
      status.fileId !== this.invite.fileId ||
      status.generation !== this.invite.generation ||
      status.fileName !== this.invite.fileName
    )
      throw new CairnError(
        'IDENTITY_MISMATCH',
        '서버 프로젝트 또는 문서 세대가 달라졌습니다. 로컬 변경은 보존되었습니다.',
      );
  }
  private preserveRejectedCandidate(candidate: Y.Doc, reason: unknown): never {
    const safeReason = publicError(reason);
    try {
      const state = Y.encodeStateAsUpdate(candidate);
      const text = candidate.getText('content').toString();
      if (state.byteLength + Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024)
        throw new CairnError('RECOVERY_SIZE_LIMIT', '복구 사본의 16 MiB 한도를 초과했습니다.');
      const stem = `rejected-local-${Date.now()}-${randomUUID()}`;
      // Unique immutable files: retain a successful first write even if the second fails.
      writeDurable(path.join(this.recoveryDir, `${stem}.yjs`), state);
      writeDurable(path.join(this.recoveryDir, `${stem}.txt`), text);
    } catch (error) {
      const failure = publicError(error);
      throw new CairnError(
        'LOCAL_RECOVERY_FAILED',
        `${safeReason.message} 복구 사본 저장을 완료하지 못했습니다: ${failure.message} 현재 입력은 메모리에만 있을 수 있습니다. 창을 닫지 말고 내용을 별도로 보관하거나 실행 취소하세요. 정상 문서와 전송 대기 기록은 변경하지 않았습니다.`,
      );
    }
    throw new CairnError(
      'LOCAL_UPDATE_RECOVERED',
      `${safeReason.message} 적용할 수 없는 입력의 텍스트와 Yjs 복구 사본을 .cairn-next-client/recovery에 저장했습니다. 정상 문서와 전송 대기 기록은 변경하지 않았습니다. 입력을 줄이거나 실행 취소한 뒤 다시 저장하세요.`,
    );
  }
  private replaceDocs(local: Y.Doc, server: Y.Doc): void {
    this.localDoc.destroy();
    this.serverDoc.destroy();
    this.localDoc = local;
    this.serverDoc = server;
  }
  private materialize(): void {
    if (!this.initialized) return;
    const result = projectFile(
      this.directory,
      this.invite.fileName,
      this.localDoc.getText('content').toString(),
      this.diskHash,
      this.recoveryDir,
    );
    this.localProjection = result.state;
    if (result.state === 'applied' && result.hash) this.diskHash = result.hash;
    try {
      this.db
        .prepare('UPDATE document SET disk_hash=?,projection=? WHERE id=1')
        .run(this.diskHash, this.localProjection);
    } catch {
      this.localProjection = 'error';
      this.lastError = {
        code: 'PROJECTION_RECORD_FAILED',
        message:
          '문서는 보관되었으나 파일 반영 결과를 기록하지 못했습니다. 저장 공간과 권한을 확인하세요.',
      };
      return;
    }
    if (result.state === 'blocked' || result.state === 'error')
      this.lastError = {
        code: result.state === 'blocked' ? 'EXTERNAL_CONFLICT' : 'PROJECTION_FAILED',
        message:
          result.error ??
          (result.state === 'blocked'
            ? '외부 파일 변경을 발견했습니다. 작업 사본과 복구 사본을 보존했으며 자동 덮어쓰기를 중지했습니다.'
            : '작업 파일 반영에 실패했습니다. 저장 공간·권한·파일 잠금을 확인한 뒤 재시도하세요.'),
      };
    else if (
      result.state === 'applied' &&
      [
        'EXTERNAL_CONFLICT',
        'PROJECTION_FAILED',
        'PROJECTION_RECORD_FAILED',
        'UNSAFE_WORKING_FILE',
      ].includes(this.lastError?.code ?? '')
    )
      this.lastError = undefined;
  }
  private inspectWorkingFile(): void {
    if (this.closed || !this.initialized) return;
    try {
      const target = safeChild(this.directory, this.invite.fileName);
      if (fs.existsSync(target) && fs.statSync(target).size > MAX_TEXT_BYTES) {
        this.materialize();
        this.emitState();
        this.reportApplied();
        return;
      }
      const current = fs.existsSync(target) ? hash(readBounded(target)) : null;
      const desired = hash(this.localDoc.getText('content').toString());
      // Own writes are identified by content, never by an arbitrary ignore interval.
      if (current === desired && this.localProjection === 'applied') return;
      const previous = this.localProjection;
      this.materialize();
      if (previous !== this.localProjection || current !== desired) {
        this.emitState();
        this.reportApplied();
      }
    } catch {
      this.localProjection = 'error';
      this.lastError = {
        code: 'UNSAFE_WORKING_FILE',
        message: '작업 파일을 안전하게 확인할 수 없습니다. 파일 종류와 권한을 확인하세요.',
      };
      this.emitState();
      this.reportApplied();
    }
  }
  private flushOutbox(): void {
    if (!this.ready || this.inFlight) return;
    if (
      (
        this.db.prepare("SELECT count(*) AS count FROM outbox WHERE state='rejected'").get() as {
          count: number;
        }
      ).count > 0
    )
      return;
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY seq LIMIT 1")
      .get() as unknown as OutboxRow | undefined;
    if (!row) return;
    this.inFlight = row.op_id;
    this.send({
      type: 'update',
      opId: row.op_id,
      fileId: this.invite.fileId,
      generation: this.invite.generation,
      update: b64(row.binary_update),
    });
    this.scheduleOperationRetry();
  }
  private scheduleOperationRetry(): void {
    if (this.operationTimer) clearTimeout(this.operationTimer);
    if (!this.ready) return;
    this.operationTimer = setTimeout(() => {
      this.operationTimer = undefined;
      this.inFlight = null;
      this.operationRetryDelay = Math.min(this.operationRetryDelay * 2, 10000);
      this.flushOutbox();
    }, this.operationRetryDelay);
  }
  private clearInFlight(): void {
    this.inFlight = null;
    if (this.operationTimer) clearTimeout(this.operationTimer);
    this.operationTimer = undefined;
  }
  private reportApplied(): void {
    if (!this.ready) return;
    const state = this.snapshot();
    this.send({
      type: 'applied',
      revision: this.serverRevision,
      hash: hash(state.text),
      projection:
        state.pending === 0 &&
        state.rejected === 0 &&
        state.localProjection === 'applied' &&
        hash(state.text) === this.serverHash
          ? 'applied'
          : 'pending',
    });
  }
  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private emitState(): void {
    if (!this.closed) this.emit('state', this.snapshot());
  }
  private assertOpen(): void {
    if (this.closed) throw new CairnError('CLIENT_CLOSED', '클라이언트가 종료되었습니다.');
  }
  private finishConnect(error?: Error): void {
    const resolve = this.resolveConnect,
      reject = this.rejectConnect;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    this.connectionPromise = null;
    if (error) reject?.(error);
    else resolve?.();
  }
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    const attempt = this.attempt;
    if (!socket || !this.ready) return;
    const current = () =>
      !this.closed && this.ready && this.attempt === attempt && this.socket === socket;
    const ping = () => {
      if (!current() || socket.readyState !== WebSocket.OPEN) return;
      const nonce = randomUUID();
      this.awaitingPongs.add(nonce);
      // Delayed replies are accepted only for this connection's recent probes.
      if (this.awaitingPongs.size > 4) {
        const oldest = this.awaitingPongs.values().next().value;
        if (oldest) this.awaitingPongs.delete(oldest);
      }
      try {
        socket.ping(nonce, undefined, (error?: Error) => {
          if (error && current()) this.failConnection(error, false);
        });
      } catch (error) {
        if (current()) this.failConnection(error, false);
      }
    };
    this.resetHeartbeatDeadline(socket, attempt);
    this.heartbeatTimer = setInterval(ping, 5000);
    this.heartbeatTimer.unref();
    ping();
  }
  private resetHeartbeatDeadline(socket: WebSocket, attempt: number): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = setTimeout(() => {
      if (this.closed || !this.ready || this.attempt !== attempt || this.socket !== socket) return;
      this.failConnection(
        new CairnError(
          'HEARTBEAT_TIMEOUT',
          '15초 동안 서버의 응답이 확인되지 않았습니다. 서버 상태와 네트워크를 확인하세요. 로컬 변경은 보존되며 다시 연결합니다.',
        ),
        false,
      );
    }, 15000);
    this.heartbeatDeadline.unref();
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = undefined;
    this.heartbeatDeadline = undefined;
    this.awaitingPongs.clear();
  }
  private dropSocket(): void {
    ++this.attempt;
    this.ready = false;
    this.stopHeartbeat();
    this.clearInFlight();
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners('message');
      socket.removeAllListeners('open');
      socket.removeAllListeners('pong');
      socket.on('error', () => {});
      socket.terminate();
    }
    this.tlsAgent?.destroy();
    this.tlsAgent = null;
  }
  private failConnection(error: unknown, permanent: boolean): void {
    this.dropSocket();
    this.serverStatus = null;
    this.lastError = publicError(error);
    this.connection = permanent ? 'error' : 'offline';
    if (permanent) this.wantsConnection = false;
    this.finishConnect(error instanceof Error ? error : new Error('연결 실패'));
    this.emitState();
    if (this.wantsConnection && !this.closed) {
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 10000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connect().catch(() => {});
      }, delay);
    }
  }
}

function isCertificateError(error: Error): boolean {
  return /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|INVALID_CERTIFICATE/.test(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}
