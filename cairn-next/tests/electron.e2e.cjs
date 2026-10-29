const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');

const project = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-desktop-'));
const packaged = process.env.CAIRN_TEST_EXECUTABLE;
const evidence = path.resolve(project, '../outputs/qa', packaged ? 'packaged' : 'development');
fs.mkdirSync(evidence, { recursive: true });
const apps = [];
const checks = [];
const errors = [];
const started = Date.now();
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function until(read, test, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (test(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function availablePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function launch(name) {
  const env = { ...process.env, CAIRN_USER_DATA: path.join(temporary, name) };
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
  page.on('pageerror', (error) => errors.push({ name, text: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ name, text: message.text().slice(0, 500) });
  });
  await page.waitForFunction(() => !!window.cairn && document.querySelector('h1'));
  return { app, page, name };
}
const state = (target) => target.page.evaluate(() => window.cairn.state());
async function picker(target, folder) {
  fs.mkdirSync(folder, { recursive: true });
  await target.app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
  }, folder);
  await target.page.getByRole('button', { name: '선택', exact: true }).click();
}
async function edit(target, text) {
  await target.page.locator('.monaco-editor').click();
  await target.page.keyboard.press('Control+End');
  await target.page.keyboard.insertText(text);
}
async function converged(host, friend) {
  return until(
    async () => [await state(host), await state(friend)],
    ([a, b]) =>
      !!a.client &&
      !!b.client &&
      a.client.connection === 'online' &&
      b.client.connection === 'online' &&
      a.host?.peers.length === 2 &&
      a.client.text === b.client.text &&
      a.client.pending === 0 &&
      b.client.pending === 0 &&
      a.client.serverRevision === a.host.revision &&
      b.client.serverRevision === a.host.revision &&
      a.host.confirmedRevision === a.host.revision &&
      a.client.localProjection === 'applied' &&
      b.client.localProjection === 'applied',
    'both desktop clients confirm text/hash',
  );
}
async function main() {
  const host = await launch('host-profile');
  assert.equal(await host.page.title(), 'Cairn Next');
  assert.equal(host.page.url(), 'cairn://app/index.html');
  const isolation = await host.page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    api: !!window.cairn,
  }));
  assert.deepEqual(isolation, { node: 'undefined', process: 'undefined', api: true });
  checks.push('Desktop entry, real content, sandboxed renderer with limited preload');
  await host.page.screenshot({ path: path.join(evidence, 'desktop-home.png') });

  const port = await availablePort();
  await picker(host, path.join(temporary, 'host-project'));
  await host.page.getByLabel('포트', { exact: true }).fill(String(port));
  await host.page.getByLabel('내 표시 이름').fill('민수');
  await host.page.getByRole('button', { name: '이 PC에서 서버 시작', exact: true }).click();
  await until(
    () => state(host),
    (s) => s.client?.connection === 'online' && s.client.initialized && s.host?.peers.length === 1,
    'host uses authenticated local WSS client',
  );
  await host.page.getByRole('button', { name: '초대 정보 복사', exact: true }).click();
  const invitation = await host.app.evaluate(({ clipboard }) => clipboard.readText());
  const parsed = JSON.parse(invitation);
  assert.ok(parsed.fingerprint && parsed.token);
  assert.ok(
    !new URL(parsed.address).hostname.match(/^(localhost|127\.)/),
    'shared address is a real LAN interface',
  );
  checks.push(
    'Folder selection, start host, authenticated host client, LAN invite with fingerprint',
  );

  let friend = await launch('friend-profile');
  await friend.page.getByRole('button', { name: '친구의 서버 참가', exact: true }).click();
  await friend.page.getByLabel('내 표시 이름').fill('지우');
  await friend.page.getByLabel('초대 정보', { exact: true }).fill(invitation);
  await picker(friend, path.join(temporary, 'friend-project'));
  // Real bad-auth failure retains both the entered invitation and workcopy selection.
  const wrongInvite = JSON.stringify({ ...parsed, token: 'x'.repeat(43) });
  await friend.page.getByLabel('초대 정보', { exact: true }).fill(wrongInvite);
  await friend.page.getByRole('button', { name: '서버에 참가', exact: true }).click();
  await until(
    () => state(friend),
    (s) => s.client?.connection === 'error',
    'wrong authentication is rejected',
  );
  assert.equal(
    (await friend.page.getByLabel('초대 정보', { exact: true }).inputValue()) === wrongInvite,
    true,
  );
  await friend.page.getByLabel('초대 정보', { exact: true }).fill(invitation);
  await friend.page.getByRole('button', { name: '서버에 참가', exact: true }).click();
  await converged(host, friend);
  // The invite was tested, then removed from UI before any evidence screenshot.
  await friend.page.getByLabel('초대 정보', { exact: true }).fill('');
  checks.push(
    'Second Electron app joins using actual LAN address, authentication, empty workcopy and verification',
  );

  await edit(host, 'const greeting = "안녕하세요";\n');
  await converged(host, friend);
  await edit(friend, '// 中文协作\n');
  let pair = await converged(host, friend);
  assert.equal(pair[0].client.text, 'const greeting = "안녕하세요";\n// 中文协作\n');
  const afterBoth = pair[0].client.text;
  await friend.page.keyboard.press('Control+z');
  pair = await converged(host, friend);
  assert.equal(
    pair[0].client.text,
    'const greeting = "안녕하세요";\n',
    'undo removes own work without deleting remote work',
  );
  await friend.page.keyboard.press('Control+y');
  pair = await converged(host, friend);
  assert.equal(pair[0].client.text, afterBoth);
  checks.push(
    'Monaco typing, UTF-8 Korean/Chinese paste, remote replication, own-origin undo/redo',
  );

  // Chromium IME composition exercises the actual Monaco input path. It is not a
  // claim that physical Windows/macOS input method keyboards were manually tested.
  const cdp = await friend.app.context().newCDPSession(friend.page);
  await friend.page.locator('.monaco-editor').click();
  await friend.page.keyboard.press('Control+End');
  await cdp.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '한글' });
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '中文' });
  pair = await converged(host, friend);
  assert.equal(pair[0].client.text, afterBoth + '한글中文');
  checks.push('Chromium CDP Korean and Chinese composition committed once through Monaco/Yjs');
  await friend.page.keyboard.press('ArrowLeft');
  await friend.page.keyboard.press('Shift+ArrowLeft');
  await until(
    () => host.page.locator('.yRemoteSelectionHead').count(),
    (count) => count > 0,
    'remote cursor decoration appears',
  );
  const cursorName = await host.page
    .locator('.yRemoteSelectionHead')
    .first()
    .evaluate((element) => getComputedStyle(element, '::after').content);
  assert.ok(cursorName.includes('지우'));
  checks.push('Remote selection/cursor appears with authenticated connection display name');
  const safeText = pair[0].client.text;
  await friend.page.keyboard.press('Control+End');
  const oversized = ('x'.repeat(1024) + '\n').repeat(1024);
  await friend.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), oversized);
  await friend.page.keyboard.press('Control+v');
  await friend.page.getByRole('alert').filter({ hasText: '복구 사본' }).waitFor();
  const rejectedState = await state(friend);
  assert.equal(
    rejectedState.client.text,
    safeText,
    'oversized draft does not replace durable document',
  );
  const recoveryPath = path.join(rejectedState.client.directory, '.cairn-next-client', 'recovery');
  const recoveryText = fs
    .readdirSync(recoveryPath)
    .filter((name) => name.startsWith('rejected-local-') && name.endsWith('.txt'));
  assert.ok(
    recoveryText.some(
      (name) => fs.readFileSync(path.join(recoveryPath, name), 'utf8') === safeText + oversized,
    ),
  );
  await friend.page.keyboard.press('Control+z');
  await until(
    () => friend.page.getByRole('alert').filter({ hasText: '복구 사본' }).count(),
    (count) => count === 0,
    'undo unblocks durable save',
  );
  pair = await converged(host, friend);
  assert.equal(pair[0].client.text, safeText);
  checks.push(
    'Oversized Monaco paste is preserved in recovery files; own undo unblocks saving without data loss',
  );

  await friend.page.getByRole('button', { name: '연결 끊기 · 오프라인 작업', exact: true }).click();
  await edit(friend, '\n오프라인 보관');
  const offline = await until(
    () => state(friend),
    (s) => s.client.connection === 'offline' && s.client.pending > 0,
    'offline durable outbox',
  );
  assert.ok(offline.client.localSaved);
  assert.equal(offline.client.confirmedRevision, null);
  await friend.page.screenshot({ path: path.join(evidence, 'desktop-offline.png') });
  await friend.app.close();
  friend = await launch('friend-profile');
  pair = await converged(host, friend);
  assert.ok(pair[0].client.text.endsWith('오프라인 보관'));
  checks.push(
    'Offline editing, truthful pending status, full app restart, encrypted session recovery and hash convergence',
  );

  await host.page.getByRole('button', { name: '재시작', exact: true }).click();
  pair = await converged(host, friend);
  assert.equal(pair[0].host.fileId, parsed.fileId);
  checks.push('Server restart from real UI preserves file identity and both clients reconnect');
  await host.page.screenshot({ path: path.join(evidence, 'desktop-collaboration.png') });

  await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const hidden = await host.app.evaluate(
    ({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible(),
  );
  assert.equal(hidden, true);
  await edit(friend, '\n트레이 서버에서 저장');
  await until(
    () => state(friend),
    (s) => s.client.pending === 0 && s.client.serverProjection === 'applied',
    'hidden server remains durable',
  );
  await host.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show();
  });
  await converged(host, friend);
  checks.push('Closing editor hides host to tray; remote edit still reaches durable server');

  await host.page.getByRole('button', { name: '서버 중지', exact: true }).click();
  await until(
    () => state(friend),
    (s) => s.client.connection !== 'online',
    'server stop visible at client',
  );
  assert.equal((await state(host)).host, null);
  checks.push('Explicit stop ends hosting while local work remains readable');

  await host.page.getByRole('button', { name: '진단 정보 복사', exact: true }).click();
  const diagnostics = await host.app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(!diagnostics.includes(parsed.token));
  assert.ok(!diagnostics.includes('const greeting'));
  checks.push('Diagnostics exclude invitation token and file content');

  const widthCheck = await host.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1050, 760);
    return w.getContentSize();
  });
  await delay(200);
  const overflow = await host.page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false);
  await host.page.screenshot({ path: path.join(evidence, 'desktop-compact.png') });
  checks.push(`Compact desktop ${widthCheck.join('x')} has no page horizontal overflow`);

  await host.page.getByRole('button', { name: '이 PC에서 서버 시작', exact: true }).click();
  await converged(host, friend);
  await host.app.close();
  await until(
    () => state(friend),
    (s) => s.client.connection !== 'online',
    'full app quit stops its running server',
  );
  checks.push(
    'Full application quit stops an actively hosting process and the peer reports disconnection',
  );

  const finalState = await state(friend);
  const fileBytes = fs.readFileSync(path.join(temporary, 'friend-project', 'collaboration.txt'));
  assert.equal(sha(fileBytes), sha(finalState.client.text));
  assert.equal(errors.length, 0, 'No renderer console/page errors: ' + JSON.stringify(errors));
  checks.push('Final local file SHA-256 matches durable editor text; no renderer errors');
  fs.writeFileSync(
    path.join(evidence, 'desktop-results.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        elapsedMs: Date.now() - started,
        runtime: finalState.runtime,
        errors,
        twoPhysicalDevices: false,
        physicalIME: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, checks, elapsedMs: Date.now() - started, evidence }, null, 2),
  );
}
main()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
    fs.writeFileSync(
      path.join(evidence, 'desktop-results.json'),
      JSON.stringify(
        { passed: false, completedChecks: checks, error: error.message, errors },
        null,
        2,
      ),
    );
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
    // Only task-owned fixtures; screenshots and test report remain outside source.
    assert.ok(path.basename(temporary).startsWith('cairn-next-desktop-'));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
