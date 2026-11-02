import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import * as Y from 'yjs';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import { TeamConnection, TeamHost } from '../core/project/transport.js';
import { ProjectReplica } from '../core/project/replica.js';
import { unb64 } from '../core/common.js';

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Confirmation did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const REMOTE = Symbol('remote snapshot');

/** The Editor's persistent Y.Doc, own-origin undo, serialized IPC update queue,
 * and state publication, without loading Monaco in the network regression. */
function editor(replica: ProjectReplica, fileId: string) {
  const doc = new Y.Doc();
  doc.getText('content');
  Y.applyUpdate(doc, unb64(replica.editorSnapshot(fileId).state), REMOTE);
  const binding = { editor: replica.clientId };
  const undo = new Y.UndoManager(doc.getText('content'), {
    trackedOrigins: new Set([binding]),
    captureTimeout: 500,
  });
  let publishing = false;
  let publishAgain = false;
  let flushed = Promise.resolve();
  const publish = () => {
    if (publishing) {
      publishAgain = true;
      return;
    }
    publishing = true;
    do {
      publishAgain = false;
      const snapshot = replica.editorSnapshot(fileId);
      Y.applyUpdate(doc, unb64(snapshot.state), REMOTE);
    } while (publishAgain);
    publishing = false;
  };
  const update = (bytes: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    flushed = flushed.then(() => {
      const snapshot = replica.editorSnapshot(fileId);
      replica.applyLocalUpdate(fileId, snapshot.generation, bytes);
    });
  };
  doc.on('update', update);
  replica.on('state', publish);
  return {
    doc,
    undo,
    flush: () => flushed,
    append(value: string) {
      undo.stopCapturing();
      doc.transact(
        () => doc.getText('content').insert(doc.getText('content').length, value),
        binding,
      );
    },
    close() {
      replica.off('state', publish);
      doc.off('update', update);
      undo.destroy();
      doc.destroy();
    },
  };
}

test('real two-user own undo confirms after command and barrier frames arrive in one receiver turn', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-confirmation-'));
  const authorityRoot = path.join(root, 'authority');
  fs.mkdirSync(authorityRoot);
  fs.writeFileSync(path.join(authorityRoot, 'live.txt'), 'seed\n');
  const store = new ProjectStore({ root: authorityRoot, mode: 'authority', name: 'Confirmation' });
  new RecoveryService(store);
  store.startWatching();
  const host = await TeamHost.start({ store, name: 'Confirmation', port: 0, lan: false });
  const address = `wss://127.0.0.1:${host.status().port}/team`;
  const owner = new ProjectReplica({
    root: path.join(root, 'owner-cache'),
    invite: host.invite('owner', address),
    name: 'Owner 한글',
    watch: false,
  });
  const friend = new ProjectReplica({
    root: path.join(root, 'friend'),
    invite: host.invite('editor', address),
    name: 'Peer 中文',
    watch: true,
  });
  const trace: Record<string, unknown>[] = [];
  let ownerEditor: ReturnType<typeof editor> | undefined;
  let friendEditor: ReturnType<typeof editor> | undefined;
  const originalSend = TeamConnection.prototype.sendApplied;
  type Session = {
    clientId?: string;
    barrier?: { revision: number; manifestHash: string };
    appliedRevision: number;
    projection: string;
  };
  const observedHost = host as unknown as {
    handle: (session: Session, input: Record<string, unknown>) => void;
    sessions: Map<unknown, Session>;
  };
  const originalHandle = observedHost.handle;
  observedHost.handle = function (session, input) {
    originalHandle.call(host, session, input);
    if (input.type === 'applied' || input.method === 'barrier' || input.method === 'command') {
      trace.push({
        side: 'host',
        type: input.type,
        method: input.method,
        clientId: session.clientId,
        revision: store.revision(),
        barrier: session.barrier?.revision ?? null,
        appliedRevision: session.appliedRevision,
        projection: session.projection,
      });
      if (input.method === 'command')
        queueMicrotask(() =>
          trace.push({
            side: 'host-after-command-microtasks',
            clientId: session.clientId,
            revision: store.revision(),
            barrier: session.barrier?.revision ?? null,
            projection: session.projection,
          }),
        );
    }
  };
  TeamConnection.prototype.sendApplied = function (input) {
    trace.push({ side: 'client', ...input });
    return originalSend.call(this, input);
  };
  try {
    await Promise.all([owner.connect(), friend.connect()]);
    await until(() => host.status().confirmedRevision === store.revision());
    const file = store.files().find((file) => file.path === 'live.txt')!;
    ownerEditor = editor(owner, file.id);
    friendEditor = editor(friend, file.id);
    const converged = async () => {
      await until(
        () =>
          owner.status().pending === 0 &&
          friend.status().pending === 0 &&
          owner.store.manifestHash() === friend.store.manifestHash(),
      );
      await until(() => host.status().confirmedRevision === store.revision(), 2000);
    };
    ownerEditor.append('HOST 한글\n');
    await ownerEditor.flush();
    await converged();
    friendEditor.append('PEER 中文\n');
    await friendEditor.flush();
    await converged();
    assert.equal(ownerEditor.doc.getText('content').toString(), 'seed\nHOST 한글\nPEER 中文\n');
    // A real TCP connection may coalesce these small adjacent frames. Explicit
    // corking makes that ordinary network scheduling deterministic for this test.
    const tcp = (friend as unknown as { link: { socket: { _socket: Socket } } }).link.socket
      ._socket;
    trace.length = 0;
    tcp.cork();
    friendEditor.undo.undo();
    await friendEditor.flush();
    tcp.uncork();
    try {
      await converged();
    } catch (error) {
      const local = (replica: ProjectReplica) => {
        const status = replica.status();
        return {
          revision: status.revision,
          pending: status.pending,
          rejected: status.rejected,
          manifestHash: status.manifestHash,
          projection: status.projections.map((p) => p.state),
          lastConfirmedKey: (replica as unknown as { lastConfirmedKey: string }).lastConfirmedKey,
        };
      };
      assert.fail(
        JSON.stringify(
          {
            message: (error as Error).message,
            trace,
            owner: local(owner),
            friend: local(friend),
            sessions: [...observedHost.sessions.values()].map((s) => ({
              clientId: s.clientId,
              barrier: s.barrier?.revision ?? null,
              appliedRevision: s.appliedRevision,
              projection: s.projection,
            })),
          },
          null,
          2,
        ),
      );
    }
    assert.equal(ownerEditor.doc.getText('content').toString(), 'seed\nHOST 한글\n');
    assert.equal(friendEditor.doc.getText('content').toString(), 'seed\nHOST 한글\n');
    assert.ok(trace.some((item) => item.side === 'host' && item.method === 'command'));
    assert.ok(trace.some((item) => item.side === 'host' && item.method === 'barrier'));
    assert.ok(
      host
        .status()
        .peers.every(
          (peer) => peer.projection === 'applied' && peer.appliedRevision === store.revision(),
        ),
    );
    friendEditor.undo.redo();
    await friendEditor.flush();
    await converged();
    assert.equal(ownerEditor.doc.getText('content').toString(), 'seed\nHOST 한글\nPEER 中文\n');
  } finally {
    TeamConnection.prototype.sendApplied = originalSend;
    observedHost.handle = originalHandle;
    ownerEditor?.close();
    friendEditor?.close();
    owner.close();
    friend.close();
    await host.stop();
    store.close();
    assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'cairn-confirmation-')));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
