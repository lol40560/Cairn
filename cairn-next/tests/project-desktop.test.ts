import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { DesktopController, type DesktopServices } from '../electron/controller.js';
import { ProfileStore, type SecretCodec } from '../electron/preferences.js';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import { TeamHost } from '../core/project/transport.js';
import { b64, hash, unb64 } from '../core/common.js';
import type { ClientSnapshot } from '../shared/types.js';
import type { ReleaseState } from '../shared/release-api.js';

/** Test-only encryption adapter; it exercises ciphertext persistence without using the OS keychain. */
function secretCodec(): SecretCodec {
  const key = randomBytes(32);
  return {
    async available() {
      return true;
    },
    async encrypt(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('TEST-GCM1'), iv, cipher.getAuthTag(), ciphertext]);
    },
    async decrypt(value) {
      const bytes = Buffer.from(value);
      assert.equal(bytes.subarray(0, 9).toString(), 'TEST-GCM1');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(9, 21));
      cipher.setAuthTag(bytes.subarray(21, 37));
      return Buffer.concat([cipher.update(bytes.subarray(37)), cipher.final()]).toString('utf8');
    },
  };
}
function sandbox() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-project-desktop-'));
  return {
    root,
    folder(name: string) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
    remove() {
      assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'cairn-project-desktop-')));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function desktopServices() {
  const copies: string[] = [],
    opened: string[] = [];
  const services: DesktopServices = {
    version: 'integration-test',
    runtime: { electron: 'injected', node: process.versions.node, platform: process.platform },
    async chooseFolder() {
      return null;
    },
    async saveArchive() {
      return null;
    },
    copy(value) {
      copies.push(value);
    },
    async openPath(value) {
      opened.push(value);
    },
    async legal() {
      return { licenses: 'test licenses', privacy: 'test privacy' };
    },
  };
  return { services, copies, opened };
}
async function eventually(check: () => boolean, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
function append(snapshot: ClientSnapshot, text: string) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, unb64(snapshot.state));
    const before = Y.encodeStateVector(doc);
    doc.getText('content').insert(doc.getText('content').length, text);
    return {
      update: b64(Y.encodeStateAsUpdate(doc, before)),
      fileId: snapshot.fileId,
      generation: snapshot.generation,
      clientId: snapshot.clientId,
    };
  } finally {
    doc.destroy();
  }
}
const errorCode = (expected: string) => (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected);
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function remoteFixture(root: string) {
  fs.writeFileSync(path.join(root, 'remote.txt'), 'remote baseline\n');
  const store = new ProjectStore({ root, mode: 'authority' });
  new RecoveryService(store);
  const host = await TeamHost.start({ store, name: 'Desktop test remote', port: 0 });
  return {
    store,
    host,
    async close() {
      await host.stop();
      store.close();
    },
  };
}

