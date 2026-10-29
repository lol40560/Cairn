import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { CairnClient, parseInvite } from '../core/client.js';
import { CairnServer } from '../core/server.js';
import { hash } from '../core/common.js';
import { MAX_TEXT_BYTES, MAX_UPDATE_BYTES } from '../shared/types.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cairn-next-client-'));
  return {
    root,
    remove() {
      assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'cairn-next-client-')));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function insert(client: CairnClient, text: string, index = 0) {
  const doc = client.doc;
  try {
    let update: Uint8Array | undefined;
    doc.on('update', (value) => {
      update = value;
    });
    doc.getText('content').insert(index, text);
    assert.ok(update);
    return client.applyLocalUpdate(update);
  } finally {
    doc.destroy();
  }
}
async function until(fn: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Client state did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('offline binary state and outbox survive close/reopen and converge without duplicate text', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let alice: CairnClient | undefined;
  let bob: CairnClient | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    const address = `wss://127.0.0.1:${server.status().port}/cairn`;
    const invite = server.invite('editor', address);
    alice = new CairnClient({ directory: path.join(f.root, 'alice'), invite, name: 'Alice' });
    bob = new CairnClient({
      directory: path.join(f.root, 'bob'),
      invite: server.invite('editor', address),
      name: 'Bob',
    });
    await Promise.all([alice.connect(), bob.connect()]);
    assert.equal(alice.snapshot().initialized, true);
    alice.disconnect();
    bob.disconnect();
    insert(alice, '한글');
    insert(bob, '中文');
    assert.equal(alice.snapshot().pending, 1);
    assert.equal(alice.snapshot().localSaved, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'alice', 'collaboration.txt'), 'utf8'), '한글');
    const identity = alice.snapshot().clientId;
    alice.close();
    alice = undefined;
    const db = new DatabaseSync(path.join(f.root, 'alice', '.cairn-next-client', 'client.sqlite'), {
      readOnly: true,
    });
    const row = db.prepare('SELECT state FROM document').get()!;
    const recovered = new Y.Doc();
    recovered.getText('content');
    Y.applyUpdate(recovered, row.state as Uint8Array);
    assert.equal(recovered.getText('content').toString(), '한글');
    recovered.destroy();
    assert.equal(db.prepare('SELECT count(*) AS count FROM outbox').get()!.count, 1);
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM metadata').all()).includes(invite.token),
      false,
    );
    db.close();
    alice = new CairnClient({ directory: path.join(f.root, 'alice'), invite, name: 'Alice' });
    assert.equal(alice.snapshot().clientId, identity);
    assert.equal(alice.snapshot().pending, 1);
    assert.equal(alice.snapshot().text, '한글');
    await Promise.all([alice.connect(), bob.connect()]);
    await until(
      () =>
        alice!.snapshot().pending === 0 &&
        bob!.snapshot().pending === 0 &&
        alice!.snapshot().text === bob!.snapshot().text &&
        server!.status().confirmedRevision === 2 &&
        alice!.snapshot().confirmedRevision === 2,
    );
    const result = alice.snapshot().text;
    assert.ok(result.includes('한글'));
    assert.ok(result.includes('中文'));
    assert.equal(result.length, 4);
    assert.equal(hash(result), server.status().hash);
    assert.equal(fs.readFileSync(path.join(f.root, 'bob', 'collaboration.txt'), 'utf8'), result);
    assert.equal(alice.snapshot().confirmedRevision, 2);
  } finally {
    alice?.close();
    bob?.close();
    await server?.stop();
    f.remove();
  }
});

test('initialization, viewer rights, nonempty folders and cache identities preserve existing work', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    const invite = server.invite('viewer', `wss://127.0.0.1:${server.status().port}/cairn`);
    const occupied = path.join(f.root, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'mine.txt'), 'preserve me');
    assert.throws(() => new CairnClient({ directory: occupied, invite, name: 'Reader' }), {
      code: 'NONEMPTY_DIRECTORY',
    });
    assert.deepEqual(fs.readdirSync(occupied), ['mine.txt']);
    assert.equal(fs.readFileSync(path.join(occupied, 'mine.txt'), 'utf8'), 'preserve me');
    client = new CairnClient({ directory: path.join(f.root, 'reader'), invite, name: 'Reader' });
    assert.equal(client.snapshot().initialized, false);
    assert.equal(fs.existsSync(path.join(f.root, 'reader', 'collaboration.txt')), false);
    assert.throws(() => insert(client!, 'forbidden'), { code: 'READ_ONLY' });
    await client.connect();
    assert.equal(client.snapshot().role, 'viewer');
    assert.throws(() => insert(client!, 'forbidden'), { code: 'READ_ONLY' });
    assert.equal(client.snapshot().text, '');
    assert.throws(
      () => new CairnClient({ directory: path.join(f.root, 'reader'), invite, name: 'duplicate' }),
      { code: 'PROJECT_BUSY' },
    );
    client.close();
    client = undefined;
    assert.throws(
      () =>
        new CairnClient({
          directory: path.join(f.root, 'reader'),
          invite: { ...invite, generation: 2 },
          name: 'Reader',
        }),
      { code: 'IDENTITY_MISMATCH' },
    );
    client = new CairnClient({ directory: path.join(f.root, 'reader'), invite, name: 'Reader' });
    assert.equal(client.snapshot().initialized, true);
  } finally {
    client?.close();
    await server?.stop();
    f.remove();
  }
});

