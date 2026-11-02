const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');

const project = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-newline-'));
const evidence = path.resolve(project, '../outputs/qa/newline');
const packaged = process.env.CAIRN_TEST_EXECUTABLE;
const apps = [];
const checks = [];
const errors = [];
fs.mkdirSync(evidence, { recursive: true });
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function until(read, accepts, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (accepts(result)) return result;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launch(profile) {
  const env = { ...process.env, CAIRN_USER_DATA: path.join(temporary, profile) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [project],
    cwd: project,
    env,
    timeout: 20000,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 400));
  });
  await page.waitForFunction(() => !!window.cairn && !!document.querySelector('h1'));
  return { app, page };
}
const state = (target) => target.page.evaluate(() => window.cairn.state());
async function pick(target, directory) {
  fs.mkdirSync(directory, { recursive: true });
  await target.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, directory);
  await target.page.getByRole('button', { name: '선택', exact: true }).click();
}
async function ready(target) {
  return until(
    () => state(target),
    (value) =>
      value.client?.initialized &&
      value.client.connection === 'online' &&
      value.client.pending === 0,
    'authenticated initialized client',
  );
}
async function equalText(host, friend, expected) {
  return until(
    async () => [await state(host), friend ? await state(friend) : null],
    ([a, b]) =>
      !!a.client &&
      a.client.connection === 'online' &&
      a.client.text === expected &&
      a.client.pending === 0 &&
      a.client.localProjection === 'applied' &&
      a.host?.projection === 'applied' &&
      a.host.peers.length === (friend ? 2 : 1) &&
      a.host.confirmedRevision === a.host.revision &&
      a.client.serverRevision === a.host.revision &&
      a.client.serverHash === sha(expected) &&
      (!b ||
        (b.client?.text === expected &&
          b.client.connection === 'online' &&
          b.client.pending === 0 &&
          b.client.serverRevision === a.host.revision &&
          b.client.serverHash === sha(expected) &&
          b.client.localProjection === 'applied')),
    'durable exact text and disk convergence',
  );
}
async function append(target, text) {
  await target.page.locator('.monaco-editor').click();
  await target.page.keyboard.press('Control+End');
  await target.page.keyboard.insertText(text);
}
async function main() {
  const hostProject = path.join(temporary, 'host-project');
  fs.mkdirSync(hostProject);
  const fileName = 'collaboration.txt';
  const seed = 'alpha\r\nbeta\r\n';
  fs.writeFileSync(path.join(hostProject, fileName), seed);
  const host = await launch('host-profile');
  // A bounded test-only delay makes the initial empty/read-only renderer observable.
  // It does not alter network data, saved state, certificate verification, or input.
  await host.app.evaluate(({ safeStorage }) => {
    const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
    safeStorage.encryptStringAsync = async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return encrypt(text);
    };
  });
  await pick(host, hostProject);
  await host.page.getByLabel('포트', { exact: true }).fill(String(await availablePort()));
  await host.page.getByRole('button', { name: '이 PC에서 서버 시작', exact: true }).click();
  await until(
    async () => ({
      data: await state(host),
      editors: await host.page.locator('.monaco-editor').count(),
    }),
    (result) => !!result.data.client && !result.data.client.initialized && result.editors === 1,
    'uninitialized empty Monaco before CRLF welcome',
  );
  await ready(host);
  assert.equal((await state(host)).client.text, seed);
  await append(host, 'TAIL');
  const first = await until(
    () => state(host),
    (value) => value.client?.pending === 0 && value.client?.text.includes('TAIL'),
    'first appended edit durable',
  );
  assert.equal(
    first.client.text,
    `${seed}TAIL`,
    'CRLF welcome followed by Monaco end-of-file insertion must preserve exact offsets',
  );
  await equalText(host, null, `${seed}TAIL`);
  assert.equal(fs.readFileSync(path.join(hostProject, fileName), 'utf8'), `${seed}TAIL`);
  checks.push(
    'Existing CRLF text: empty renderer → welcome → append preserves exact text, durable revision and disk bytes',
  );

  const address = first.host.addresses[0];
  assert.ok(address, 'LAN interface available for the second Electron client');
  const invitation = await host.page.evaluate(
    (address) => window.cairn.makeInvite({ role: 'editor', address }),
    address,
  );
  let friend = await launch('friend-profile');
  await friend.page.getByRole('button', { name: '친구의 서버 참가', exact: true }).click();
  await friend.page.getByLabel('초대 정보', { exact: true }).fill(invitation);
  await pick(friend, path.join(temporary, 'friend-project'));
  await friend.page.getByRole('button', { name: '서버에 참가', exact: true }).click();
  await ready(friend);
  await friend.page.getByLabel('초대 정보', { exact: true }).fill('');
  await equalText(host, friend, `${seed}TAIL`);
  await friend.page.locator('.monaco-editor').click();
  await friend.page.keyboard.press('Control+a');
  await friend.page.keyboard.press('Backspace');
  await equalText(host, friend, '');
  await friend.app.close();
  friend = await launch('friend-profile');
  await ready(friend);
  assert.equal((await state(friend)).client.text, '');
  await friend.page.locator('.monaco-editor').click();
  await friend.page.keyboard.insertText('after');
  await friend.page.keyboard.press('Enter');
  await friend.page.keyboard.insertText('reopen');
  await friend.page.keyboard.press('Enter');
  await until(
    () => state(friend),
    (value) => value.client?.pending === 0 && value.client.text.includes('reopen'),
    'newlines after empty-cache restart',
  );
  assert.equal(
    (await state(friend)).client.text,
    'after\r\nreopen\r\n',
    'empty document restart retains declared CRLF policy',
  );
  await equalText(host, friend, 'after\r\nreopen\r\n');
  await append(host, 'host');
  await host.page.keyboard.press('Enter');
  const expected = 'after\r\nreopen\r\nhost\r\n';
  const final = await equalText(host, friend, expected);
  for (const directory of [hostProject, final[0].client.directory, final[1].client.directory]) {
    assert.equal(sha(fs.readFileSync(path.join(directory, fileName))), sha(expected));
  }
  assert.equal(final[0].client.lineEnding, 'crlf');
  assert.equal(final[1].client.lineEnding, 'crlf');
  assert.equal(final[0].host.lineEnding, 'crlf');
  checks.push(
    'Clear CRLF document → restart one Electron client → Enter on both clients retains CRLF and matching file hashes',
  );
  assert.deepEqual(errors, []);
  checks.push('No renderer console errors or page exceptions');
  fs.writeFileSync(
    path.join(evidence, 'newline-results.json'),
    JSON.stringify(
      { passed: true, checks, physicalDevices: false, packaged: Boolean(packaged) },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
}
main()
  .catch((error) => {
    process.exitCode = 1;
    fs.writeFileSync(
      path.join(evidence, 'newline-results.json'),
      JSON.stringify({ passed: false, checks, error: error.message, errors }, null, 2),
    );
    console.error(error.stack);
  })
  .finally(async () => {
    for (const app of apps.reverse()) {
      try {
        await Promise.race([
          app.close(),
          delay(4000).then(() => {
            throw new Error('QA close timeout');
          }),
        ]);
      } catch {
        try {
          app.process().kill('SIGKILL');
          await delay(300);
        } catch {}
      }
    }
    // Only the freshly-created task fixture is removed; all user project paths are excluded.
    assert.ok(path.basename(temporary).startsWith('cairn-next-newline-'));
    assert.equal(path.dirname(temporary), os.tmpdir());
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