test('desktop local editing uses the real selected root and restores one stable owner cache', async () => {
  const temp = sandbox(),
    root = temp.folder('project'),
    profilePath = temp.folder('profile'),
    codec = secretCodec(),
    ui = desktopServices();
  fs.writeFileSync(path.join(root, 'note.txt'), 'original\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'second.txt'), 'second\n');
  let controller: DesktopController | undefined;
  try {
    const profile = new ProfileStore(profilePath, codec);
    controller = new DesktopController(profile, ui.services);
    const opened = await controller.openProject({ path: root });
    assert.equal(opened.current?.path, root);
    assert.equal(opened.replica?.root, root);
    assert.equal(opened.editor?.directory, root);
    assert.equal(opened.team?.enabled, false);
    assert.equal(opened.replica?.connection, 'online');
    const file = opened.current!.files.find((file) => file.path === 'docs/second.txt')!;
    const selected = await controller.selectFile(file.id);
    assert.ok(selected);
    const originalFileId = selected.fileId;
    const frame = append(selected, 'edited in app\n');
    controller.update(frame);
    await eventually(
      () =>
        fs.readFileSync(path.join(root, 'docs', 'second.txt'), 'utf8') ===
          'second\nedited in app\n' && controller!.state().replica?.pending === 0,
      'authority file and outbox commit',
    );
    const before = controller.state(),
      projectId = before.current!.projectId,
      recordId = before.current!.id,
      clientId = before.replica!.clientId,
      teamId = before.team!.teamId;
    const cache = path.join(profilePath, 'owner-workcopies', projectId);
    assert.ok(fs.existsSync(path.join(cache, '.cairn-next', 'project.sqlite')));
    assert.ok(fs.existsSync(path.join(root, '.cairn-next', 'project.sqlite')));
    assert.equal(
      fs.readFileSync(path.join(cache, 'docs', 'second.txt'), 'utf8'),
      'second\nedited in app\n',
    );
    await controller.openFolder();
    await controller.openFolder({ relativePath: 'docs/second.txt' });
    assert.deepEqual(ui.opened, [root, path.join(root, 'docs', 'second.txt')]);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'original\n');
    await controller.close();
    controller = undefined;
    const restoredProfile = new ProfileStore(profilePath, codec);
    controller = new DesktopController(restoredProfile, ui.services);
    await controller.restore();
    const after = controller.state();
    assert.equal(after.error, null);
    assert.equal(after.current?.id, recordId);
    assert.equal(after.current?.projectId, projectId);
    assert.equal(after.team?.teamId, teamId);
    assert.equal(after.replica?.clientId, clientId);
    assert.equal(after.editor?.fileId, originalFileId);
    assert.equal(after.editor?.text, before.editor?.text);
    assert.equal(after.editor?.state, before.editor?.state);
    assert.equal(after.editor?.directory, root);
    assert.equal(after.replica?.pending, 0);
    assert.equal(after.replica?.rejected, 0);
    assert.deepEqual(fs.readdirSync(path.join(profilePath, 'owner-workcopies')), [projectId]);
  } finally {
    await controller?.close();
    temp.remove();
  }
});

test('desktop create-team, leave and restart preserve the team and owner editing identity', async () => {
  const temp = sandbox(),
    root = temp.folder('team-project'),
    profilePath = temp.folder('profile'),
    codec = secretCodec(),
    ui = desktopServices();
  fs.writeFileSync(path.join(root, 'note.txt'), 'team\n');
  let controller: DesktopController | undefined;
  try {
    controller = new DesktopController(new ProfileStore(profilePath, codec), ui.services);
    const solo = await controller.openProject({ path: root });
    const projectId = solo.current!.projectId,
      teamId = solo.team!.teamId,
      clientId = solo.replica!.clientId;
    await controller.createTeam();
    await eventually(
      () =>
        controller!.state().team?.enabled === true &&
        controller!.state().replica?.connection === 'online',
      'LAN team and owner reconnect',
    );
    const port = controller.state().team!.port;
    assert.equal(controller.state().team?.teamId, teamId);
    assert.equal(controller.state().replica?.clientId, clientId);
    assert.equal(controller.profile.settings.teams[projectId]?.enabled, true);
    await controller.close();
    controller = undefined;
    controller = new DesktopController(new ProfileStore(profilePath, codec), ui.services);
    await controller.restore();
    assert.equal(controller.state().team?.enabled, true);
    assert.equal(controller.state().team?.teamId, teamId);
    assert.equal(controller.state().team?.port, port);
    assert.equal(controller.state().replica?.clientId, clientId);
    await controller.leaveTeam();
    await eventually(
      () =>
        controller!.state().team?.enabled === false &&
        controller!.state().replica?.connection === 'online',
      'private local editing after leaving team',
    );
    assert.equal(controller.state().current?.projectId, projectId);
    assert.equal(controller.profile.settings.teams[projectId]?.enabled, false);
    const snapshot = controller.state().editor!;
    controller.update(append(snapshot, 'still editable\n'));
    await eventually(
      () => fs.readFileSync(path.join(root, 'note.txt'), 'utf8') === 'team\nstill editable\n',
      'editing after leaving LAN team',
    );
    await controller.close();
    controller = undefined;
    controller = new DesktopController(new ProfileStore(profilePath, codec), ui.services);
    await controller.restore();
    assert.equal(controller.state().team?.enabled, false);
    assert.equal(controller.state().team?.teamId, teamId);
    assert.equal(controller.state().editor?.text, 'team\nstill editable\n');
  } finally {
    await controller?.close();
    temp.remove();
  }
});