test('external client file is preserved and blocks synchronization confirmation', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    client = new CairnClient({
      directory: path.join(f.root, 'editor'),
      invite: server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`),
      name: 'Editor',
    });
    await client.connect();
    client.disconnect();
    fs.writeFileSync(path.join(f.root, 'editor', 'collaboration.txt'), 'external unsaved revision');
    insert(client, 'app work');
    assert.equal(client.snapshot().localProjection, 'blocked');
    assert.equal(client.snapshot().pending, 1);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'editor', 'collaboration.txt'), 'utf8'),
      'external unsaved revision',
    );
    const recovery = path.join(f.root, 'editor', '.cairn-next-client', 'recovery');
    assert.ok(
      fs
        .readdirSync(recovery)
        .some(
          (name) =>
            fs.readFileSync(path.join(recovery, name), 'utf8') === 'external unsaved revision',
        ),
    );
    await client.connect();
    await until(() => client!.snapshot().pending === 0 && server!.status().revision === 1);
    assert.equal(client.snapshot().text, 'app work');
    assert.equal(client.snapshot().confirmedRevision, null);
    assert.equal(server.status().confirmedRevision, null);
    fs.writeFileSync(path.join(f.root, 'editor', 'collaboration.txt'), 'app work');
    client.retryProjection();
    assert.equal(client.snapshot().localProjection, 'applied');
    assert.equal(client.snapshot().error, undefined, 'successful projection clears its old error');
  } finally {
    client?.close();
    await server?.stop();
    f.remove();
  }
});

test('invite validation rejects bad trust, insecure address and expired information', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    const invite = server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`);
    assert.equal(parseInvite(JSON.stringify(invite)).projectId, invite.projectId);
    assert.throws(() => parseInvite(JSON.stringify({ ...invite, fingerprint: '0'.repeat(64) })), {
      code: 'INVALID_CERTIFICATE',
    });
    assert.throws(
      () =>
        parseInvite(JSON.stringify({ ...invite, address: invite.address.replace('wss:', 'ws:') })),
      { code: 'INVALID_ADDRESS' },
    );
    assert.throws(() => parseInvite(JSON.stringify({ ...invite, expiresAt: 1 })), {
      code: 'INVITE_EXPIRED',
    });
    assert.throws(() => parseInvite(JSON.stringify({ ...invite, version: 999 })), {
      code: 'INVALID_INVITE',
    });
  } finally {
    await server?.stop();
    f.remove();
  }
});

test('cancelled first connection cannot initialize or overwrite a later attempt', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    client = new CairnClient({
      directory: path.join(f.root, 'editor'),
      invite: server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`),
      name: 'Editor',
    });
    const cancelled = client.connect();
    client.disconnect();
    await assert.rejects(cancelled, { code: 'CANCELLED' });
    assert.equal(client.snapshot().initialized, false);
    assert.equal(fs.existsSync(path.join(f.root, 'editor', 'collaboration.txt')), false);
    await client.connect();
    insert(client, 'new attempt');
    await until(() => client!.snapshot().pending === 0);
    assert.equal(client.snapshot().connection, 'online');
    assert.equal(client.snapshot().text, 'new attempt');
    assert.equal(client.snapshot().initialized, true);
  } finally {
    client?.close();
    await server?.stop();
    f.remove();
  }
});

test('same-generation server rollback is rejected and keeps offline work', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    const root = path.join(f.root, 'server');
    server = await CairnServer.start({ root, port: 0, host: '127.0.0.1' });
    const address = `wss://127.0.0.1:${server.status().port}/cairn`;
    const port = server.status().port;
    const invite = server.invite('editor', address);
    client = new CairnClient({ directory: path.join(f.root, 'editor'), invite, name: 'Editor' });
    await client.connect();
    insert(client, 'durable');
    await until(() => client!.snapshot().pending === 0 && server!.status().revision === 1);
    client.disconnect();
    insert(client, 'offline ');
    assert.equal(client.snapshot().pending, 1);
    await server.stop();
    server = undefined;
    const db = new DatabaseSync(path.join(root, '.cairn-next', 'server.sqlite'));
    db.prepare('UPDATE project SET revision=0').run();
    db.close();
    server = await CairnServer.start({ root, port, host: '127.0.0.1' });
    await assert.rejects(client.connect(), { code: 'SERVER_ROLLBACK' });
    assert.equal(client.snapshot().text, 'offline durable');
    assert.equal(client.snapshot().pending, 1);
    assert.equal(client.snapshot().error?.code, 'SERVER_ROLLBACK');
  } finally {
    client?.close();
    await server?.stop();
    f.remove();
  }
});

