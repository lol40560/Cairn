import { EventEmitter } from 'node:events';
import { Agent, createServer, type Server as HttpsServer } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { generate } from 'selfsigned';
import { modifyAwarenessUpdate } from 'y-protocols/awareness';
import { z } from 'zod';
import {
  TEAM_PROTOCOL,
  type Actor,
  type ProjectCommand,
  type ProjectEvent,
  type StoreQuery,
  type TeamInvite,
  type TeamStatus,
} from '../../shared/project.js';
import type { Role } from '../../shared/types.js';
import { b64, CairnError, hash, openDb, publicError, transaction, unb64 } from '../common.js';
import type { ProjectStore } from './store.js';

const FRAME_LIMIT = 24 * 1024 * 1024;
const BLOB_LIMIT = 16 * 1024 * 1024;
const CHUNK_LIMIT = 256 * 1024;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const relativePath = z.string().min(1).max(1024);
const roleSchema = z.enum(['owner', 'editor', 'viewer']);
const data = z.string().max(Math.ceil(BLOB_LIMIT / 3) * 4);
const source = z
  .object({
    kind: z.enum(['app', 'unknown', 'external', 'declared-ai', 'recovery']),
    tool: z.string().max(120).optional(),
  })
  .strict();
const common = { opId: id };
export const commandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('text'),
      fileId: id,
      generation,
      update: z.string().max(Math.ceil((4 * 1024 * 1024) / 3) * 4),
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('write'),
      fileId: id,
      generation,
      baseRevision: revision,
      baseHash: digest,
      data,
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('create'),
      path: relativePath,
      nodeKind: z.enum(['text', 'binary', 'directory']),
      data: data.optional(),
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('move'),
      fileId: id,
      path: relativePath,
      baseRevision: revision,
      expectedRevision: revision.optional(),
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('delete'),
      fileId: id,
      baseRevision: revision,
      expectedRevision: revision,
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('claim-create'),
      fileId: id,
      description: z.string().max(500),
      strict: z.boolean(),
      external: z.boolean(),
      source: source.optional(),
      ttlMs: z.number().int().min(1000).max(86400_000).optional(),
    })
    .strict(),
  ...(['claim-renew', 'claim-complete', 'claim-cancel'] as const).map((kind) =>
    z.object({ ...common, kind: z.literal(kind), claimId: id }).strict(),
  ),
  z
    .object({
      ...common,
      kind: z.literal('conflict-create'),
      fileId: id.nullable(),
      path: relativePath,
      reason: z.string().min(1).max(1000),
      generation: revision,
      revision,
      baseHash: digest.nullable(),
      localData: data.nullable(),
      localState: z
        .string()
        .max(Math.ceil((4 * 1024 * 1024) / 3) * 4)
        .optional(),
      remoteHash: digest.nullable(),
      source: source.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('conflict-resolve'),
      conflictId: id,
      choice: z.enum(['local', 'remote', 'both', 'merged']),
      expectedRevision: revision,
      data: data.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('checkpoint-create'),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('checkpoint-delete'),
      checkpointId: id,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('checkpoint-restore'),
      checkpointId: id,
      fileIds: z.array(id).max(5000).optional(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('trash-restore'),
      trashId: id,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('trash-purge'),
      trashIds: z.array(id).max(5000),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('settings'),
      ignorePatterns: z.array(z.string().max(512)).max(256).optional(),
      retentionDays: z.number().int().min(1).max(3650).optional(),
      strictClaims: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...common, kind: z.literal('rescan') }).strict(),
]);
export const querySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('activity'),
      search: z.string().max(200).optional(),
      fileId: id.optional(),
      actorId: id.optional(),
      source: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  ...(['conflicts', 'checkpoints', 'trash', 'claims', 'metadata'] as const).map((kind) =>
    z.object({ kind: z.literal(kind) }).strict(),
  ),
  z.object({ kind: z.literal('preview-delete'), fileId: id }).strict(),
  z
    .object({
      kind: z.literal('preview-checkpoint'),
      checkpointId: id,
      fileIds: z.array(id).max(5000).optional(),
    })
    .strict(),
]);
const helloSchema = z
  .object({
    type: z.literal('hello'),
    version: z.number().int(),
    teamId: id,
    projectId: id,
    memberId: id,
    token: z.string().min(16).max(256),
    clientId: id,
    name: z.string().trim().min(1).max(60),
  })
  .strict();
const requestSchema = z
  .object({ type: z.literal('request'), id, method: z.string().min(1).max(32), args: z.unknown() })
  .strict();
const appliedSchema = z
  .object({
    type: z.literal('applied'),
    revision,
    manifestHash: digest,
    projection: z.enum(['applied', 'pending', 'blocked']),
  })
  .strict();
const awarenessSchema = z
  .object({ type: z.literal('awareness'), fileId: id, generation, update: z.string().max(45000) })
  .strict();
const positionId = z.object({ client: revision, clock: revision }).strict();
const position = z
  .object({
    type: positionId.nullable().optional(),
    tname: z.literal('content').nullable().optional(),
    item: positionId.nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .strict();
const selectionSchema = z.object({ anchor: position, head: position }).strict().nullable();
const emptyArgs = z.union([z.null(), z.undefined(), z.object({}).strict()]);
const inviteSchema = z
  .object({
    version: z.literal(TEAM_PROTOCOL),
    teamId: id,
    projectId: id,
    projectName: z.string().min(1).max(80),
    address: z.string().max(2048),
    certificate: z.string().min(100).max(16384),
    fingerprint: z.string().regex(/^(?:[a-fA-F0-9]{2}:?){32}$/),
    token: z.string().min(16).max(256),
    memberId: id,
    role: roleSchema,
    expiresAt: revision,
  })
  .strict();

function address(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CairnError('INVALID_ADDRESS', 'Use a valid wss://address:port/team address.');
  }
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/team'
  )
    throw new CairnError('INVALID_ADDRESS', 'Use a valid wss://address:port/team address.');
  return url.href;
}
export function parseTeamInvite(input: string): TeamInvite {
  if (typeof input !== 'string' || input.length > 32768)
    throw new CairnError('INVALID_INVITE', 'The team invitation is invalid.');
  let parsed: ReturnType<typeof inviteSchema.parse>;
  try {
    parsed = inviteSchema.parse(JSON.parse(input));
  } catch {
    throw new CairnError('INVALID_INVITE', 'The team invitation or protocol version is invalid.');
  }
  const selected = address(parsed.address);
  if (parsed.expiresAt <= Date.now())
    throw new CairnError(
      'INVITE_EXPIRED',
      'This invitation has expired. Request a new invitation.',
    );
  try {
    const cert = new X509Certificate(parsed.certificate);
    const fingerprint = parsed.fingerprint.replaceAll(':', '').toLowerCase();
    if (
      hash(cert.raw) !== fingerprint ||
      !cert.checkHost(`cairn-${parsed.teamId}`) ||
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) <= Date.now()
    )
      throw new Error('certificate');
    return { ...parsed, address: selected, fingerprint };
  } catch {
    throw new CairnError(
      'INVALID_CERTIFICATE',
      'The invitation certificate does not match its team identity.',
    );
  }
}