test('desktop joined workcopy and GitHub settings persist credentials only through encrypted codec', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote')),
    workcopy = temp.folder('joined'),
    profilePath = temp.folder('profile'),
    codec = secretCodec(),
    ui = desktopServices();
  let controller: DesktopController | undefined;
  try {
    controller = new DesktopController(new ProfileStore(profilePath, codec), ui.services);
    const invite = remote.host.invite('editor'),
      token = `test-only-${randomUUID()}`;
    const joined = await controller.joinTeam({
      invite: JSON.stringify(invite),
      directory: workcopy,
      name: 'Desktop member',
    });
    assert.equal(joined.current?.kind, 'joined');
    assert.equal(joined.current?.path, workcopy);
    assert.equal(joined.editor?.directory, workcopy);
    assert.equal(fs.readFileSync(path.join(workcopy, 'remote.txt'), 'utf8'), 'remote baseline\n');
    const recordId = joined.current!.id,
      projectId = joined.current!.projectId,
      clientId = joined.replica!.clientId;
    const settings = await controller.saveGitHub({
      owner: 'test-owner',
      repo: 'test-repo',
      baseBranch: 'main',
      token,
    });
    assert.equal(settings.hasToken, true);
    const publicProfile = fs.readFileSync(path.join(profilePath, 'profile.json'), 'utf8'),
      encrypted = fs.readFileSync(path.join(profilePath, 'secrets.encrypted'));
    assert.ok(!publicProfile.includes(invite.token));
    assert.ok(!publicProfile.includes(token));
    assert.ok(!publicProfile.includes(invite.certificate));
    assert.ok(!encrypted.includes(Buffer.from(invite.token)));
    assert.ok(!encrypted.includes(Buffer.from(token)));
    assert.ok(!JSON.stringify(controller.state()).includes(token));
    assert.ok(!JSON.stringify(controller.state()).includes(invite.token));
    controller.copyDiagnostics();
    assert.ok(!ui.copies.at(-1)!.includes(token));
    assert.ok(!ui.copies.at(-1)!.includes(invite.token));
    await controller.leaveTeam();
    assert.equal(controller.state().replica?.connection, 'offline');
    await controller.reconnect();
    assert.equal(controller.state().replica?.connection, 'online');
    await controller.command({
      kind: 'create',
      path: 'joined-created.txt',
      nodeKind: 'text',
      data: b64(Buffer.from('from joined controller\n')),
    });
    await eventually(
      () => fs.existsSync(path.join(remote.store.root, 'joined-created.txt')),
      'joined command projected by authority',
    );
    await controller.close();
    controller = undefined;
    const restoredProfile = new ProfileStore(profilePath, codec);
    controller = new DesktopController(restoredProfile, ui.services);
    await controller.restore();
    const restored = controller.state();
    assert.equal(restored.error, null);
    assert.equal(restored.current?.id, recordId);
    assert.equal(restored.current?.projectId, projectId);
    assert.equal(restored.replica?.clientId, clientId);
    assert.equal(restored.replica?.connection, 'online');
    assert.equal(restored.gitHub.hasToken, true);
    assert.ok(restoredProfile.invitation(recordId)?.token === invite.token);
    assert.ok(restoredProfile.token(projectId) === token);
    await controller.saveGitHub({
      owner: 'test-owner',
      repo: 'test-repo',
      baseBranch: 'main',
      clearToken: true,
    });
    assert.equal(controller.state().gitHub.hasToken, false);
    const loaded = new ProfileStore(profilePath, codec);
    await loaded.loadSecrets();
    assert.equal(loaded.token(projectId), undefined);
    assert.ok(loaded.invitation(recordId)?.token === invite.token);
    // No preview/publish action is invoked: this test never contacts GitHub.
  } finally {
    await controller?.close();
    await remote.close();
    temp.remove();
  }
});

test('unavailable credential encryption preserves prior encrypted bytes and never writes plaintext fallback', async () => {
  const temp = sandbox(),
    profilePath = temp.folder('profile'),
    codec = secretCodec();
  try {
    const original = new ProfileStore(profilePath, codec);
    original.save();
    const token = `original-test-${randomUUID()}`;
    await original.setToken('project-test', token);
    const destination = path.join(profilePath, 'secrets.encrypted'),
      before = hash(fs.readFileSync(destination));
    const unavailable: SecretCodec = {
      async available() {
        return false;
      },
      async encrypt() {
        throw new Error('Encryption must not run');
      },
      async decrypt() {
        throw new Error('Decryption must not run');
      },
    };
    const locked = new ProfileStore(profilePath, unavailable);
    await assert.rejects(locked.loadSecrets(), errorCode('SECURE_STORAGE_UNAVAILABLE'));
    const replacement = `replacement-test-${randomUUID()}`;
    await assert.rejects(
      locked.setToken('project-test', replacement),
      errorCode('SECURE_STORAGE_UNAVAILABLE'),
    );
    await locked.finish();
    assert.equal(hash(fs.readFileSync(destination)), before);
    for (const filename of fs.readdirSync(profilePath)) {
      const bytes = fs.readFileSync(path.join(profilePath, filename));
      assert.ok(!bytes.includes(Buffer.from(token)));
      assert.ok(!bytes.includes(Buffer.from(replacement)));
    }
    const recovered = new ProfileStore(profilePath, codec);
    await recovered.loadSecrets();
    assert.ok(recovered.token('project-test') === token);
  } finally {
    temp.remove();
  }
});