test('corrupt persisted server-state hash fails closed without discarding cache', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    const invite = server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`);
    const directory = path.join(f.root, 'editor');
    client = new CairnClient({ directory, invite, name: 'Editor' });
    await client.connect();
    client.disconnect();
    insert(client, 'preserved locally');
    client.close();
    client = undefined;
    const db = new DatabaseSync(path.join(directory, '.cairn-next-client', 'client.sqlite'));
    db.prepare('UPDATE document SET server_hash=?').run('0'.repeat(64));
    db.close();
    assert.throws(() => new CairnClient({ directory, invite, name: 'Editor' }), {
      code: 'CORRUPT_CACHE',
    });
    assert.equal(
      fs.readFileSync(path.join(directory, 'collaboration.txt'), 'utf8'),
      'preserved locally',
    );
    const read = new DatabaseSync(path.join(directory, '.cairn-next-client', 'client.sqlite'), {
      readOnly: true,
    });
    assert.equal(read.prepare('SELECT count(*) AS count FROM outbox').get()!.count, 1);
    read.close();
  } finally {
    client?.close();
    await server?.stop();
    f.remove();
  }
});

test('oversized local paste preserves text and Yjs recovery while merged undo can proceed', async () => {
  const f = fixture();
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  let renderer: Y.Doc | undefined;
  try {
    server = await CairnServer.start({
      root: path.join(f.root, 'server'),
      port: 0,
      host: '127.0.0.1',
    });
    const directory = path.join(f.root, 'editor');
    client = new CairnClient({
      directory,
      invite: server.invite('editor', `wss://127.0.0.1:${server.status().port}/cairn`),
      name: 'Editor',
    });
    await client.connect();
    const before = client.snapshot();
    renderer = client.doc;
    const queued: Uint8Array[] = [];
    renderer.on('update', (update) => queued.push(update));
    const tooLarge = 'x'.repeat(MAX_TEXT_BYTES + 1);
    renderer.getText('content').insert(0, tooLarge);
    assert.equal(queued.length, 1);
    assert.ok(queued[0]!.byteLength <= MAX_UPDATE_BYTES);
    assert.throws(() => client!.applyLocalUpdate(queued[0]!), { code: 'LOCAL_UPDATE_RECOVERED' });
    assert.equal(client.snapshot().text, before.text);
    assert.equal(client.snapshot().state, before.state);
    assert.equal(client.snapshot().pending, 0);
    assert.equal(client.snapshot().rejected, 0);
    assert.equal(server.status().revision, 0);
    const recovery = path.join(directory, '.cairn-next-client', 'recovery');
    const files = fs.readdirSync(recovery).filter((name) => name.startsWith('rejected-local-'));
    assert.equal(files.length, 2);
    const textFile = files.find((name) => name.endsWith('.txt'))!;
    const binaryFile = files.find((name) => name.endsWith('.yjs'))!;
    assert.equal(textFile.slice(0, -4), binaryFile.slice(0, -4));
    assert.equal(fs.readFileSync(path.join(recovery, textFile), 'utf8'), tooLarge);
    const recovered = new Y.Doc();
    recovered.getText('content');
    Y.applyUpdate(recovered, fs.readFileSync(path.join(recovery, binaryFile)));
    assert.equal(recovered.getText('content').toString(), tooLarge);
    recovered.destroy();
    const disk = new DatabaseSync(path.join(directory, '.cairn-next-client', 'client.sqlite'), {
      readOnly: true,
    });
    assert.equal(disk.prepare('SELECT count(*) AS count FROM outbox').get()!.count, 0);
    disk.close();
    // The renderer retained its rejected paste. Undo plus a new edit is merged with it,
    // preserving Yjs dependencies while the resulting authoritative document is valid.
    renderer.getText('content').delete(0, tooLarge.length);
    renderer.getText('content').insert(0, 'valid after undo');
    client.applyLocalUpdate(Y.mergeUpdates(queued));
    await until(() => client!.snapshot().pending === 0 && server!.status().revision === 1);
    assert.equal(client.snapshot().text, 'valid after undo');
    assert.equal(server.status().hash, hash('valid after undo'));
    assert.equal(fs.readFileSync(path.join(recovery, textFile), 'utf8'), tooLarge);
  } finally {
    renderer?.destroy();
    client?.close();
    await server?.stop();
    f.remove();
  }
});
