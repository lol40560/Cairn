import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpsServer } from 'node:https';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { modifyAwarenessUpdate } from 'y-protocols/awareness';
import { generate } from 'selfsigned';
import { watch, type FSWatcher } from 'chokidar';
import { z } from 'zod';
import {
  MAX_TEXT_BYTES,
  MAX_UPDATE_BYTES,
  PROTOCOL_VERSION,
  type HostOptions,
  type Invite,
  type Role,
  type Projection,
  type ServerMessage,
  type ServerStatus,
  type LineEnding,
} from '../shared/types.js';
import {
  acquireOwnership,
  b64,
  CairnError,
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
  utf8,
} from './common.js';

interface ProjectRow {
  server_id: string;
  project_id: string;
  file_id: string;
  generation: number;
  file_name: string;
  name: string;
  certificate: string;
  private_key: string;
  state: Uint8Array;
  revision: number;
  hash: string;
  projected_hash: string | null;
  projection: Projection;
  projection_error: string | null;
  saved_at: number;
  line_ending: LineEnding;
}
interface MemberRow {
  id: string;
  token_hash: string;
  role: Role;
  expires_at: number;
  revoked: number;
}
interface OperationRow {
  op_id: string;
  member_id: string;
  payload_hash: string;
  revision: number;
  hash: string;
}
interface Session {
  socket: WebSocket;
  memberId?: string;
  clientId?: string;
  name?: string;
  role?: Role;
  appliedRevision: number;
  appliedHash: string;
  projection: Projection;
  alive: boolean;
  windowStart: number;
  messages: number;
  bytes: number;
  helloTimeout: ReturnType<typeof setTimeout>;
  awarenessId?: number;
}

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const helloSchema = z
  .object({
    type: z.literal('hello'),
    version: z.number().int(),
    serverId: id,
    projectId: id,
    fileId: id,
    generation: z.number().int().positive(),
    token: z.string().min(16).max(256),
    clientId: id,
    name: z.string().trim().min(1).max(60),
  })
  .strict();
const updateSchema = z
  .object({
    type: z.literal('update'),
    opId: id,
    fileId: id,
    generation: z.number().int().positive(),
    update: z.string().max(Math.ceil(MAX_UPDATE_BYTES / 3) * 4),
  })
  .strict();
const appliedSchema = z
  .object({
    type: z.literal('applied'),
    revision: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    projection: z.enum(['pending', 'applied', 'blocked', 'error']),
  })
  .strict();
const awarenessSchema = z
  .object({ type: z.literal('awareness'), update: z.string().max(45_000) })
  .strict();
