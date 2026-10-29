import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ClientSnapshot, Invite, ServerStatus } from '../shared/types.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = fileURLToPath(new URL('./helpers/process-client.js', import.meta.url));
class Worker extends EventEmitter {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private sequence = 0;
  private requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor() {
    super();
    this.child = fork(fixture, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    // Drain pipes; never print IPC payloads or invitations in test diagnostics.
    this.child.stdout!.resume();
    this.child.stderr!.resume();
    this.child.on('message', (message: any) => {
      if (message.event) {
        this.emit(message.event, message);
        return;
      }
      const pending = this.requests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(message.id);
      if (message.error)
        pending.reject(
          Object.assign(new Error(`Child command failed (${message.error.code})`), {
            code: message.error.code,
          }),
        );
      else pending.resolve(message.result);
    });
    this.exited = new Promise((resolve) =>
      this.child.once('exit', () => {
        for (const pending of this.requests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Fixture exited before response'));
        }
        this.requests.clear();
        resolve();
      }),
    );
  }
  call<T = any>(command: string, value?: unknown): Promise<T> {
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.reject(new Error('Fixture is stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Timed out: ${command}`));
      }, 15000);
      this.requests.set(id, { resolve, reject, timer });
      this.child.send({ id, command, value }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.requests.delete(id);
          reject(new Error('Fixture IPC failed'));
        }
      });
    });
  }
  next(event: string, timeout = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeout);
      const handler = (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.once(event, handler);
    });
  }
  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await Promise.race([
      this.exited,
      delay(5000).then(() => {
        throw new Error('Child did not terminate');
      }),
    ]);
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      await this.call('close');
      await Promise.race([this.exited, delay(1500)]);
    } finally {
      if (this.child.exitCode === null && this.child.signalCode === null) await this.kill();
    }
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function converged(
  server: Worker,
  a: Worker,
  b: Worker,
): Promise<{ host: ServerStatus; a: ClientSnapshot; b: ClientSnapshot }> {
  return eventually(
    async () => {
      const [host, left, right] = await Promise.all([
        server.call<ServerStatus>('state'),
        a.call<ClientSnapshot>('state'),
        b.call<ClientSnapshot>('state'),
      ]);
      return { host, a: left, b: right };
    },
    (s) =>
      s.a.connection === 'online' &&
      s.b.connection === 'online' &&
      s.a.text === s.b.text &&
      digest(s.a.text) === s.host.hash &&
      s.a.pending === 0 &&
      s.b.pending === 0 &&
      s.a.rejected === 0 &&
      s.b.rejected === 0 &&
      s.a.serverRevision === s.host.revision &&
      s.b.serverRevision === s.host.revision &&
      s.host.projection === 'applied' &&
      s.a.localProjection === 'applied' &&
      s.b.localProjection === 'applied' &&
      s.host.confirmedRevision === s.host.revision,
    'both real client processes and host converge',
  );
}
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test(
  'separate WSS processes preserve concurrent/offline edits, client crash, ACK-immediate host crashes, and external bytes',
  { timeout: 120000 },
  async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-process-'));
    const hostRoot = path.join(temporary, 'host');
    const aRoot = path.join(temporary, 'alice');
    const bRoot = path.join(temporary, 'bob');
    const workers: Worker[] = [];
    t.after(async () => {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      // Only this test's mkdtemp directory is removed, after every child was stopped.
      assert.equal(path.dirname(temporary), fs.realpathSync.native(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('cairn-next-process-'));
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    fs.mkdirSync(hostRoot);
    fs.writeFileSync(path.join(hostRoot, 'collaboration.txt'), 'seed\n', 'utf8');
    const makeWorker = () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    };
    let host = makeWorker();
    const started = await host.call('start-server', {
      root: hostRoot,
      host: '127.0.0.1',
      port: 0,
      fileName: 'collaboration.txt',
      name: 'Process verification',
    });
    const port = started.status.port as number;
    const identity = {
      serverId: started.status.serverId,
      projectId: started.status.projectId,
      fileId: started.status.fileId,
      generation: started.status.generation,
    };
    const inviteA = await host.call<Invite>('invite', { role: 'owner' });
    const inviteB = await host.call<Invite>('invite', { role: 'editor' });
    const alice = makeWorker();
    let bob = makeWorker();
    const [aStart, bStart] = await Promise.all([
      alice.call('start-client', { directory: aRoot, invite: inviteA, name: 'Alice' }),
      bob.call('start-client', { directory: bRoot, invite: inviteB, name: 'Bob' }),
    ]);
    assert.equal(
      new Set([process.pid, started.pid, aStart.pid, bStart.pid]).size,
      4,
      'host and both clients run in distinct OS processes',
    );
    await Promise.all([alice.call('connect'), bob.call('connect')]);
    let shared = await converged(host, alice, bob);
    assert.equal(shared.a.text, 'seed\n');

    // Both documents start from the same state and edit the exact same insertion point.
    await Promise.all([alice.call('disconnect'), bob.call('disconnect')]);
    await Promise.all([
      alice.call('insert', { index: 0, text: '한글' }),
      bob.call('insert', { index: 0, text: '中文' }),
    ]);
    const pendingBefore = await Promise.all([alice.call('persisted'), bob.call('persisted')]);
    assert.equal(pendingBefore[0].outbox.length, 1);
    assert.equal(pendingBefore[1].outbox.length, 1);
    const bobOriginalOp = pendingBefore[1].outbox[0];
    await Promise.all([alice.call('connect'), bob.call('connect')]);
    shared = await converged(host, alice, bob);
    assert.ok(
      ['한글中文seed\n', '中文한글seed\n'].includes(shared.a.text),
      'both concurrent same-position strings occur exactly once',
    );
    assert.equal(shared.host.revision, 2);

    // Offline local state and outbox survive loss of the entire client process.
    await Promise.all([alice.call('disconnect'), bob.call('disconnect')]);
    await Promise.all([
      alice.call('insert', { index: 'end', text: '\nALICE-OFFLINE' }),
      bob.call('insert', { index: 'end', text: '\nBOB-OFFLINE' }),
    ]);
    const beforeBobCrash = await bob.call<ClientSnapshot>('state');
    const beforeBobDb = await bob.call('persisted');
    assert.equal(beforeBobCrash.pending, 1);
    assert.equal(beforeBobDb.text, beforeBobCrash.text);
    await bob.kill();
    bob = makeWorker();
    const reopened = await bob.call('start-client', {
      directory: bRoot,
      invite: inviteB,
      name: 'Bob',
    });
    assert.equal(reopened.state.clientId, beforeBobCrash.clientId);
    assert.equal(reopened.state.text, beforeBobCrash.text);
    assert.equal(reopened.state.pending, 1);
    const reopenedDb = await bob.call('persisted');
    assert.deepEqual(reopenedDb.outbox, beforeBobDb.outbox);
    assert.equal(reopenedDb.hash, digest(beforeBobCrash.text));
    await Promise.all([alice.call('connect'), bob.call('connect')]);
    shared = await converged(host, alice, bob);
    assert.equal(count(shared.a.text, 'ALICE-OFFLINE'), 1);
    assert.equal(count(shared.a.text, 'BOB-OFFLINE'), 1);
    assert.equal(shared.host.revision, 4);

    // A repeated operation arrives before a genuine barrier update on the same socket.
    const beforeDuplicate = shared.host.revision;
    const duplicate = {
      type: 'update',
      opId: bobOriginalOp.opId,
      fileId: inviteB.fileId,
      generation: inviteB.generation,
      update: bobOriginalOp.update,
    };
    await bob.call('raw', duplicate);
    await bob.call('raw', duplicate);
    await bob.call('insert', { index: 'end', text: '\nDEDUP-BARRIER' });
    shared = await converged(host, alice, bob);
    assert.equal(shared.host.revision, beforeDuplicate + 1);
    assert.equal(count(shared.a.text, '中文'), 1);
    let expected = shared.a.text;

    // Repeat the strongest crash boundary three times: client persisted ACK receipt ->
    // direct SIGKILL of host, without graceful server shutdown or a fixed sleep.
    for (let round = 1; round <= 3; round++) {
      const oldRevision = shared.host.revision;
      const marker = `\nACK-CRASH-${round}`;
      expected += marker;
      const ackCrash = alice.next('host-killed-after-ack');
      await alice.call('arm-host-crash', { pid: host.child.pid });
      await alice.call('insert', { index: 'end', text: marker });
      const witnessed = await ackCrash;
      assert.equal(witnessed.revision, oldRevision + 1);
      assert.equal(witnessed.pending, 0);
      await Promise.race([
        host.exited,
        delay(5000).then(() => {
          throw new Error('ACK did not force host exit');
        }),
      ]);
      const clientAfterAck = await alice.call('persisted');
      assert.equal(clientAfterAck.outbox.length, 0);
      assert.equal(clientAfterAck.text, expected);
      assert.equal(clientAfterAck.receipts.at(-1).revision, oldRevision + 1);
      host = makeWorker();
      const restarted = await host.call('start-server', {
        root: hostRoot,
        host: '127.0.0.1',
        port,
        fileName: 'collaboration.txt',
      });
      for (const [key, value] of Object.entries(identity))
        assert.equal(restarted.status[key], value, `normal restart preserves ${key}`);
      const durable = await host.call('persisted');
      assert.equal(durable.revision, oldRevision + 1);
      assert.equal(durable.text, expected);
      assert.equal(durable.hash, digest(expected));
      assert.equal(durable.operations.length, oldRevision + 1);
      assert.deepEqual(durable.quickCheck, { quick_check: 'ok' });
      await Promise.all([alice.call('connect'), bob.call('connect')]);
      shared = await converged(host, alice, bob);
      assert.equal(shared.a.text, expected);
    }
    const persisted = await Promise.all([
      host.call('persisted'),
      alice.call('persisted'),
      bob.call('persisted'),
    ]);
    for (const state of persisted) {
      assert.equal(state.text, expected);
      assert.equal(state.hash, digest(expected));
      assert.deepEqual(state.quickCheck, { quick_check: 'ok' });
    }
    assert.equal(persisted[1].outbox.length, 0);
    assert.equal(persisted[2].outbox.length, 0);
    for (const root of [hostRoot, aRoot, bRoot])
      assert.equal(
        digest(fs.readFileSync(path.join(root, 'collaboration.txt'), 'utf8')),
        digest(expected),
      );

    // An external disk write while the client is disconnected is preserved. The
    // canonical CRDT can advance, but no false whole-project confirmation is allowed.
    await bob.call('disconnect');
    const external = 'EXTERNAL EDITOR UNSENT BYTES\n';
    fs.writeFileSync(path.join(bRoot, 'collaboration.txt'), external);
    await alice.call('insert', { index: 'end', text: '\nREMOTE-AFTER-EXTERNAL' });
    expected += '\nREMOTE-AFTER-EXTERNAL';
    await eventually(
      () => alice.call<ClientSnapshot>('state'),
      (s) => s.pending === 0 && s.text === expected,
      'remote change is durable',
    );
    await bob.call('connect');
    const blocked = await eventually(
      () => bob.call<ClientSnapshot>('state'),
      (s) => s.text === expected && s.localProjection === 'blocked',
      'external write blocks client projection',
    );
    assert.equal(blocked.pending, 0);
    assert.equal(blocked.error?.code, 'EXTERNAL_CONFLICT');
    const bobDisk = await bob.call('disk');
    assert.equal(bobDisk.content, external);
    assert.ok(bobDisk.recovery.some((r: any) => r.content === external));
    const hostAfter = await eventually(
      () => host.call<ServerStatus>('state'),
      (s) => s.confirmedRevision === null,
      'blocked connected client prevents completion',
    );
    assert.equal(hostAfter.hash, digest(expected));

    // Host materialization also refuses an external write after its last baseline.
    const hostExternal = 'HOST EXTERNAL BYTES\n';
    fs.writeFileSync(path.join(hostRoot, 'collaboration.txt'), hostExternal);
    await alice.call('insert', { index: 'end', text: '\nDURABLE-WITH-BLOCKED-HOST' });
    expected += '\nDURABLE-WITH-BLOCKED-HOST';
    await eventually(
      () => host.call<ServerStatus>('state'),
      (s) => s.projection === 'blocked' && s.hash === digest(expected),
      'host preserves external disk while durable state advances',
    );
    const hostDisk = await host.call('disk');
    assert.equal(hostDisk.content, hostExternal);
    assert.ok(hostDisk.recovery.some((r: any) => r.content === hostExternal));
    const finalHostDb = await host.call('persisted');
    assert.equal(finalHostDb.text, expected);
    assert.equal(finalHostDb.hash, digest(expected));
    assert.equal(finalHostDb.projection, 'blocked');
    const finalAlice = await eventually(
      () => alice.call<ClientSnapshot>('state'),
      (s) => s.pending === 0 && s.serverProjection === 'blocked',
      'ACK and blocked disk states remain distinct',
    );
    assert.equal(finalAlice.confirmedRevision, null);
    t.diagnostic(
      'Verified 1 host + 2 client OS processes; 3 ACK-immediate host SIGKILL/restarts; 1 offline-client SIGKILL/reopen; exact text, SHA-256, SQLite, receipts, empty outbox, identity, and retained external bytes. This is one machine, not two physical devices.',
    );
  },
);
