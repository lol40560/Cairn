/** Independent-process project test fixture. Invitations use private IPC only.
 * Never log payloads, grants, certificates, private keys, or raw error messages. */
import fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { ProjectStore } from '../../core/project/store.js';
import { RecoveryService } from '../../core/project/recovery.js';
import { ProjectReplica } from '../../core/project/replica.js';
import { TeamConnection, TeamHost } from '../../core/project/transport.js';
import { b64, hash, unb64 } from '../../core/common.js';
import type {
  Actor,
  CommandInput,
  ProjectCommand,
  ProjectFile,
  ReplicaStatus,
  TeamInvite,
} from '../../shared/project.js';
import type { Role } from '../../shared/types.js';

interface Request {
  id: number;
  command: string;
  value?: any;
}
let store: ProjectStore | undefined;
let host: TeamHost | undefined;
let replica: ProjectReplica | undefined;
let root = '';
let downloadArmed = false;
let downloadSnapshotRevision: number | undefined;
let downloadRelease: (() => void) | undefined;
let hostPidToKill: number | undefined;
let receiptBaseline = 0;
let projectionFault = false;
let projectionFaultHits = 0;

const realRequest = TeamConnection.prototype.request;
TeamConnection.prototype.request = async function <T>(method: string, args: unknown): Promise<T> {
  const result = (await realRequest.call(this, method, args)) as T;
  if (method === 'snapshot') downloadSnapshotRevision = (result as { revision: number }).revision;
  if (method === 'blob' && downloadArmed) {
    downloadArmed = false;
    await new Promise<void>((resolve) => {
      downloadRelease = resolve;
      send({ event: 'download-paused', revision: downloadSnapshotRevision });
    });
  }
  return result;
};

// Only the private projection temporary-file open fails; SQLite, canonical blobs,
// authentication, real network transfers and all remaining filesystem calls run normally.
const realOpen = fs.openSync;
fs.openSync = ((...args: Parameters<typeof fs.openSync>): ReturnType<typeof fs.openSync> => {
  const target = String(args[0]);
  if (
    projectionFault &&
    store &&
    target.startsWith(`${store.dataDir}${path.sep}`) &&
    /^write-[a-f0-9-]+\.bin$/.test(path.basename(target))
  ) {
    projectionFaultHits++;
    throw Object.assign(new Error('Injected projection access failure'), { code: 'EACCES' });
  }
  return realOpen(...args);
}) as typeof fs.openSync;
syncBuiltinESMExports();