test('cancelled authentication cannot install late data or replace the next selected project', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote')),
    workcopy = temp.folder('cancelled'),
    nextRoot = temp.folder('next'),
    profilePath = temp.folder('profile'),
    ui = desktopServices();
  fs.writeFileSync(path.join(nextRoot, 'next.txt'), 'next project\n');
  const controller = new DesktopController(
      new ProfileStore(profilePath, secretCodec()),
      ui.services,
    ),
    invite = remote.host.invite('editor');
  const db = new DatabaseSync(path.join(remote.store.dataDir, 'team.sqlite'), { readOnly: true });
  const identity = db
    .prepare('SELECT private_key,certificate FROM team_identity WHERE singleton=1')
    .get() as { private_key: string; certificate: string };
  db.close();
  const server = createServer({ key: identity.private_key, cert: identity.certificate }),
    wss = new WebSocketServer({ server });
  let peer: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    assert.ok(bound && typeof bound === 'object');
    const hello = new Promise<void>((resolve) =>
      wss.once('connection', (socket) => {
        peer = socket;
        socket.on('error', () => {});
        socket.once('message', () => resolve());
      }),
    );
    const pending = controller
      .joinTeam({
        invite: JSON.stringify({ ...invite, address: `wss://127.0.0.1:${bound.port}/team` }),
        directory: workcopy,
      })
      .then(
        () => ({ succeeded: true, error: undefined as unknown }),
        (error) => ({ succeeded: false, error }),
      );
    await hello;
    assert.equal(controller.state().replica?.transfer.stage, 'authenticating');
    controller.cancelJoin();
    const outcome = await pending;
    assert.equal(outcome.succeeded, false);
    assert.equal(controller.state().replica?.transfer.stage, 'cancelled');
    assert.equal(controller.state().replica?.initialized, false);
    assert.equal(controller.state().busy, null);
    assert.equal(fs.existsSync(path.join(workcopy, 'remote.txt')), false);
    const next = await controller.openProject({ path: nextRoot });
    assert.equal(next.current?.path, nextRoot);
    assert.equal(next.editor?.text, 'next project\n');
    assert.equal(next.error, null);
    await delay(80);
    assert.equal(controller.state().current?.projectId, next.current?.projectId);
    assert.equal(controller.state().replica?.connection, 'online');
    assert.equal(fs.existsSync(path.join(nextRoot, 'remote.txt')), false);
  } finally {
    peer?.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await controller.close();
    await remote.close();
    temp.remove();
  }
});

