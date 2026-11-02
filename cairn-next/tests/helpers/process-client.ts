/** Process fixture used only by integration tests. Credentials travel through IPC,
 * never argv, environment, stdout, snapshots, or diagnostic error messages. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { CairnClient } from '../../core/client.js';
import { CairnServer } from '../../core/server.js';
import { hash, publicError } from '../../core/common.js';
import type { ClientOptions, HostOptions, Role } from '../../shared/types.js';

interface Request {
  id: number;
  command: string;
  value?: any;
}
let server: CairnServer | undefined;
let client: CairnClient | undefined;
let root = '';
let serverToKill: number | undefined;
let receiptBaseline = 0;
let queue = Promise.resolve();

function send(message: unknown): void {
  if (process.connected) process.send?.(message);
}
function readDatabase<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function persistedClient(): any {
  return readDatabase(path.join(root, '.cairn-next-client', 'client.sqlite'), (db) => {
    const row = db
      .prepare(
        'SELECT state,server_state,server_revision,server_hash,initialized,projection FROM document WHERE id=1',
      )
      .get() as any;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.state));
    try {
      return {
        text: doc.getText('content').toString(),
        hash: hash(doc.getText('content').toString()),
        serverRevision: row.server_revision,
        serverHash: row.server_hash,
        initialized: row.initialized,
        projection: row.projection,
        outbox: (
          db.prepare('SELECT op_id,binary_update,state FROM outbox ORDER BY seq').all() as any[]
        ).map((r) => ({
          opId: r.op_id,
          update: Buffer.from(r.binary_update).toString('base64'),
          state: r.state,
        })),
        receipts: (
          db.prepare('SELECT op_id,revision,hash FROM receipts ORDER BY revision').all() as any[]
        ).map((r) => ({ opId: r.op_id, revision: r.revision, hash: r.hash })),
        quickCheck: db.prepare('PRAGMA quick_check').get(),
      };
    } finally {
      doc.destroy();
    }
  });
}
function persistedServer(): any {
  return readDatabase(path.join(root, '.cairn-next', 'server.sqlite'), (db) => {
    const row = db
      .prepare(
        'SELECT server_id,project_id,file_id,generation,state,revision,hash,projection FROM project WHERE singleton=1',
      )
      .get() as any;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.state));
    try {
      return {
        serverId: row.server_id,
        projectId: row.project_id,
        fileId: row.file_id,
        generation: row.generation,
        text: doc.getText('content').toString(),
        hash: row.hash,
        revision: row.revision,
        projection: row.projection,
        operations: (
          db.prepare('SELECT op_id,revision,hash FROM operations ORDER BY revision').all() as any[]
        ).map((r) => ({ opId: r.op_id, revision: r.revision, hash: r.hash })),
        quickCheck: db.prepare('PRAGMA quick_check').get(),
      };
    } finally {
      doc.destroy();
    }
  });
}
async function dispatch(request: Request): Promise<unknown> {
  const { command, value } = request;
  if (command === 'start-server') {
    const options = value as HostOptions;
    root = options.root;
    server = await CairnServer.start(options);
    return { pid: process.pid, status: server.status() };
  }
  if (command === 'start-client') {
    const options = value as ClientOptions;
    root = options.directory;
    client = new CairnClient(options);
    client.on('state', (state) => {
      if (serverToKill && state.pending === 0) {
        const persisted = persistedClient();
        if (persisted.receipts.length > receiptBaseline) {
          const pid = serverToKill;
          serverToKill = undefined;
          // This runs synchronously inside the client's durable-ACK state callback.
          // The host receives no graceful-stop request or checkpoint opportunity.
          process.kill(pid, 'SIGKILL');
          send({
            event: 'host-killed-after-ack',
            revision: persisted.receipts.at(-1).revision,
            receiptCount: persisted.receipts.length,
            pending: persisted.outbox.length,
          });
        }
      }
    });
    return { pid: process.pid, state: client.snapshot() };
  }
  if (command === 'invite')
    return server!.invite(
      (value?.role ?? 'editor') as Role,
      `wss://127.0.0.1:${server!.status().port}/cairn`,
    );
  if (command === 'connect') {
    await client!.connect();
    return client!.snapshot();
  }
  if (command === 'disconnect') {
    client!.disconnect();
    return client!.snapshot();
  }
  if (command === 'state') return client ? client.snapshot() : server!.status();
  if (command === 'persisted') return client ? persistedClient() : persistedServer();
  if (command === 'insert') {
    const doc = client!.doc;
    try {
      const text = doc.getText('content');
      const index = value.index === 'end' ? text.length : value.index;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index > text.length ||
        typeof value.text !== 'string'
      )
        throw new Error('Invalid test edit');
      let update: Uint8Array | undefined;
      doc.on('update', (bytes) => {
        update = bytes;
      });
      text.insert(index, value.text);
      return update ? client!.applyLocalUpdate(update) : client!.snapshot();
    } finally {
      doc.destroy();
    }
  }
  if (command === 'raw') {
    client!.sendRaw(value);
    return { sent: true };
  }
  if (command === 'arm-host-crash') {
    if (!Number.isInteger(value.pid) || value.pid <= 0 || value.pid === process.pid)
      throw new Error('Invalid host PID');
    receiptBaseline = persistedClient().receipts.length;
    serverToKill = value.pid;
    return { armed: true };
  }
  if (command === 'retry-projection') {
    if (client) client.retryProjection();
    else server!.retryProjection();
    return client ? client.snapshot() : server!.status();
  }
  if (command === 'disk') {
    const name = client ? client.snapshot().fileName : server!.status().fileName;
    const recovery = path.join(root, client ? '.cairn-next-client' : '.cairn-next', 'recovery');
    return {
      content: fs.readFileSync(path.join(root, name), 'utf8'),
      recovery: fs
        .readdirSync(recovery)
        .map((name) => ({ name, content: fs.readFileSync(path.join(recovery, name), 'utf8') })),
    };
  }
  if (command === 'close') {
    client?.close();
    await server?.stop();
    return { closed: true };
  }
  throw new Error('Unknown test command');
}

process.on('message', (input: unknown) => {
  const request = input as Request;
  queue = queue.then(async () => {
    try {
      send({ id: request.id, result: await dispatch(request) });
    } catch (error) {
      send({ id: request.id, error: publicError(error) });
    }
    if (request.command === 'close') process.disconnect?.();
  });
});
process.on('disconnect', () => {
  client?.close();
  void server?.stop().finally(() => {
    process.exitCode = 0;
  });
});