function send(message: unknown): void {
  if (process.connected) process.send?.(message);
}
function readDatabase<T>(read: (db: DatabaseSync) => T): T {
  if (!store) throw new Error('Project not started');
  const db = new DatabaseSync(path.join(store.dataDir, 'project.sqlite'), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function decodeText(bytes: Uint8Array): string {
  const doc = new Y.Doc();
  doc.getText('content');
  try {
    Y.applyUpdate(doc, bytes);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}
function persisted(): unknown {
  return readDatabase((db) => {
    const catalog = (
      db.prepare('SELECT record FROM project_files ORDER BY id').all() as { record: string }[]
    ).map((row) => JSON.parse(row.record) as ProjectFile);
    const blobs = db.prepare('SELECT hash,data,size FROM project_blobs ORDER BY hash').all() as {
      hash: string;
      data: Uint8Array;
      size: number;
    }[];
    const blobMap = new Map(blobs.map((row) => [row.hash, row.data]));
    const journal = (
      db.prepare('SELECT event FROM project_journal ORDER BY revision').all() as { event: string }[]
    ).map((row) => {
      const event = JSON.parse(row.event);
      return {
        opId: event.opId,
        revision: event.revision,
        manifestHash: event.manifestHash,
        eventHash: hash(row.event),
        actor: event.actor,
        kind: event.kind,
      };
    });
    const operations = (
      db.prepare('SELECT op_id,event FROM project_operations ORDER BY op_id').all() as {
        op_id: string;
        event: string;
      }[]
    ).map((row) => ({ opId: row.op_id, revision: JSON.parse(row.event).revision }));
    const base = {
      catalog,
      revision: store!.revision(),
      manifestHash: store!.manifestHash(),
      journal,
      operations,
      blobs: blobs.map((row) => ({
        hash: row.hash,
        size: row.size,
        actualHash: hash(row.data),
        actualSize: row.data.byteLength,
      })),
      documents: catalog
        .filter((file) => file.kind === 'text' && file.stateHash)
        .map((file) => ({
          fileId: file.id,
          generation: file.generation,
          text: decodeText(blobMap.get(file.stateHash!)!),
          hash: file.hash,
        })),
      quickCheck: db.prepare('PRAGMA quick_check').get(),
      synchronous: db.prepare('PRAGMA synchronous').get(),
      journalMode: db.prepare('PRAGMA journal_mode').get(),
    };
    if (!replica)
      return {
        ...base,
        projections: db
          .prepare('SELECT file_id,state,error FROM project_projections ORDER BY file_id')
          .all(),
      };
    const localRows = db.prepare('SELECT * FROM local_docs ORDER BY file_id').all() as any[];
    return {
      ...base,
      outbox: (db.prepare('SELECT * FROM outbox ORDER BY seq').all() as any[]).map((row) => ({
        opId: row.op_id,
        command: JSON.parse(row.command),
        state: row.state,
        reason: row.reason,
      })),
      receipts: db
        .prepare(
          'SELECT op_id AS opId,revision,manifest_hash AS manifestHash,event_hash AS eventHash FROM receipts ORDER BY revision',
        )
        .all(),
      localConflicts: (
        db.prepare('SELECT body FROM local_conflicts ORDER BY id').all() as { body: string }[]
      ).map((row) => JSON.parse(row.body)),
      localDocs: localRows.map((row) => ({
        fileId: row.file_id,
        generation: row.generation,
        contentHash: row.content_hash,
        actualHash: row.content_hash ? hash(blobMap.get(row.content_hash)!) : '',
        stateHash: row.state ? hash(row.state) : null,
        text: row.state ? decodeText(row.state) : null,
        diskHash: row.disk_hash,
        diskPath: row.disk_path,
        projection: row.projection,
      })),
    };
  });
}
function state(): unknown {
  return replica ? replica.status() : { ...store!.status(), team: host!.status() };
}
function actor(): Actor {
  return { id: store!.ownerId, name: 'Fixture owner', role: 'owner', source: { kind: 'app' } };
}
function receiptCrash(current: ReplicaStatus): void {
  if (!hostPidToKill || current.pending !== 0) return;
  readDatabase((db) => {
    const count = Number(db.prepare('SELECT count(*) n FROM receipts').get()!.n);
    if (count <= receiptBaseline) return;
    const receipt = db
      .prepare('SELECT op_id,revision FROM receipts ORDER BY revision DESC LIMIT 1')
      .get() as { op_id: string; revision: number };
    const pending = Number(db.prepare('SELECT count(*) n FROM outbox').get()!.n);
    const pid = hostPidToKill!;
    hostPidToKill = undefined;
    // Synchronous state callback after the replica's durable receipt transaction.
    // No timer, parent round trip, graceful close or post-ACK checkpoint precedes SIGKILL.
    process.kill(pid, 'SIGKILL');
    send({
      event: 'host-killed-after-ack',
      revision: receipt.revision,
      opId: receipt.op_id,
      receiptCount: count,
      pending,
    });
  });
}
async function dispatch({ command, value }: Request): Promise<unknown> {
  switch (command) {
    case 'start-host': {
      root = value.root;
      store = new ProjectStore({ root, mode: 'authority', name: 'Process project' });
      new RecoveryService(store);
      host = await TeamHost.start({
        store,
        name: 'Process team',
        port: value.port ?? 0,
        lan: false,
      });
      return { pid: process.pid, ownerId: store.ownerId, state: state() };
    }
    case 'start-replica': {
      root = value.root;
      replica = new ProjectReplica({
        root,
        invite: value.invite as TeamInvite,
        name: value.name,
        watch: false,
      });
      store = replica.store;
      replica.on('state', receiptCrash);
      return { pid: process.pid, state: replica.status() };
    }
    case 'invite':
      return host!.invite(value.role as Role, `wss://127.0.0.1:${host!.status().port}/team`);
    case 'connect':
      await replica!.connect();
      return replica!.status();
    case 'disconnect':
      replica!.disconnect();
      return replica!.status();
    case 'cancel':
      replica!.cancel();
      downloadRelease?.();
      downloadRelease = undefined;
      return replica!.status();
    case 'state':
      return state();
    case 'persisted':
      return persisted();
    case 'select':
      replica!.select(value.fileId);
      return { selected: true };
    case 'editor':
      return replica!.editorSnapshot(value.fileId);
    case 'command':
      return replica
        ? replica.command(value as CommandInput)
        : store!.apply({ ...value, opId: value.opId ?? randomUUID() } as ProjectCommand, actor());
    case 'insert': {
      const snapshot = replica!.editorSnapshot(value.fileId);
      const doc = new Y.Doc();
      doc.getText('content');
      Y.applyUpdate(doc, unb64(snapshot.state));
      try {
        const text = doc.getText('content');
        const index = value.index === 'end' ? text.length : value.index;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index > text.length ||
          typeof value.text !== 'string'
        )
          throw new Error('Invalid fixture edit');
        let update: Uint8Array | undefined;
        doc.on('update', (bytes) => {
          update = bytes;
        });
        text.insert(index, value.text);
        return update
          ? replica!.applyLocalUpdate(value.fileId, snapshot.generation, update)
          : snapshot;
      } finally {
        doc.destroy();
      }
    }
    case 'blob':
      return {
        hash: value.hash,
        data: b64(replica ? await replica.blob(value.hash) : store!.getBlob(value.hash)),
      };
    case 'arm-download':
      downloadArmed = true;
      return { armed: true };
    case 'release-download':
      downloadRelease?.();
      downloadRelease = undefined;
      return { released: true };
    case 'arm-host-crash': {
      if (!Number.isInteger(value.pid) || value.pid <= 0 || value.pid === process.pid)
        throw new Error('Invalid host PID');
      receiptBaseline = readDatabase((db) =>
        Number(db.prepare('SELECT count(*) n FROM receipts').get()!.n),
      );
      hostPidToKill = value.pid;
      return { armed: true };
    }
    case 'projection-fault':
      projectionFault = value.enabled === true;
      return { enabled: projectionFault, hits: projectionFaultHits };
    case 'retry-projection':
      if (replica) replica.retryProjection();
      else store!.retryProjection();
      return state();
    case 'set-viewer': {
      if (!host || typeof value.memberId !== 'string') throw new Error('Invalid role test');
      const db = new DatabaseSync(path.join(store!.dataDir, 'team.sqlite'));
      try {
        const result = db
          .prepare("UPDATE team_grants SET role='viewer' WHERE member_id=? AND role='editor'")
          .run(value.memberId);
        if (Number(result.changes) !== 1) throw new Error('Expected one editor');
      } finally {
        db.close();
      }
      return { changed: true };
    }
    case 'revoke':
      host!.revoke(value.memberId);
      return { revoked: true };
    case 'close':
      downloadRelease?.();
      downloadRelease = undefined;
      projectionFault = false;
      replica?.close();
      await host?.stop();
      if (!replica) store?.close();
      return { closed: true };
    default:
      throw new Error('Unknown fixture command');
  }
}

// Network initialization can be deliberately paused. Control/status requests must
// remain serviceable; product APIs serialize their own incoming events and commands.
process.on('message', (input: unknown) => {
  const request = input as Request;
  void dispatch(request)
    .then(
      (result) => send({ id: request.id, result }),
      (error) =>
        send({
          id: request.id,
          error: { code: typeof error?.code === 'string' ? error.code : 'FIXTURE_FAILURE' },
        }),
    )
    .finally(() => {
      if (request.command === 'close') process.disconnect?.();
    });
});
process.on('disconnect', () => {
  projectionFault = false;
  downloadRelease?.();
  replica?.close();
  void host?.stop().finally(() => {
    if (!replica) store?.close();
    process.exitCode = 0;
  });
});