interface Identity {
  team_id: string;
  project_id: string;
  certificate: string;
  private_key: string;
}
interface Grant {
  token_hash: string;
  member_id: string;
  role: Role;
  expires_at: number;
  revoked: number;
  display_name: string | null;
}
interface MemberSummary {
  memberId: string;
  name: string;
  role: Role;
  expiresAt: number;
  revoked: boolean;
  connected: boolean;
}
interface AwarenessEntry {
  fileId: string;
  generation: number;
  id: number;
  clock: number;
  update: Uint8Array;
  owner: Session;
}
interface Session {
  socket: WebSocket;
  grantHash?: string;
  memberId?: string;
  clientId?: string;
  name?: string;
  role?: Role;
  appliedRevision: number;
  appliedHash: string;
  projection: 'applied' | 'pending' | 'blocked';
  barrier?: { revision: number; manifestHash: string };
  awareness?: AwarenessEntry;
  timer: NodeJS.Timeout;
  lastPong: number;
  nonces: Set<string>;
  windowStart: number;
  messages: number;
  bytes: number;
}
const hosts = new WeakSet<ProjectStore>();

/** App-owned session. ProjectStore remains the only project database/watcher owner. */
export class TeamHost extends EventEmitter {
  private db!: DatabaseSync;
  private identity!: Identity;
  private https?: HttpsServer;
  private wss?: WebSocketServer;
  private sessions = new Map<WebSocket, Session>();
  private awarenessEntries = new Map<string, AwarenessEntry>();
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  private listening = false;
  private lan = false;
  private port = 0;
  private transition: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;
  private lastMembers: MemberSummary[] = [];
  private readonly changed = (event: ProjectEvent) => {
    if (this.closed) return;
    // Store emits only after COMMIT. Invalidate old barriers immediately: ws can
    // process a following barrier request in the same receiver turn. Deferring
    // this reset would erase that newly issued, already-current barrier.
    for (const s of this.sessions.values()) {
      s.barrier = undefined;
      s.projection = 'pending';
    }
    // Keep all network publication after apply() has returned its durable result.
    queueMicrotask(() => {
      if (!this.closed) {
        this.pruneAwareness();
        this.broadcast({ type: 'event', event });
        this.notify();
      }
    });
  };
  private readonly storeStatus = () =>
    queueMicrotask(() => {
      if (!this.closed) this.notify();
    });
  private readonly storeClosed = () => {
    void this.stop().catch((error) => this.emit('error', publicError(error)));
  };
  private constructor(
    private readonly store: ProjectStore,
    private readonly name: string,
  ) {
    super();
    this.on('error', () => {});
  }
  static async start(options: {
    store: ProjectStore;
    name: string;
    port?: number;
    lan?: boolean;
  }): Promise<TeamHost> {
    if (options.store.mode !== 'authority')
      throw new CairnError(
        'AUTHORITY_REQUIRED',
        'Only the local project authority can create a team.',
      );
    if (hosts.has(options.store))
      throw new CairnError('TEAM_RUNNING', 'This project already has a team session.');
    const name = options.name.trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
      throw new CairnError('INVALID_NAME', 'Choose a team name of 1–80 characters.');
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new CairnError('INVALID_PORT', 'Port must be between 0 and 65535.');
    const host = new TeamHost(options.store, name);
    hosts.add(options.store);
    try {
      await host.initialize();
      await host.listen(port, options.lan ?? false);
      host.store.on('change', host.changed);
      host.store.on('status', host.storeStatus);
      host.store.on('close', host.storeClosed);
      host.startHeartbeat();
      return host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }
  get teamId(): string {
    return this.identity.team_id;
  }
  get certificate(): string {
    return this.identity.certificate;
  }
  get fingerprint(): string {
    return hash(new X509Certificate(this.certificate).raw);
  }
  publicIdentity(): {
    teamId: string;
    projectId: string;
    certificate: string;
    fingerprint: string;
  } {
    return {
      teamId: this.teamId,
      projectId: this.store.projectId,
      certificate: this.certificate,
      fingerprint: this.fingerprint,
    };
  }
  private async initialize(): Promise<void> {
    const dbPath = path.join(this.store.dataDir, 'team.sqlite');
    for (const suffix of ['', '-wal', '-shm'])
      if (
        fs.existsSync(dbPath + suffix) &&
        (!fs.lstatSync(dbPath + suffix).isFile() || fs.lstatSync(dbPath + suffix).isSymbolicLink())
      )
        throw new CairnError('UNSAFE_PATH', 'The team identity path is unsafe.');
    this.db = openDb(dbPath);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS team_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),team_id TEXT NOT NULL,project_id TEXT NOT NULL,certificate TEXT NOT NULL,private_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_grants(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,display_name TEXT);`);
    const saved = this.db
      .prepare('SELECT * FROM team_identity WHERE singleton=1')
      .get() as unknown as Identity | undefined;
    if (saved) {
      if (saved.project_id !== this.store.projectId)
        throw new CairnError(
          'IDENTITY_MISMATCH',
          'The stored team belongs to a different project.',
        );
      this.identity = saved;
      return;
    }
    const teamId = randomUUID(),
      commonName = `cairn-${teamId}`;
    const pems = await generate([{ name: 'commonName', value: commonName }], {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60000),
      notAfterDate: new Date(Date.now() + 5 * 365 * 86400_000),
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: commonName }] },
      ],
    });
    this.identity = {
      team_id: teamId,
      project_id: this.store.projectId,
      certificate: pems.cert,
      private_key: pems.private,
    };
    transaction(this.db, () =>
      this.db
        .prepare('INSERT INTO team_identity VALUES(1,?,?,?,?)')
        .run(teamId, this.store.projectId, pems.cert, pems.private),
    );
  }
  private async listen(port: number, lan: boolean): Promise<void> {
    this.https = createServer(
      {
        key: this.identity.private_key,
        cert: this.certificate,
        minVersion: 'TLSv1.2',
        handshakeTimeout: 5000,
      },
      (_req, res) => {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('Authenticated team endpoint');
      },
    );
    this.https.maxConnections = 64;
    this.https.requestTimeout = 10000;
    this.https.headersTimeout = 10000;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: FRAME_LIMIT,
      perMessageDeflate: false,
    });
    const server = this.https,
      wss = this.wss;
    server.on('upgrade', (req, socket, head) => {
      if (this.closed || req.url !== '/team' || this.sessions.size >= 32) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    server.on('error', (error) => this.emit('error', publicError(error)));
    wss.on('error', (error) => this.emit('error', publicError(error)));
    wss.on('connection', (socket) => this.connected(socket));
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => reject(e);
      server.once('error', fail);
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
        server.off('error', fail);
        resolve();
      });
    });
    const bound = server.address();
    this.port = typeof bound === 'object' && bound ? bound.port : port;
    this.lan = lan;
    this.listening = true;
    this.notify();
  }
  status(): TeamStatus {
    const state = this.store.status();
    const online = [...this.sessions.values()].filter(
      (s) => s.memberId && s.socket.readyState === WebSocket.OPEN && this.valid(s),
    );
    const peers = online.map((s) => ({
      clientId: s.clientId!,
      memberId: s.memberId!,
      name: s.name!,
      role: s.role!,
      appliedRevision: s.appliedRevision,
      projection: s.projection,
      ...(s.awareness ? { activeFileId: s.awareness.fileId } : {}),
    }));
    const confirmed =
      this.listening &&
      online.length > 0 &&
      state.projections.every((p) => p.state === 'applied') &&
      online.every(
        (s) =>
          s.appliedRevision === state.revision &&
          s.appliedHash === state.manifestHash &&
          s.projection === 'applied' &&
          s.barrier?.revision === state.revision &&
          s.barrier.manifestHash === state.manifestHash,
      );
    const lanAddresses = this.lan
      ? Object.values(networkInterfaces()).flatMap((items) =>
          (items ?? [])
            .filter((n) => n.family === 'IPv4' && !n.internal)
            .map((n) => `wss://${n.address}:${this.port}/team`),
        )
      : [];
    return {
      teamId: this.teamId,
      projectId: this.store.projectId,
      name: this.name,
      enabled: this.lan && this.listening,
      port: this.port,
      addresses: [...new Set([...lanAddresses, `wss://127.0.0.1:${this.port}/team`])],
      peers,
      members: this.members(),
      revision: state.revision,
      manifestHash: state.manifestHash,
      confirmedRevision: confirmed ? state.revision : null,
    };
  }
  /** Public inventory includes expired/offline members; grants and token hashes never leave this DB. */
  members(): MemberSummary[] {
    if (this.closed) return this.lastMembers.map((member) => ({ ...member, connected: false }));
    const connected = new Set(
      [...this.sessions.values()]
        .filter(
          (session) =>
            session.memberId && session.socket.readyState === WebSocket.OPEN && this.valid(session),
        )
        .map((session) => session.memberId!),
    );
    const rows = this.db
      .prepare(
        `SELECT g.member_id, g.role, g.expires_at, g.revoked,
      (SELECT known.display_name FROM team_grants known WHERE known.member_id=g.member_id AND known.display_name IS NOT NULL ORDER BY known.rowid DESC LIMIT 1) AS display_name
      FROM team_grants g WHERE g.rowid=(SELECT MAX(latest.rowid) FROM team_grants latest WHERE latest.member_id=g.member_id)
      ORDER BY g.rowid`,
      )
      .all() as unknown as Omit<Grant, 'token_hash'>[];
    this.lastMembers = rows.map((row) => ({
      memberId: row.member_id,
      name: row.display_name ?? '',
      role: row.role,
      expiresAt: row.expires_at,
      revoked: Boolean(row.revoked),
      connected: connected.has(row.member_id),
    }));
    return this.lastMembers.map((member) => ({ ...member }));
  }
  invite(role: Role, addressInput?: string, ttlMs = 86400_000, renewMemberId?: string): TeamInvite {
    this.assertOpen();
    if (
      !roleSchema.safeParse(role).success ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > 30 * 86400_000
    )
      throw new CairnError('INVALID_INVITE', 'The invitation role or lifetime is invalid.');
    let renewal: MemberSummary | undefined;
    if (renewMemberId !== undefined) {
      if (!id.safeParse(renewMemberId).success)
        throw new CairnError('INVALID_MEMBER', 'The member identity is invalid.');
      renewal = this.members().find((member) => member.memberId === renewMemberId);
      if (!renewal)
        throw new CairnError('MEMBER_NOT_FOUND', 'Choose an existing team member to renew.');
      if (renewMemberId === this.store.ownerId || renewal.role === 'owner' || role === 'owner')
        throw new CairnError(
          'OWNER_REQUIRED',
          'Renewal cannot replace or grant the local project owner identity.',
        );
    }
    const selected = address(
      addressInput ??
        (role === 'owner' ? `wss://127.0.0.1:${this.port}/team` : this.status().addresses[0]!),
    );
    const token = randomBytes(32).toString('base64url'),
      memberId = renewal?.memberId ?? (role === 'owner' ? this.store.ownerId : randomUUID()),
      expiresAt = Date.now() + ttlMs;
    transaction(this.db, () => {
      if (renewal)
        this.db.prepare('UPDATE team_grants SET revoked=1 WHERE member_id=?').run(memberId);
      this.db
        .prepare(
          'INSERT INTO team_grants(token_hash,member_id,role,expires_at,display_name) VALUES(?,?,?,?,?)',
        )
        .run(hash(token), memberId, role, expiresAt, renewal?.name || null);
    });
    if (renewal)
      for (const session of this.sessions.values())
        if (session.memberId === memberId)
          this.fail(
            session,
            new CairnError(
              'ACCESS_REVOKED',
              'This invitation was replaced. Reconnect with the renewed invitation; local work is preserved.',
            ),
            true,
          );
    this.notify();
    return {
      version: TEAM_PROTOCOL,
      teamId: this.teamId,
      projectId: this.store.projectId,
      projectName: this.name,
      address: selected,
      certificate: this.certificate,
      fingerprint: this.fingerprint,
      token,
      memberId,
      role,
      expiresAt,
    };
  }
  setLan(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean')
      return Promise.reject(new CairnError('INVALID_ARGUMENT', 'LAN state must be boolean.'));
    const operation = this.transition.then(async () => {
      this.assertOpen();
      if (this.lan === enabled) return;
      const old = this.lan,
        port = this.port;
      await this.closeListener();
      try {
        await this.listen(port, enabled);
      } catch (error) {
        if (!this.closed) await this.listen(port, old);
        throw error;
      }
    });
    this.transition = operation.catch(() => {});
    return operation;
  }
  revoke(memberId: string): void {
    this.assertOpen();
    id.parse(memberId);
    if (memberId === this.store.ownerId)
      throw new CairnError('OWNER_REQUIRED', 'The local project owner cannot be revoked.');
    transaction(this.db, () =>
      this.db.prepare('UPDATE team_grants SET revoked=1 WHERE member_id=?').run(memberId),
    );
    for (const session of this.sessions.values())
      if (session.memberId === memberId)
        this.fail(session, new CairnError('ACCESS_REVOKED', 'Team access has been revoked.'), true);
    this.notify();
  }
  private valid(s: Session): boolean {
    try {
      this.authorize(s);
      return true;
    } catch {
      return false;
    }
  }
  private authorize(s: Session): Grant {
    if (!s.grantHash || !s.memberId)
      throw new CairnError('AUTH_REQUIRED', 'Authenticate before accessing this team.');
    const grant = this.db
      .prepare('SELECT * FROM team_grants WHERE token_hash=?')
      .get(s.grantHash) as unknown as Grant | undefined;
    if (!grant || grant.revoked || grant.member_id !== s.memberId)
      throw new CairnError('ACCESS_REVOKED', 'Team access has been revoked.');
    if (grant.expires_at <= Date.now())
      throw new CairnError('INVITE_EXPIRED', 'Team access has expired. Request a new invitation.');
    s.role = grant.role;
    return grant;
  }
  private connected(socket: WebSocket): void {
    const session: Session = {
      socket,
      appliedRevision: -1,
      appliedHash: '',
      projection: 'pending',
      lastPong: Date.now(),
      nonces: new Set(),
      windowStart: Date.now(),
      messages: 0,
      bytes: 0,
      timer: setTimeout(
        () => this.fail(session, new CairnError('AUTH_TIMEOUT', 'Authentication timed out.'), true),
        5000,
      ),
    };
    session.timer.unref();
    this.sessions.set(socket, session);
    socket.on('error', () => {});
    socket.on('pong', (raw) => {
      if (session.nonces.delete(raw.toString())) session.lastPong = Date.now();
    });
    socket.on('close', () => {
      clearTimeout(session.timer);
      this.clearAwareness(session);
      this.sessions.delete(socket);
      if (!this.closed) this.notify();
    });
    socket.on('message', (raw, binary) => {
      if (this.closed || this.sessions.get(socket) !== session) return;
      let input: unknown;
      try {
        const now = Date.now();
        if (now - session.windowStart > 1000) {
          session.windowStart = now;
          session.messages = 0;
          session.bytes = 0;
        }
        const size = Array.isArray(raw)
          ? raw.reduce((n, b) => n + b.byteLength, 0)
          : raw.byteLength;
        session.messages++;
        session.bytes += size;
        if (session.messages > 300 || session.bytes > 64 * 1024 * 1024)
          throw new CairnError('RATE_LIMIT', 'Too many requests. Reconnect after a short pause.');
        if (binary || size > FRAME_LIMIT)
          throw new CairnError('INVALID_MESSAGE', 'Only bounded JSON messages are supported.');
        input = JSON.parse(raw.toString());
        this.handle(session, input);
      } catch (error) {
        const requestId = (input as { id?: unknown } | null)?.id;
        this.fail(
          session,
          error,
          !session.memberId ||
            ['ACCESS_REVOKED', 'INVITE_EXPIRED', 'RATE_LIMIT'].includes(
              error instanceof CairnError ? error.code : '',
            ),
          typeof requestId === 'string' && id.safeParse(requestId).success ? requestId : undefined,
        );
      }
    });
  }
  private handle(s: Session, input: unknown): void {
    const type = (input as { type?: unknown } | null)?.type;
    if (type === 'hello') {
      if (s.memberId)
        throw new CairnError('ALREADY_AUTHENTICATED', 'This connection is already authenticated.');
      const m = helloSchema.parse(input);
      if (m.version !== TEAM_PROTOCOL)
        throw new CairnError('VERSION_MISMATCH', 'The app and team protocol versions differ.');
      if (m.teamId !== this.teamId || m.projectId !== this.store.projectId)
        throw new CairnError('IDENTITY_MISMATCH', 'This invitation belongs to a different team.');
      const grantHash = hash(m.token),
        grant = this.db
          .prepare('SELECT * FROM team_grants WHERE token_hash=?')
          .get(grantHash) as unknown as Grant | undefined;
      if (!grant || grant.revoked || grant.member_id !== m.memberId)
        throw new CairnError('AUTH_FAILED', 'The invitation is invalid or revoked.');
      if (grant.expires_at <= Date.now())
        throw new CairnError('INVITE_EXPIRED', 'This invitation has expired.');
      const duplicate = [...this.sessions.values()].find(
        (other) => other !== s && other.clientId === m.clientId,
      );
      if (duplicate) {
        if (duplicate.memberId !== grant.member_id)
          throw new CairnError('CLIENT_ID_IN_USE', 'Another member is using this client identity.');
        this.clearAwareness(duplicate);
        this.sessions.delete(duplicate.socket);
        duplicate.socket.close(4001, 'Reconnected');
      }
      const name = m.name.replace(/[\x00-\x1f\x7f]/g, '').trim();
      if (!name) throw new CairnError('INVALID_NAME', 'Choose a display name.');
      if (grant.display_name !== name)
        transaction(this.db, () =>
          this.db
            .prepare('UPDATE team_grants SET display_name=? WHERE member_id=?')
            .run(name, grant.member_id),
        );
      // A validated grant can rename only its own persistent member identity.
      // Keep concurrently connected sessions of that member consistent too.
      for (const active of this.sessions.values())
        if (active.memberId === grant.member_id) active.name = name;
      Object.assign(s, {
        grantHash,
        memberId: grant.member_id,
        clientId: m.clientId,
        name,
        role: grant.role,
      });
      clearTimeout(s.timer);
      this.send(s, { type: 'welcome', role: grant.role, status: this.status() });
      this.notify();
      return;
    }
    const member = this.authorize(s);
    if (type === 'applied') {
      const m = appliedSchema.parse(input),
        current = this.store.status();
      if (m.revision > current.revision)
        throw new CairnError('INVALID_REVISION', 'The applied revision is ahead of this team.');
      const verified =
        s.barrier?.revision === m.revision &&
        s.barrier.manifestHash === m.manifestHash &&
        m.revision === current.revision &&
        m.manifestHash === current.manifestHash;
      s.appliedRevision = m.revision;
      s.appliedHash = m.manifestHash;
      s.projection = verified ? m.projection : 'pending';
      this.notify();
      return;
    }
    if (type === 'awareness') {
      this.updateAwareness(s, awarenessSchema.parse(input));
      return;
    }
    const request = requestSchema.parse(input);
    let result: unknown;
    switch (request.method) {
      case 'snapshot':
        emptyArgs.parse(request.args);
        result = this.store.snapshot();
        break;
      case 'blob': {
        const a = z
          .object({
            hash: digest,
            offset: revision,
            length: z.number().int().min(1).max(CHUNK_LIMIT),
          })
          .strict()
          .parse(request.args);
        const blob = this.store.getBlob(a.hash);
        if (a.offset > blob.length)
          throw new CairnError('INVALID_RANGE', 'Blob offset exceeds its length.');
        result = {
          hash: a.hash,
          offset: a.offset,
          total: blob.length,
          data: b64(blob.subarray(a.offset, a.offset + a.length)),
        };
        break;
      }
      case 'events': {
        const a = z
          .object({ after: revision, limit: z.number().int().min(1).max(256).optional() })
          .strict()
          .parse(request.args);
        if (a.after > this.store.revision())
          throw new CairnError('INVALID_REVISION', 'The requested revision is ahead of this team.');
        result = this.store.eventsSince(a.after, a.limit ?? 256);
        break;
      }
      case 'barrier':
        emptyArgs.parse(request.args);
        result = s.barrier = {
          revision: this.store.revision(),
          manifestHash: this.store.manifestHash(),
        };
        break;
      case 'command': {
        if (member.role === 'viewer')
          throw new CairnError('READ_ONLY', 'Read-only members cannot change this project.');
        const a = z.object({ command: commandSchema }).strict().parse(request.args),
          command = a.command as ProjectCommand;
        if (
          ['settings', 'rescan', 'checkpoint-delete', 'checkpoint-restore', 'trash-purge'].includes(
            command.kind,
          ) &&
          member.role !== 'owner'
        )
          throw new CairnError('OWNER_REQUIRED', 'This action requires the project owner.');
        this.validatePayload(command);
        const actor: Actor = {
          id: member.member_id,
          name: s.name!,
          role: member.role,
          clientId: s.clientId,
          source: 'source' in command && command.source ? command.source : { kind: 'app' },
        };
        // apply returns only after the single SQLite COMMIT. The change listener defers broadcasts.
        result = this.store.apply(command, actor);
        break;
      }
      case 'query': {
        const a = z.object({ query: querySchema }).strict().parse(request.args);
        result = this.store.query(a.query as StoreQuery);
        break;
      }
      case 'members':
        emptyArgs.parse(request.args);
        result = this.members();
        break;
      case 'revoke': {
        if (member.role !== 'owner')
          throw new CairnError('OWNER_REQUIRED', 'Only the project owner can revoke access.');
        const a = z.object({ memberId: id }).strict().parse(request.args);
        this.revoke(a.memberId);
        result = { revoked: true };
        break;
      }
      default:
        throw new CairnError('INVALID_METHOD', 'This team operation is not supported.');
    }
    this.send(s, { type: 'response', id: request.id, ok: true, result });
  }
  private validatePayload(command: ProjectCommand): void {
    if (command.kind === 'text') unb64(command.update, 4 * 1024 * 1024);
    if ('data' in command && command.data !== undefined) unb64(command.data, BLOB_LIMIT);
    if (command.kind === 'conflict-create') {
      if (command.localData !== null) unb64(command.localData, BLOB_LIMIT);
      if (command.localState !== undefined) unb64(command.localState, 4 * 1024 * 1024);
    }
  }
  private updateAwareness(s: Session, m: z.infer<typeof awarenessSchema>): void {
    const file = this.store.file(m.fileId);
    if (!file || file.deleted || file.kind !== 'text' || file.generation !== m.generation)
      throw new CairnError('STALE_GENERATION', 'The selected document is no longer current.');
    const bytes = unb64(m.update, 32 * 1024),
      entry = parseAwareness(bytes),
      key = `${m.fileId}:${m.generation}:${entry.id}`;
    const existing = this.awarenessEntries.get(key);
    if (existing && existing.owner !== s)
      throw new CairnError('AWARENESS_IN_USE', 'Another member owns this cursor.');
    const same = s.awareness?.fileId === m.fileId && s.awareness.generation === m.generation;
    if (same && s.awareness && (s.awareness.id !== entry.id || entry.clock < s.awareness.clock))
      throw new CairnError('INVALID_AWARENESS', 'Cursor identity or clock is invalid.');
    const color = ['#6554c0', '#0b8c78', '#b56023', '#2a70bb', '#ad3b79'][
      parseInt(hash(s.memberId!).slice(0, 4), 16) % 5
    ]!;
    let removed = false;
    const cleaned = modifyAwarenessUpdate(bytes, (state) => {
      if (state === null) {
        removed = true;
        return null;
      }
      if (typeof state !== 'object' || Array.isArray(state))
        throw new CairnError('INVALID_AWARENESS', 'The cursor state is invalid.');
      const selection = selectionSchema.safeParse(state.selection ?? null);
      if (!selection.success)
        throw new CairnError('INVALID_AWARENESS', 'The cursor selection is invalid.');
      return { selection: selection.data, user: { name: s.name, color, colorLight: `${color}33` } };
    });
    if (removed) {
      if (same) this.clearAwareness(s);
      this.notify();
      return;
    }
    if (!same) {
      this.clearAwareness(s);
      for (const other of this.awarenessEntries.values())
        if (other.fileId === m.fileId && other.generation === m.generation)
          this.send(s, {
            type: 'awareness',
            fileId: m.fileId,
            generation: m.generation,
            update: b64(other.update),
          });
    }
    const next: AwarenessEntry = {
      fileId: m.fileId,
      generation: m.generation,
      id: entry.id,
      clock: entry.clock,
      update: cleaned,
      owner: s,
    };
    s.awareness = next;
    this.awarenessEntries.set(key, next);
    this.broadcastAwareness(next, cleaned);
    if (!same) this.notify();
  }
  private clearAwareness(s: Session): void {
    const old = s.awareness;
    if (!old) return;
    this.awarenessEntries.delete(`${old.fileId}:${old.generation}:${old.id}`);
    s.awareness = undefined;
    this.broadcastAwareness(
      old,
      modifyAwarenessUpdate(old.update, () => null),
    );
  }
  private pruneAwareness(): void {
    for (const s of this.sessions.values()) {
      const a = s.awareness;
      if (a) {
        const file = this.store.file(a.fileId);
        if (!file || file.deleted || file.generation !== a.generation) this.clearAwareness(s);
      }
    }
  }
  private broadcastAwareness(entry: AwarenessEntry, update: Uint8Array): void {
    for (const s of this.sessions.values())
      if (
        s.awareness?.fileId === entry.fileId &&
        s.awareness.generation === entry.generation &&
        this.valid(s)
      )
        this.send(s, {
          type: 'awareness',
          fileId: entry.fileId,
          generation: entry.generation,
          update: b64(update),
        });
  }
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      for (const s of this.sessions.values()) {
        try {
          if (s.memberId) this.authorize(s);
          if (Date.now() - s.lastPong > 15000)
            throw new CairnError('HEARTBEAT_TIMEOUT', 'The peer stopped responding.');
          if (s.socket.readyState === WebSocket.OPEN) {
            const nonce = randomUUID();
            s.nonces.add(nonce);
            while (s.nonces.size > 4) s.nonces.delete(s.nonces.values().next().value!);
            s.socket.ping(nonce, undefined, (error) => {
              if (error) s.socket.terminate();
            });
          }
        } catch (error) {
          this.fail(s, error, true);
        }
      }
    }, 5000);
    this.heartbeat.unref();
  }
  private send(s: Session, message: unknown): void {
    if (s.socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > FRAME_LIMIT) {
      this.fail(
        s,
        new CairnError('SIZE_LIMIT', 'The team response exceeds its supported limit.'),
        true,
      );
      return;
    }
    if (s.socket.bufferedAmount > 2 * FRAME_LIMIT) {
      s.socket.terminate();
      return;
    }
    s.socket.send(payload, (error) => {
      if (error) s.socket.terminate();
    });
  }
  private broadcast(message: unknown): void {
    for (const s of this.sessions.values())
      if (s.memberId) {
        try {
          this.authorize(s);
          this.send(s, message);
        } catch (error) {
          this.fail(s, error, true);
        }
      }
  }
  private notify(): void {
    if (!this.identity || this.closed) return;
    const status = this.status();
    this.emit('status', status);
    this.broadcast({ type: 'status', status });
  }
  private fail(s: Session, error: unknown, close: boolean, requestId?: string): void {
    const safe =
      error instanceof z.ZodError
        ? { code: 'INVALID_MESSAGE', message: 'The request shape or size is invalid.' }
        : publicError(error);
    this.send(
      s,
      requestId
        ? { type: 'response', id: requestId, ok: false, error: safe }
        : { type: 'error', ...safe },
    );
    if (close) {
      this.clearAwareness(s);
      s.memberId = undefined;
      s.socket.close(4003, 'Access or connection ended');
      setTimeout(() => s.socket.terminate(), 250).unref();
    }
  }
  private assertOpen(): void {
    if (this.closed || !this.listening)
      throw new CairnError('TEAM_STOPPED', 'This project team is not running.');
  }
  private async closeListener(): Promise<void> {
    this.listening = false;
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer);
      s.socket.terminate();
    }
    this.sessions.clear();
    this.awarenessEntries.clear();
    const wss = this.wss,
      server = this.https;
    this.wss = undefined;
    this.https = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.store.off('change', this.changed);
    this.store.off('status', this.storeStatus);
    this.store.off('close', this.storeClosed);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopping = (async () => {
      await this.transition;
      await this.closeListener();
      this.db?.close();
      hosts.delete(this.store);
    })();
    return this.stopping;
  }
}