const relativeIdSchema = z
  .object({
    client: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const relativePositionSchema = z
  .object({
    type: relativeIdSchema.nullable().optional(),
    tname: z.literal('content').nullable().optional(),
    item: relativeIdSchema.nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .strict();
const selectionSchema = z
  .object({ anchor: relativePositionSchema, head: relativePositionSchema })
  .strict()
  .nullable();

/** One awareness entry per socket; identities cannot be overwritten by another socket. */
function awarenessId(bytes: Uint8Array): number {
  let offset = 0;
  const integer = () => {
    let n = 0,
      m = 1;
    for (let i = 0; i < 8; i++) {
      if (offset >= bytes.length)
        throw new CairnError('INVALID_AWARENESS', '잘못된 편집 상태입니다.');
      const b = bytes[offset++]!;
      n += (b & 127) * m;
      if (!(b & 128)) {
        if (!Number.isSafeInteger(n)) break;
        return n;
      }
      m *= 128;
    }
    throw new CairnError('INVALID_AWARENESS', '잘못된 편집 상태입니다.');
  };
  if (integer() !== 1)
    throw new CairnError(
      'INVALID_AWARENESS',
      '한 연결은 자신의 편집 상태 하나만 전송할 수 있습니다.',
    );
  const client = integer();
  integer();
  const length = integer();
  if (length !== bytes.length - offset)
    throw new CairnError('INVALID_AWARENESS', '편집 상태 길이가 올바르지 않습니다.');
  return client;
}

function validateDocument(doc: Y.Doc): void {
  const content = doc.getText('content');
  if ([...doc.share.keys()].some((key) => key !== 'content'))
    throw new CairnError('INVALID_UPDATE', '이 문서는 content 텍스트만 지원합니다.');
  for (const part of content.toDelta())
    if (typeof part.insert !== 'string' || (part.attributes && Object.keys(part.attributes).length))
      throw new CairnError('INVALID_UPDATE', '일반 UTF-8 텍스트만 편집할 수 있습니다.');
  textBytes(content.toString());
  if (Y.encodeStateAsUpdate(doc).length > MAX_UPDATE_BYTES)
    throw new CairnError(
      'STATE_LIMIT',
      '문서 기록의 4 MiB 제한을 초과했습니다. 로컬 변경을 별도 사본으로 보존하세요.',
    );
}

export class CairnServer extends EventEmitter {
  private root = '';
  private dataDir = '';
  private recoveryDir = '';
  private release?: () => void;
  private db?: DatabaseSync;
  private project!: ProjectRow;
  private document = new Y.Doc();
  private https?: HttpsServer;
  private wss?: WebSocketServer;
  private sessions = new Map<WebSocket, Session>();
  private awareness = new Map<number, { owner: WebSocket; update: Uint8Array }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private projectionTask?: ReturnType<typeof setImmediate>;
  private watcher?: FSWatcher;
  private observedDiskSignature?: string;
  private closed = false;
  private listening = false;
  private port = 0;

  private constructor() {
    super();
    this.on('error', () => {});
    this.document.getText('content');
  }
  static async start(options: HostOptions): Promise<CairnServer> {
    const server = new CairnServer();
    try {
      await server.initialize(options);
      return server;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  private async initialize(options: HostOptions): Promise<void> {
    this.root = ensureRoot(options.root, 'server');
    this.dataDir = privateDir(this.root, '.cairn-next');
    this.release = acquireOwnership(this.dataDir);
    this.recoveryDir = privateDir(this.dataDir, 'recovery');
    this.db = openDb(path.join(this.dataDir, 'server.sqlite'));
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), server_id TEXT NOT NULL, project_id TEXT NOT NULL, file_id TEXT NOT NULL, generation INTEGER NOT NULL, file_name TEXT NOT NULL, name TEXT NOT NULL, certificate TEXT NOT NULL, private_key TEXT NOT NULL, state BLOB NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, projected_hash TEXT, projection TEXT NOT NULL, projection_error TEXT, saved_at INTEGER NOT NULL, line_ending TEXT NOT NULL DEFAULT 'lf');
   CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS operations (op_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER UNIQUE NOT NULL, hash TEXT NOT NULL, binary_update BLOB NOT NULL, saved_at INTEGER NOT NULL);`);
    const stored = this.db.prepare('SELECT * FROM project WHERE singleton=1').get() as unknown as
      ProjectRow | undefined;
    const hasLineEnding = this.db
      .prepare('PRAGMA table_info(project)')
      .all()
      .some((column) => column.name === 'line_ending');
    if (stored) {
      this.project = stored;
      if (options.fileName && options.fileName !== stored.file_name)
        throw new CairnError(
          'PROJECT_MISMATCH',
          '이 폴더는 이미 다른 파일을 관리합니다. 기존 파일 이름으로 다시 시작하세요.',
        );
      Y.applyUpdate(this.document, new Uint8Array(stored.state), 'load');
      validateDocument(this.document);
      if (hash(this.document.getText('content').toString()) !== stored.hash)
        throw new CairnError(
          'STATE_CORRUPT',
          '저장된 문서 hash가 일치하지 않습니다. 원본 DB를 보존하고 복구가 필요합니다.',
        );
      if (!hasLineEnding) {
        stored.line_ending = this.document.getText('content').toString().includes('\r\n')
          ? 'crlf'
          : 'lf';
        transaction(this.db, () => {
          this.db!.exec("ALTER TABLE project ADD COLUMN line_ending TEXT NOT NULL DEFAULT 'lf'");
          this.db!.prepare('UPDATE project SET line_ending=? WHERE singleton=1').run(
            stored.line_ending,
          );
        });
      }
      if (!['lf', 'crlf'].includes(stored.line_ending))
        throw new CairnError('STATE_CORRUPT', '저장된 줄바꿈 정책이 올바르지 않습니다.');
      checkLineEnding(this.document.getText('content').toString(), stored.line_ending);
    } else {
      if (!hasLineEnding)
        this.db.exec("ALTER TABLE project ADD COLUMN line_ending TEXT NOT NULL DEFAULT 'lf'");
      const selected = fileName(options.fileName ?? 'collaboration.txt');
      const target = safeChild(this.root, selected);
      if (fs.existsSync(target) && fs.statSync(target).size > MAX_TEXT_BYTES)
        throw new CairnError(
          'SIZE_LIMIT',
          '1단계 공유 파일은 1 MiB 이하 UTF-8 텍스트만 지원합니다. 원본 파일은 변경하지 않았습니다.',
        );
      const original = fs.existsSync(target) ? readBounded(target) : null;
      const initial = original ? utf8(original) : '';
      if (original && Buffer.from(initial, 'utf8').compare(original) !== 0)
        throw new CairnError(
          'UNSUPPORTED_ENCODING',
          '원본 바이트가 바뀌는 인코딩은 가져오지 않습니다. UTF-8 사본을 사용하세요.',
        );
      this.document.getText('content').insert(0, initial);
      const serverId = randomUUID();
      const commonName = `cairn-${serverId}`;
      const pems = await generate([{ name: 'commonName', value: commonName }], {
        keySize: 2048,
        algorithm: 'sha256',
        notBeforeDate: new Date(Date.now() - 60_000),
        notAfterDate: new Date(Date.now() + 365 * 86400_000),
        extensions: [
          { name: 'basicConstraints', cA: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 2, value: commonName }] },
        ],
      });
      this.project = {
        server_id: serverId,
        project_id: randomUUID(),
        file_id: randomUUID(),
        generation: 1,
        file_name: selected,
        name: (options.name ?? 'Cairn 서버').slice(0, 80),
        certificate: pems.cert,
        private_key: pems.private,
        state: Y.encodeStateAsUpdate(this.document),
        revision: 0,
        hash: hash(initial),
        projected_hash: original ? hash(original) : null,
        projection: 'pending',
        projection_error: null,
        saved_at: Date.now(),
        line_ending: initial.includes('\r\n') ? 'crlf' : 'lf',
      };
      const p = this.project;
      transaction(this.db, () =>
        this.db!.prepare('INSERT INTO project VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          p.server_id,
          p.project_id,
          p.file_id,
          p.generation,
          p.file_name,
          p.name,
          p.certificate,
          p.private_key,
          p.state,
          p.revision,
          p.hash,
          p.projected_hash,
          p.projection,
          p.projection_error,
          p.saved_at,
          p.line_ending,
        ),
      );
    }
    this.retryProjection();
    const watched = safeChild(this.root, this.project.file_name);
    this.watcher = watch(watched, {
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on('all', () => this.inspectProjectionFile());
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once('ready', resolve);
      this.watcher!.once('error', reject);
    });
    this.watcher.on('error', (error) => {
      this.project = {
        ...this.project,
        projection: 'error',
        projection_error: publicError(error).message,
      };
      this.emit('error', publicError(error));
      this.notify();
    });
    this.inspectProjectionFile();
    this.https = createServer(
      {
        key: this.project.private_key,
        cert: this.project.certificate,
        minVersion: 'TLSv1.2',
        handshakeTimeout: 5000,
      },
      (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Cairn authenticated WebSocket endpoint');
      },
    );
    this.https.maxConnections = 64;
    this.https.requestTimeout = 10_000;
    this.https.headersTimeout = 10_000;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: Math.ceil(MAX_UPDATE_BYTES / 3) * 4 + 2048,
      perMessageDeflate: false,
    });
    this.https.on('upgrade', (req, socket, head) => {
      if (req.url !== '/cairn' || this.sessions.size >= 32 || this.closed) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit('connection', ws, req));
    });
    this.wss.on('connection', (socket) => this.connected(socket));
    this.https.on('error', (error) => this.emit('error', publicError(error)));
    const requested = options.port ?? 47123;
    if (!Number.isInteger(requested) || requested < 0 || requested > 65535)
      throw new CairnError('INVALID_PORT', '포트는 0–65535 범위여야 합니다.');
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.https!.once('error', fail);
      this.https!.listen(requested, options.host ?? '0.0.0.0', () => {
        this.https!.off('error', fail);
        this.listening = true;
        resolve();
      });
    });
    const address = this.https.address();
    this.port = typeof address === 'object' && address ? address.port : requested;
    this.heartbeat = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.alive) {
          session.socket.terminate();
          continue;
        }
        if (session.memberId) {
          try {
            this.authorize(session);
          } catch (error) {
            this.fail(session, error, true);
            continue;
          }
        }
        session.alive = false;
        session.socket.ping();
      }
    }, 10_000);
    this.heartbeat.unref();
    this.notify();
  }

  status(): ServerStatus {
    const p = this.project;
    const peers = [...this.sessions.values()]
      .filter((s) => s.memberId && s.socket.readyState === WebSocket.OPEN)
      .map((s) => ({
        clientId: s.clientId!,
        name: s.name!,
        role: s.role!,
        appliedRevision: s.appliedRevision,
        projection: s.projection,
      }));
    const addresses = Object.values(networkInterfaces()).flatMap((items) =>
      (items ?? [])
        .filter((n) => n.family === 'IPv4' && !n.internal)
        .map((n) => `wss://${n.address}:${this.port}/cairn`),
    );
    const authenticated = [...this.sessions.values()].filter(
      (s) => s.memberId && s.socket.readyState === WebSocket.OPEN,
    );
    const confirmed =
      p.projection === 'applied' &&
      authenticated.length > 0 &&
      authenticated.every(
        (s) =>
          s.appliedRevision === p.revision &&
          s.appliedHash === p.hash &&
          s.projection === 'applied',
      );
    return {
      serverId: p.server_id,
      projectId: p.project_id,
      fileId: p.file_id,
      generation: p.generation,
      fileName: p.file_name,
      lineEnding: p.line_ending,
      name: p.name,
      port: this.port,
      addresses: [...new Set(addresses)],
      revision: p.revision,
      hash: p.hash,
      projection: p.projection,
      ...(p.projection_error ? { projectionError: p.projection_error } : {}),
      peers,
      confirmedRevision: confirmed ? p.revision : null,
      lastSavedAt: p.saved_at,
    };
  }

  invite(role: Role, address?: string, ttlMs = 24 * 60 * 60 * 1000): Invite {
    if (this.closed || !this.db)
      throw new CairnError('SERVER_STOPPED', '서버가 실행 중이 아닙니다.');
    if (
      !['owner', 'editor', 'viewer'].includes(role) ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > 30 * 86400_000
    )
      throw new CairnError('INVALID_INVITE', '권한 또는 초대 유효기간이 올바르지 않습니다.');
    const selected =
      address ??
      this.status().addresses[0] ??
      (role === 'owner' ? `wss://127.0.0.1:${this.port}/cairn` : undefined);
    if (!selected)
      throw new CairnError(
        'NO_SHARE_ADDRESS',
        '공유할 LAN 주소를 확인할 수 없습니다. 직접 주소를 입력하세요.',
      );
    const parsed = new URL(selected);
    if (
      parsed.protocol !== 'wss:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/cairn'
    )
      throw new CairnError('INVALID_ADDRESS', 'wss://주소:포트/cairn 형식을 사용하세요.');
    const token = randomBytes(32).toString('base64url');
    const memberId = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.db
      .prepare('INSERT INTO members (id,token_hash,role,expires_at) VALUES (?,?,?,?)')
      .run(memberId, hash(token), role, expiresAt);
    const p = this.project;
    return {
      version: PROTOCOL_VERSION,
      serverId: p.server_id,
      projectId: p.project_id,
      fileId: p.file_id,
      generation: p.generation,
      fileName: p.file_name,
      address: parsed.href,
      certificate: p.certificate,
      fingerprint: hash(new X509Certificate(p.certificate).raw),
      token,
      memberId,
      role,
      expiresAt,
    };
  }

  revoke(memberId: string): void {
    if (!this.db || this.closed) return;
    this.db.prepare('UPDATE members SET revoked=1 WHERE id=?').run(memberId);
    for (const session of this.sessions.values())
      if (session.memberId === memberId)
        this.fail(
          session,
          new CairnError(
            'ACCESS_REVOKED',
            '프로젝트 접근 권한이 회수되었습니다. 로컬 변경은 보존됩니다.',
          ),
          true,
        );
    this.notify();
  }

  private connected(socket: WebSocket): void {
    const session: Session = {
      socket,
      appliedRevision: -1,
      appliedHash: '',
      projection: 'pending',
      alive: true,
      windowStart: Date.now(),
      messages: 0,
      bytes: 0,
      helloTimeout: setTimeout(
        () =>
          this.fail(session, new CairnError('AUTH_TIMEOUT', '인증 시간이 초과되었습니다.'), true),
        5000,
      ),
    };
    this.sessions.set(socket, session);
    socket.on('pong', () => {
      session.alive = true;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(session.helloTimeout);
      this.sessions.delete(socket);
      if (session.awarenessId !== undefined) {
        const entry = this.awareness.get(session.awarenessId);
        if (entry?.owner === socket) {
          this.awareness.delete(session.awarenessId);
          this.broadcast({
            type: 'awareness',
            update: b64(modifyAwarenessUpdate(entry.update, () => null)),
          });
        }
      }
      if (!this.closed) this.notify();
    });
    socket.on('message', (raw, isBinary) => {
      if (this.closed || this.sessions.get(socket) !== session) return;
      let input: unknown;
      try {
        if (isBinary) throw new CairnError('INVALID_MESSAGE', 'JSON 메시지만 지원합니다.');
        const now = Date.now();
        if (now - session.windowStart > 1000) {
          session.windowStart = now;
          session.messages = 0;
          session.bytes = 0;
        }
        session.messages++;
        session.bytes += Array.isArray(raw)
          ? raw.reduce((n, b) => n + b.byteLength, 0)
          : raw.byteLength;
        if (session.messages > 240 || session.bytes > 12 * 1024 * 1024)
          throw new CairnError(
            'RATE_LIMIT',
            '메시지 한도를 초과했습니다. 잠시 뒤 다시 연결하세요.',
          );
        input = JSON.parse(raw.toString());
        this.handle(session, input);
      } catch (error) {
        const opId =
          typeof input === 'object' &&
          input !== null &&
          'opId' in input &&
          typeof input.opId === 'string'
            ? input.opId.slice(0, 128)
            : undefined;
        const code = error instanceof CairnError ? error.code : '';
        this.fail(
          session,
          error,
          !session.memberId || ['ACCESS_REVOKED', 'INVITE_EXPIRED', 'RATE_LIMIT'].includes(code),
          opId,
        );
      }
    });
  }

  private authorize(session: Session): MemberRow {
    if (!session.memberId) throw new CairnError('AUTH_REQUIRED', '먼저 인증해야 합니다.');
    const member = this.db!.prepare('SELECT * FROM members WHERE id=?').get(
      session.memberId,
    ) as unknown as MemberRow | undefined;
    if (!member || member.revoked)
      throw new CairnError(
        'ACCESS_REVOKED',
        '프로젝트 접근 권한이 회수되었습니다. 로컬 사본은 유지됩니다.',
      );
    if (member.expires_at <= Date.now())
      throw new CairnError(
        'INVITE_EXPIRED',
        '인증정보가 만료되었습니다. 호스트에게 새 초대를 요청하세요.',
      );
    session.role = member.role;
    return member;
  }

  private handle(session: Session, input: unknown): void {
    const type = (input as { type?: unknown } | null)?.type;
    if (type === 'hello') {
      if (session.memberId)
        throw new CairnError('ALREADY_AUTHENTICATED', '이미 인증된 연결입니다.');
      const m = helloSchema.parse(input);
      const p = this.project;
      if (m.version !== PROTOCOL_VERSION)
        throw new CairnError('VERSION_MISMATCH', '서버와 앱의 프로토콜 버전이 호환되지 않습니다.');
      const member = this.db!.prepare('SELECT * FROM members WHERE token_hash=?').get(
        hash(m.token),
      ) as unknown as MemberRow | undefined;
      if (!member || member.revoked)
        throw new CairnError('AUTH_FAILED', '인증정보가 올바르지 않거나 폐기되었습니다.');
      if (member.expires_at <= Date.now())
        throw new CairnError(
          'INVITE_EXPIRED',
          '초대가 만료되었습니다. 호스트에게 새 초대를 요청하세요.',
        );
      if (m.serverId !== p.server_id || m.projectId !== p.project_id || m.fileId !== p.file_id)
        throw new CairnError('PROJECT_MISMATCH', '초대와 서버의 프로젝트 신원이 다릅니다.');
      if (m.generation !== p.generation)
        throw new CairnError(
          'STALE_GENERATION',
          '복원 전 문서의 변경은 자동 적용할 수 없습니다. 로컬 사본을 보존하세요.',
        );
      const duplicate = [...this.sessions.values()].find(
        (s) => s !== session && s.clientId === m.clientId,
      );
      if (duplicate) {
        if (duplicate.memberId !== member.id)
          throw new CairnError('CLIENT_ID_IN_USE', '다른 참가자가 사용 중인 클라이언트 ID입니다.');
        duplicate.socket.close(4001, 'Reconnected');
        this.sessions.delete(duplicate.socket);
      }
      session.memberId = member.id;
      session.clientId = m.clientId;
      session.name = m.name.replace(/[\x00-\x1f\x7f]/g, '');
      session.role = member.role;
      clearTimeout(session.helloTimeout);
      this.send(session, {
        type: 'welcome',
        state: b64(Y.encodeStateAsUpdate(this.document)),
        role: member.role,
        status: this.status(),
      });
      for (const item of this.awareness.values())
        this.send(session, { type: 'awareness', update: b64(item.update) });
      this.notify();
      return;
    }
    const member = this.authorize(session);
    if (type === 'update') {
      const m = updateSchema.parse(input);
      const p = this.project;
      if (member.role === 'viewer')
        throw new CairnError(
          'READ_ONLY',
          '읽기 전용 사용자는 변경할 수 없습니다. 로컬 사본은 유지됩니다.',
        );
      if (m.fileId !== p.file_id)
        throw new CairnError('FILE_MISMATCH', '파일 ID가 일치하지 않습니다.');
      if (m.generation !== p.generation)
        throw new CairnError(
          'STALE_GENERATION',
          '문서 세대가 바뀌었습니다. 이전 변경은 검토가 필요합니다.',
        );
      const update = unb64(m.update);
      const payloadHash = hash(update);
      const previous = this.db!.prepare('SELECT * FROM operations WHERE op_id=?').get(
        m.opId,
      ) as unknown as OperationRow | undefined;
      if (previous) {
        if (previous.member_id !== member.id || previous.payload_hash !== payloadHash)
          throw new CairnError('OP_ID_COLLISION', '같은 operation ID에 다른 내용이 도착했습니다.');
        this.send(session, {
          type: 'ack',
          opId: m.opId,
          revision: previous.revision,
          hash: previous.hash,
        });
        return;
      }
      const candidate = new Y.Doc();
      candidate.getText('content');
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document), 'clone');
        Y.applyUpdate(candidate, update, 'remote');
        validateDocument(candidate);
        checkLineEnding(candidate.getText('content').toString(), p.line_ending);
        const state = Y.encodeStateAsUpdate(candidate);
        const nextHash = hash(candidate.getText('content').toString());
        const revision = p.revision + 1;
        const saved = Date.now();
        try {
          transaction(this.db!, () => {
            this.db!.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(
              m.opId,
              member.id,
              payloadHash,
              revision,
              nextHash,
              update,
              saved,
            );
            this.db!.prepare(
              "UPDATE project SET state=?, revision=?, hash=?, projection='pending', projection_error=NULL, saved_at=? WHERE singleton=1",
            ).run(state, revision, nextHash, saved);
          });
        } catch (error) {
          this.emit('error', publicError(error));
          throw new CairnError(
            'SERVER_SAVE_FAILED',
            '서버의 영속 저장에 실패했습니다. 완료 ACK를 보내지 않았습니다. 로컬 변경을 유지하고 저장 공간과 권한을 확인하세요.',
          );
        }
        const old = this.document;
        this.document = candidate;
        old.destroy();
        this.project = {
          ...p,
          state,
          revision,
          hash: nextHash,
          projection: 'pending',
          projection_error: null,
          saved_at: saved,
        };
        // SQLite synchronous FULL COMMIT has completed before the durable ACK is emitted.
        this.send(session, { type: 'ack', opId: m.opId, revision, hash: nextHash });
        this.broadcast({
          type: 'update',
          update: m.update,
          revision,
          hash: nextHash,
          opId: m.opId,
        });
        this.notify();
        this.scheduleProjection();
      } catch (error) {
        if (this.document !== candidate) candidate.destroy();
        if (error instanceof CairnError) throw error;
        if (error instanceof Error && /sqlite|disk|database/i.test(error.message)) throw error;
        throw new CairnError(
          'INVALID_UPDATE',
          'Yjs 변경을 적용할 수 없습니다. 로컬 변경은 유지됩니다.',
        );
      }
      return;
    }
    if (type === 'applied') {
      const m = appliedSchema.parse(input);
      if (m.revision > this.project.revision)
        throw new CairnError('INVALID_REVISION', '서버보다 앞선 revision을 확인할 수 없습니다.');
      session.appliedRevision = m.revision;
      session.appliedHash = m.hash;
      session.projection = m.projection;
      this.notify();
      return;
    }
    if (type === 'awareness') {
      const m = awarenessSchema.parse(input);
      const bytes = unb64(m.update, 32 * 1024);
      const number = awarenessId(bytes);
      const existing = this.awareness.get(number);
      if (session.awarenessId !== undefined && session.awarenessId !== number)
        throw new CairnError('INVALID_AWARENESS', '한 연결의 편집 identity는 변경할 수 없습니다.');
      if (existing && existing.owner !== session.socket)
        throw new CairnError('AWARENESS_IN_USE', '다른 참가자의 커서를 변경할 수 없습니다.');
      const colors = ['#6554c0', '#0b8c78', '#b56023', '#2a70bb', '#ad3b79'];
      const color = colors[parseInt(hash(member.id).slice(0, 4), 16) % colors.length]!;
      const cleaned = modifyAwarenessUpdate(bytes, (state) => {
        if (state === null) return null;
        if (typeof state !== 'object' || Array.isArray(state))
          throw new CairnError('INVALID_AWARENESS', '잘못된 편집 상태입니다.');
        const selection = selectionSchema.safeParse(state.selection ?? null);
        if (!selection.success)
          throw new CairnError('INVALID_AWARENESS', '커서 선택 영역이 올바르지 않습니다.');
        return {
          selection: selection.data,
          user: { name: session.name, color, colorLight: `${color}33` },
        };
      });
      session.awarenessId = number;
      this.awareness.set(number, { owner: session.socket, update: cleaned });
      this.broadcast({ type: 'awareness', update: b64(cleaned) });
      return;
    }
    if (type === 'retry-projection') {
      if (member.role !== 'owner')
        throw new CairnError('OWNER_REQUIRED', '서버 파일 반영 재시도는 Owner 권한이 필요합니다.');
      this.retryProjection();
      return;
    }
    throw new CairnError('INVALID_MESSAGE', '지원하지 않는 메시지입니다.');
  }

  private scheduleProjection(): void {
    if (this.projectionTask || this.closed) return;
    this.projectionTask = setImmediate(() => {
      this.projectionTask = undefined;
      this.retryProjection();
    });
  }
  private inspectProjectionFile(): void {
    if (this.closed || !this.project) return;
    let signature: string;
    try {
      const target = safeChild(this.root, this.project.file_name);
      if (!fs.existsSync(target)) signature = 'absent';
      else {
        const stat = fs.statSync(target);
        signature =
          stat.size > MAX_TEXT_BYTES
            ? `oversize-${stat.size}-${stat.mtimeMs}`
            : hash(readBounded(target));
      }
    } catch {
      signature = 'unsafe-or-unreadable';
    }
    if (signature === this.project.hash && this.project.projection === 'applied') {
      this.observedDiskSignature = signature;
      return;
    }
    if (signature === this.observedDiskSignature && this.project.projection !== 'pending') return;
    this.observedDiskSignature = signature;
    this.scheduleProjection();
  }
  retryProjection(): void {
    if (this.closed || !this.db || !this.project) return;
    const p = this.project;
    const result = projectFile(
      this.root,
      p.file_name,
      this.document.getText('content').toString(),
      p.projected_hash,
      this.recoveryDir,
    );
    try {
      const projected = result.state === 'applied' ? p.hash : p.projected_hash;
      this.db
        .prepare(
          'UPDATE project SET projection=?, projected_hash=?, projection_error=? WHERE singleton=1',
        )
        .run(result.state, projected, result.error ?? null);
      this.project = {
        ...p,
        projection: result.state,
        projected_hash: projected,
        projection_error: result.error ?? null,
      };
    } catch (error) {
      this.project = { ...p, projection: 'error', projection_error: publicError(error).message };
      this.emit('error', publicError(error));
    }
    this.notify();
  }
  private send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    if (session.socket.bufferedAmount > 16 * 1024 * 1024) {
      session.socket.close(4008, 'Slow client');
      return;
    }
    session.socket.send(JSON.stringify(message));
  }
  private broadcast(message: ServerMessage): void {
    for (const session of this.sessions.values())
      if (session.memberId) {
        try {
          this.authorize(session);
          this.send(session, message);
        } catch (error) {
          this.fail(session, error, true);
        }
      }
  }
  private notify(): void {
    if (!this.project || this.closed) return;
    const status = this.status();
    this.broadcast({ type: 'status', status });
    this.emit('status', status);
  }
  private fail(session: Session, error: unknown, close = false, opId?: string): void {
    const safe =
      error instanceof z.ZodError
        ? { code: 'INVALID_MESSAGE', message: '메시지 형식이 올바르지 않습니다.' }
        : publicError(error);
    this.send(session, { type: 'error', ...safe, ...(opId ? { opId } : {}) });
    if (close) session.socket.close(4003, safe.code);
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.projectionTask) clearImmediate(this.projectionTask);
    await this.watcher?.close();
    for (const session of this.sessions.values()) {
      clearTimeout(session.helloTimeout);
      session.socket.terminate();
    }
    this.sessions.clear();
    this.awareness.clear();
    if (this.wss) await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    if (this.https && this.listening)
      await new Promise<void>((resolve) => {
        this.https!.close(() => resolve());
        this.https!.closeAllConnections();
      });
    try {
      this.db?.close();
    } finally {
      this.db = undefined;
      this.release?.();
      this.release = undefined;
      this.document.destroy();
    }
  }
}
