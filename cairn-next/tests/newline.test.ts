import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { CairnServer } from '../core/server.js';
import { CairnClient } from '../core/client.js';

async function settled(client: CairnClient, server: CairnServer) {
  const deadline = Date.now() + 5000;
  while (client.snapshot().pending || server.status().projection !== 'applied') {
    if (Date.now() > deadline) throw new Error('newline state did not become durable');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function change(client: CairnClient, fn: (text: Y.Text) => void) {
  const doc = client.doc;
  let update: Uint8Array | undefined;
  doc.on('update', (bytes) => {
    update = bytes;
  });
  try {
    doc.transact(() => fn(doc.getText('content')));
    if (update) client.applyLocalUpdate(update);
  } finally {
    doc.destroy();
  }
}

test('CRLF policy survives empty documents, client/server restart and rejects a silent format change', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-eol-'));
  const root = path.join(temp, 'host'),
    directory = path.join(temp, 'client');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'collaboration.txt'), 'alpha\r\nbeta\r\n');
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({ root, host: '127.0.0.1', port: 0 });
    const port = server.status().port,
      id = server.status().fileId;
    const invite = server.invite('editor', `wss://127.0.0.1:${port}/cairn`);
    client = new CairnClient({ directory, invite, name: 'CRLF' });
    await client.connect();
    assert.equal(client.snapshot().lineEnding, 'crlf');
    assert.equal(server.status().lineEnding, 'crlf');
    change(client, (text) => text.delete(0, text.length));
    await settled(client, server);
    assert.equal(client.snapshot().text, '');
    client.close();
    await server.stop();
    server = await CairnServer.start({ root, host: '127.0.0.1', port });
    client = new CairnClient({ directory, invite, name: 'CRLF' });
    assert.equal(client.snapshot().lineEnding, 'crlf');
    await client.connect();
    assert.equal(server.status().fileId, id);
    change(client, (text) => text.insert(0, 'next\r\n'));
    await settled(client, server);
    assert.equal(fs.readFileSync(path.join(root, 'collaboration.txt'), 'utf8'), 'next\r\n');
    assert.throws(
      () =>
        change(client!, (text) => {
          text.delete(0, text.length);
          text.insert(0, 'wrong\n');
        }),
      { code: 'LOCAL_UPDATE_RECOVERED' },
    );
    assert.equal(client.snapshot().text, 'next\r\n');
    assert.equal(client.snapshot().pending, 0);
  } finally {
    client?.close();
    await server?.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('format metadata upgrade preserves existing binary identity and current CRLF bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-eol-upgrade-'));
  const root = path.join(temp, 'host'),
    directory = path.join(temp, 'client');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'collaboration.txt'), 'old\r\n');
  let server: CairnServer | undefined;
  let client: CairnClient | undefined;
  try {
    server = await CairnServer.start({ root, host: '127.0.0.1', port: 0 });
    const port = server.status().port,
      identity = server.status();
    const invite = server.invite('editor', `wss://127.0.0.1:${port}/cairn`);
    client = new CairnClient({ directory, invite, name: 'upgrade' });
    await client.connect();
    const before = client.snapshot();
    client.close();
    await server.stop();
    for (const [file, table] of [
      [path.join(root, '.cairn-next', 'server.sqlite'), 'project'],
      [path.join(directory, '.cairn-next-client', 'client.sqlite'), 'document'],
    ]) {
      const db = new DatabaseSync(file!);
      db.exec(`ALTER TABLE ${table} DROP COLUMN line_ending`);
      db.close();
    }
    server = await CairnServer.start({ root, host: '127.0.0.1', port });
    client = new CairnClient({ directory, invite, name: 'upgrade' });
    await client.connect();
    assert.equal(client.snapshot().lineEnding, 'crlf');
    assert.equal(client.snapshot().state, before.state);
    assert.equal(client.snapshot().clientId, before.clientId);
    assert.equal(server.status().serverId, identity.serverId);
    assert.equal(server.status().revision, identity.revision);
    assert.equal(fs.readFileSync(path.join(root, 'collaboration.txt'), 'utf8'), 'old\r\n');
  } finally {
    client?.close();
    await server?.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