function parseAwareness(bytes: Uint8Array): { id: number; clock: number } {
  let offset = 0;
  const integer = () => {
    let value = 0,
      multiplier = 1;
    for (let i = 0; i < 8; i++) {
      if (offset >= bytes.length) break;
      const byte = bytes[offset++]!;
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) {
        if (Number.isSafeInteger(value)) return value;
        break;
      }
      multiplier *= 128;
    }
    throw new CairnError('INVALID_AWARENESS', 'The cursor encoding is invalid.');
  };
  if (integer() !== 1)
    throw new CairnError('INVALID_AWARENESS', 'A connection may publish only its own cursor.');
  const client = integer(),
    clock = integer(),
    length = integer();
  if (length !== bytes.length - offset)
    throw new CairnError('INVALID_AWARENESS', 'The cursor length is invalid.');
  return { id: client, clock };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
/** One pinned authenticated socket; retry policy belongs to ProjectReplica. */
export class TeamConnection extends EventEmitter {
  private readonly invite: TeamInvite;
  private socket?: WebSocket;
  private agent?: Agent;
  private attempt = 0;
  private ready = false;
  private closed = false;
  private connecting?: Promise<{ role: Role; status: TeamStatus }>;
  private connectResolve?: (result: { role: Role; status: TeamStatus }) => void;
  private connectReject?: (error: Error) => void;
  private handshake?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private nonces = new Set<string>();
  private pending = new Map<string, Pending>();
  private welcome?: { role: Role; status: TeamStatus };
  constructor(private readonly options: { invite: TeamInvite; clientId: string; name: string }) {
    super();
    this.invite = parseTeamInvite(JSON.stringify(options.invite));
    id.parse(options.clientId);
    if (!options.name.trim() || options.name.length > 60 || /[\x00-\x1f\x7f]/.test(options.name))
      throw new CairnError('INVALID_NAME', 'Choose a display name of 1–60 characters.');
    this.on('error', () => {});
  }
  connect(): Promise<{ role: Role; status: TeamStatus }> {
    if (this.closed)
      return Promise.reject(
        new CairnError('CONNECTION_CLOSED', 'This connection has been closed.'),
      );
    if (this.ready && this.welcome) return Promise.resolve(this.welcome);
    if (this.connecting) return this.connecting;
    const promise = new Promise<{ role: Role; status: TeamStatus }>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.connecting = promise;
    const epoch = ++this.attempt;
    try {
      parseTeamInvite(JSON.stringify(this.invite));
      const servername = `cairn-${this.invite.teamId}`;
      this.agent = new Agent({
        ca: this.invite.certificate,
        rejectUnauthorized: true,
        servername,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_host, cert) => {
          const identityError = checkServerIdentity(servername, cert);
          if (identityError) return identityError;
          if (hash(cert.raw) !== this.invite.fingerprint)
            return new CairnError(
              'INVALID_CERTIFICATE',
              'The server certificate differs from this invitation.',
            );
          return undefined;
        },
      });
      const transportOptions = {
        agent: this.agent,
        servername,
        handshakeTimeout: 10000,
        maxPayload: FRAME_LIMIT,
        perMessageDeflate: false,
      };
      const socket = new WebSocket(this.invite.address, transportOptions);
      this.socket = socket;
      const current = () => !this.closed && this.attempt === epoch && this.socket === socket;
      this.handshake = setTimeout(() => {
        if (current())
          this.fail(new CairnError('AUTH_TIMEOUT', 'The team did not finish authentication.'));
      }, 12000);
      this.handshake.unref();
      socket.on('error', (error) => {
        if (current()) this.fail(error);
      });
      socket.on('close', () => {
        if (current())
          this.fail(
            new CairnError(
              'CONNECTION_CLOSED',
              'The team connection ended. Local changes remain saved.',
            ),
          );
      });
      socket.on('open', () => {
        if (current())
          this.send({
            type: 'hello',
            version: TEAM_PROTOCOL,
            teamId: this.invite.teamId,
            projectId: this.invite.projectId,
            memberId: this.invite.memberId,
            token: this.invite.token,
            clientId: this.options.clientId,
            name: this.options.name.trim(),
          });
      });
      socket.on('pong', (raw) => {
        if (current() && this.nonces.delete(raw.toString())) this.resetDeadline(epoch, socket);
      });
      socket.on('message', (raw, binary) => {
        if (!current()) return;
        try {
          if (binary)
            throw new CairnError('INVALID_MESSAGE', 'The team returned an invalid message.');
          this.receive(JSON.parse(raw.toString()));
        } catch (error) {
          this.fail(error);
        }
      });
    } catch (error) {
      this.fail(error);
    }
    return promise;
  }
  request<T>(method: string, args: unknown = null): Promise<T> {
    if (!this.ready || !this.socket)
      return Promise.reject(new CairnError('OFFLINE', 'Connect to the team before continuing.'));
    if (this.pending.size >= 64)
      return Promise.reject(new CairnError('REQUEST_LIMIT', 'Too many requests are pending.'));
    const requestId = randomUUID();
    let message: string;
    try {
      message = JSON.stringify({ type: 'request', id: requestId, method, args: args ?? null });
      if (Buffer.byteLength(message) > FRAME_LIMIT)
        throw new CairnError('SIZE_LIMIT', 'The request exceeds the 24 MiB transfer limit.');
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new CairnError(
            'REQUEST_TIMEOUT',
            'The team did not answer this request. Saved changes can be retried.',
          ),
        );
      }, 30000);
      timer.unref();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket!.send(message, (error) => {
        if (error) this.fail(error);
      });
    });
  }
  sendApplied(input: {
    revision: number;
    manifestHash: string;
    projection: 'applied' | 'pending' | 'blocked';
  }): void {
    const message = appliedSchema.parse({ type: 'applied', ...input });
    if (this.ready) this.send(message);
  }
  awareness(input: { fileId: string; generation: number; update: string }): void {
    const message = awarenessSchema.parse({ type: 'awareness', ...input });
    unb64(message.update, 32 * 1024);
    if (this.ready) this.send(message);
  }
  private receive(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new CairnError('INVALID_MESSAGE', 'The team returned an invalid message.');
    const m = input as Record<string, unknown>;
    if (m.type === 'error') {
      const error = remoteError(m);
      if (
        !this.ready ||
        [
          'ACCESS_REVOKED',
          'INVITE_EXPIRED',
          'AUTH_REQUIRED',
          'AUTH_FAILED',
          'RATE_LIMIT',
          'HEARTBEAT_TIMEOUT',
        ].includes(error.code)
      )
        this.fail(error);
      else this.emit('error', publicError(error));
      return;
    }
    if (m.type === 'welcome') {
      if (this.ready) throw new CairnError('INVALID_MESSAGE', 'The team repeated its welcome.');
      const role = roleSchema.parse(m.role),
        status = this.validateStatus(m.status);
      if (role !== this.invite.role)
        throw new CairnError('ROLE_MISMATCH', 'The invitation role no longer matches this team.');
      this.ready = true;
      this.welcome = { role, status };
      if (this.handshake) clearTimeout(this.handshake);
      this.handshake = undefined;
      const resolve = this.connectResolve;
      this.connectResolve = undefined;
      this.connectReject = undefined;
      this.connecting = undefined;
      this.startHeartbeat();
      resolve?.(this.welcome);
      this.emit('status', status);
      return;
    }
    if (!this.ready)
      throw new CairnError('AUTH_REQUIRED', 'The team sent project data before authentication.');
    if (m.type === 'status') {
      const status = this.validateStatus(m.status);
      if (this.welcome) this.welcome.status = status;
      this.emit('status', status);
      return;
    }
    if (m.type === 'response') {
      const requestId = id.parse(m.id),
        pending = this.pending.get(requestId);
      if (!pending) return;
      if (typeof m.ok !== 'boolean')
        throw new CairnError('INVALID_MESSAGE', 'The team response is invalid.');
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (m.ok) pending.resolve(m.result);
      else pending.reject(remoteError(m.error));
      return;
    }
    if (m.type === 'event') {
      const event = m.event as ProjectEvent;
      if (
        !event ||
        !id.safeParse(event.opId).success ||
        !revision.safeParse(event.revision).success ||
        !digest.safeParse(event.manifestHash).success ||
        !Array.isArray(event.changes) ||
        event.changes.length > 5000
      )
        throw new CairnError('INVALID_MESSAGE', 'The project event is invalid.');
      this.emit('event', event);
      return;
    }
    if (m.type === 'awareness') {
      const envelope = awarenessSchema.parse(m);
      unb64(envelope.update, 32 * 1024);
      this.emit('awareness', {
        fileId: envelope.fileId,
        generation: envelope.generation,
        update: envelope.update,
      });
      return;
    }
    throw new CairnError('INVALID_MESSAGE', 'The team sent an unsupported message.');
  }
  private validateStatus(input: unknown): TeamStatus {
    const status = input as TeamStatus;
    if (
      !status ||
      status.teamId !== this.invite.teamId ||
      status.projectId !== this.invite.projectId ||
      !revision.safeParse(status.revision).success ||
      !digest.safeParse(status.manifestHash).success ||
      !Array.isArray(status.peers) ||
      status.peers.length > 32
    )
      throw new CairnError('IDENTITY_MISMATCH', 'The team status does not match this invitation.');
    return status;
  }
  private send(message: unknown): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message), (error) => {
        if (error) this.fail(error);
      });
  }
  private startHeartbeat(): void {
    const socket = this.socket!,
      epoch = this.attempt;
    this.resetDeadline(epoch, socket);
    const ping = () => {
      if (this.closed || !this.ready || this.attempt !== epoch || socket !== this.socket) return;
      const nonce = randomUUID();
      this.nonces.add(nonce);
      while (this.nonces.size > 4) this.nonces.delete(this.nonces.values().next().value!);
      try {
        socket.ping(nonce, undefined, (error) => {
          if (error && this.attempt === epoch) this.fail(error);
        });
      } catch (error) {
        this.fail(error);
      }
    };
    this.heartbeat = setInterval(ping, 5000);
    this.heartbeat.unref();
    ping();
  }
  private resetDeadline(epoch: number, socket: WebSocket): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.attempt === epoch && socket === this.socket)
        this.fail(
          new CairnError(
            'HEARTBEAT_TIMEOUT',
            'No verified team response arrived for 15 seconds. Local changes remain saved.',
          ),
        );
    }, 15000);
    this.deadline.unref();
  }
  private fail(reason: unknown): void {
    const safe = publicError(reason),
      error = new CairnError(
        typeof safe.code === 'string' ? safe.code : 'CONNECTION_FAILED',
        safe.message,
      );
    const hadConnection = Boolean(this.socket || this.connecting || this.ready);
    this.drop();
    const reject = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.connecting = undefined;
    reject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (hadConnection && !this.closed) this.emit('disconnect', safe);
  }
  private drop(): void {
    ++this.attempt;
    this.ready = false;
    this.welcome = undefined;
    for (const timer of [this.handshake, this.heartbeat, this.deadline])
      if (timer) clearTimeout(timer);
    this.handshake = undefined;
    this.heartbeat = undefined;
    this.deadline = undefined;
    this.nonces.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners('message');
      socket.removeAllListeners('open');
      socket.removeAllListeners('pong');
      socket.on('error', () => {});
      socket.terminate();
    }
    this.agent?.destroy();
    this.agent = undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new CairnError('CONNECTION_CLOSED', 'This team connection has closed.'));
  }
}
function remoteError(input: unknown): CairnError {
  const value = input as { code?: unknown; message?: unknown } | null;
  return new CairnError(
    typeof value?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
      ? value.code
      : 'REMOTE_ERROR',
    typeof value?.message === 'string' && value.message.length <= 1000
      ? value.message
      : 'The team request failed. Local changes remain saved.',
  );
}