test('project switching rejects stale editor frames and ignores changes from a closed joined session', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote')),
    workcopy = temp.folder('joined'),
    nextRoot = temp.folder('next'),
    profilePath = temp.folder('profile'),
    ui = desktopServices();
  fs.writeFileSync(path.join(nextRoot, 'next.txt'), 'next project\n');
  const controller = new DesktopController(
    new ProfileStore(profilePath, secretCodec()),
    ui.services,
  );
  try {
    const joined = await controller.joinTeam({
        invite: JSON.stringify(remote.host.invite('editor')),
        directory: workcopy,
      }),
      oldFrame = append(joined.editor!, 'stale write\n');
    const next = await controller.openProject({ path: nextRoot });
    assert.notEqual(next.replica?.clientId, oldFrame.clientId);
    assert.throws(() => controller.update(oldFrame), errorCode('STALE_SESSION'));
    const staleScope = { projectId: joined.current!.projectId, clientId: joined.replica!.clientId };
    await assert.rejects(
      controller.command(
        { kind: 'create', path: 'stale-command.txt', nodeKind: 'text', data: '' },
        staleScope,
      ),
      errorCode('STALE_SESSION'),
    );
    await assert.rejects(
      controller.command({ kind: 'settings', strictClaims: true }, staleScope),
      errorCode('STALE_SESSION'),
    );
    assert.equal(controller.state().replica?.metadata.strictClaims, false);
    assert.equal(fs.existsSync(path.join(nextRoot, 'stale-command.txt')), false);
    const observations: ReleaseState[] = [];
    controller.on('state', (state) => observations.push(state));
    remote.store.apply(
      {
        opId: randomUUID(),
        kind: 'create',
        path: 'late-remote.txt',
        nodeKind: 'text',
        data: b64(Buffer.from('old session event')),
      },
      { id: remote.store.ownerId, name: 'Remote owner', role: 'owner', source: { kind: 'app' } },
    );
    await delay(150);
    assert.ok(observations.every((state) => state.current?.projectId === next.current!.projectId));
    assert.equal(controller.state().current?.projectId, next.current?.projectId);
    assert.equal(controller.state().editor?.text, 'next project\n');
    assert.equal(fs.existsSync(path.join(nextRoot, 'late-remote.txt')), false);
    assert.equal(fs.existsSync(path.join(workcopy, 'late-remote.txt')), false);
    const joinedRecord = controller.state().projects.find((project) => project.kind === 'joined')!;
    await controller.switchProject(joinedRecord.id);
    assert.equal(controller.state().current?.projectId, joined.current?.projectId);
    assert.ok(controller.state().current?.files.some((file) => file.path === 'late-remote.txt'));
    await eventually(
      () => fs.existsSync(path.join(workcopy, 'late-remote.txt')),
      'reopened joined workcopy catches up',
    );
    await controller.removeProject(joinedRecord.id);
    assert.equal(controller.state().current, null);
    assert.equal(
      controller.state().projects.some((project) => project.id === joinedRecord.id),
      false,
    );
    assert.equal(fs.readFileSync(path.join(workcopy, 'remote.txt'), 'utf8'), 'remote baseline\n');
  } finally {
    await controller.close();
    await remote.close();
    temp.remove();
  }
});

test('encrypted originals survive failed unlock setters, retries and concurrent first-load writes', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote')),
    profilePath = temp.folder('profile'),
    codec = secretCodec();
  try {
    const savedInvite = remote.host.invite('viewer'),
      newInvite = remote.host.invite('editor'),
      original = new ProfileStore(profilePath, codec);
    original.save();
    await original.setInvitation('saved-grant', savedInvite);
    await original.setToken('saved-token', 'saved-test-credential');
    const file = path.join(profilePath, 'secrets.encrypted'),
      before = hash(fs.readFileSync(file));
    let failUnlock = true;
    const retryable: SecretCodec = {
      ...codec,
      async decrypt(value) {
        if (failUnlock) throw new Error('Synthetic unavailable key');
        return codec.decrypt(value);
      },
    };
    const locked = new ProfileStore(profilePath, retryable);
    await assert.rejects(locked.loadSecrets(), errorCode('SECURE_STORAGE_UNAVAILABLE'));
    await assert.rejects(
      locked.setToken('new-token', 'new-test-credential'),
      errorCode('SECURE_STORAGE_UNAVAILABLE'),
    );
    await assert.rejects(
      locked.setInvitation('new-grant', newInvite),
      errorCode('SECURE_STORAGE_UNAVAILABLE'),
    );
    await locked.finish();
    assert.equal(hash(fs.readFileSync(file)), before);
    failUnlock = false;
    await locked.loadSecrets();
    assert.ok(locked.invitation('saved-grant')?.token === savedInvite.token);
    assert.ok(locked.token('saved-token') === 'saved-test-credential');
    assert.equal(locked.token('new-token'), undefined);
    const entered = latch(),
      release = latch();
    let decryptCalls = 0;
    const delayed: SecretCodec = {
      ...codec,
      async decrypt(value) {
        decryptCalls++;
        entered.resolve();
        await release.promise;
        return codec.decrypt(value);
      },
    };
    const concurrent = new ProfileStore(profilePath, delayed);
    const writeToken = concurrent.setToken('new-token', 'new-test-credential'),
      writeInvite = concurrent.setInvitation('new-grant', newInvite);
    await entered.promise;
    await delay(0);
    release.resolve();
    await Promise.all([writeToken, writeInvite]);
    assert.equal(decryptCalls, 1);
    const restored = new ProfileStore(profilePath, codec);
    await restored.loadSecrets();
    assert.ok(restored.token('saved-token') === 'saved-test-credential');
    assert.ok(restored.token('new-token') === 'new-test-credential');
    assert.ok(restored.invitation('saved-grant')?.token === savedInvite.token);
    assert.ok(restored.invitation('new-grant')?.token === newInvite.token);
  } finally {
    await remote.close();
    temp.remove();
  }
});

test('cancellation while the previous host stops cannot construct a replacement workcopy', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote'));
  try {
    for (const mode of ['cancel', 'close-project', 'close-controller'] as const) {
      const root = temp.folder(`${mode}-local`),
        workcopy = temp.folder(`${mode}-workcopy`),
        profilePath = temp.folder(`${mode}-profile`);
      fs.writeFileSync(path.join(root, 'local.txt'), 'local baseline');
      const controller = new DesktopController(
        new ProfileStore(profilePath, secretCodec()),
        desktopServices().services,
      );
      let release: ReturnType<typeof latch> | undefined;
      let outcome: Promise<{ error?: unknown }> | undefined;
      try {
        await controller.openProject({ path: root });
        // Delays only teardown completion; both the old host and the target host remain real WSS.
        const oldHost = (controller as unknown as { session: { host: TeamHost } }).session.host,
          stop = oldHost.stop.bind(oldHost),
          entered = latch();
        release = latch();
        const gate = release;
        oldHost.stop = async () => {
          entered.resolve();
          await gate.promise;
          await stop();
        };
        outcome = controller
          .joinTeam({ invite: JSON.stringify(remote.host.invite('editor')), directory: workcopy })
          .then(
            () => ({}),
            (error) => ({ error }),
          );
        await entered.promise;
        if (mode === 'cancel') controller.cancelJoin();
        else if (mode === 'close-project') await controller.closeProject();
        else await controller.close();
        release.resolve();
        const result = await outcome;
        assert.ok(errorCode('CANCELLED')(result.error));
        assert.equal(controller.state().current, null);
        assert.equal(controller.state().replica, null);
        assert.deepEqual(fs.readdirSync(workcopy), []);
        assert.equal(
          controller.profile.settings.projects.some((project) => project.kind === 'joined'),
          false,
        );
        assert.equal(remote.host.status().peers.length, 0);
      } finally {
        release?.resolve();
        await outcome;
        await controller.close();
      }
    }
  } finally {
    await remote.close();
    temp.remove();
  }
});

test('cancellation while invitation encryption waits never resumes remote connection', async () => {
  const temp = sandbox(),
    remote = await remoteFixture(temp.folder('remote'));
  try {
    for (const mode of ['cancel', 'close-project', 'close-controller'] as const) {
      const workcopy = temp.folder(`${mode}-joined`),
        profilePath = temp.folder(`${mode}-profile`),
        codec = secretCodec(),
        entered = latch(),
        release = latch();
      const delayed: SecretCodec = {
        ...codec,
        async encrypt(value) {
          entered.resolve();
          await release.promise;
          return codec.encrypt(value);
        },
      };
      const controller = new DesktopController(
        new ProfileStore(profilePath, delayed),
        desktopServices().services,
      );
      let outcome: Promise<ReleaseState> | undefined, closing: Promise<void> | undefined;
      try {
        outcome = controller.joinTeam({
          invite: JSON.stringify(remote.host.invite('editor')),
          directory: workcopy,
        });
        await entered.promise;
        assert.equal(remote.host.status().peers.length, 0);
        if (mode === 'cancel') controller.cancelJoin();
        else if (mode === 'close-project') await controller.closeProject();
        else closing = controller.close();
        release.resolve();
        await outcome;
        await closing;
        assert.equal(remote.host.status().peers.length, 0);
        assert.equal(fs.existsSync(path.join(workcopy, 'remote.txt')), false);
        if (mode === 'cancel') {
          assert.equal(controller.state().replica?.initialized, false);
          assert.equal(controller.state().replica?.transfer.stage, 'cancelled');
        } else assert.equal(controller.state().current, null);
      } finally {
        release.resolve();
        await outcome;
        await closing;
        await controller.close();
      }
    }
  } finally {
    await remote.close();
    temp.remove();
  }
});
