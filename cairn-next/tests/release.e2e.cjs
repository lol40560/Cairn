/** RC desktop QA: real Electron, ReleaseApi, SQLite, filesystem and LAN WSS.
 * Only native folder/save pickers are replaced. No API/network/model mocks. */
const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { unzipSync } = require('fflate');

const project = path.resolve(__dirname, '..');
const packaged = process.env.CAIRN_TEST_EXECUTABLE;
const parent = fs.realpathSync.native(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'cairn-release-ui-'));
const evidenceRoot = path.resolve(
  project,
  '../outputs/qa',
  packaged ? 'rc-packaged' : 'rc-development',
);
const evidence = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(evidence, { recursive: true });
const applications = [];
const childProcesses = new Map();
const checks = [];
const errors = [];
const secrets = new Set();
const started = Date.now();
const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
const documentEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
let phase = 'launch';
let currentWindow;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => Buffer.from(value).toString('base64');
const state = (target) => target.page.evaluate(() => window.cairn.state());

function redact(value) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.split(secret).join('[redacted]');
  return text
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[redacted certificate]')
    .replace(/("(?:token|certificate|privateKey)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"');
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(read, accepts, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (accepts(result)) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function step(label, run) {
  phase = label;
  const time = Date.now();
  await run();
  checks.push({ name: label, elapsedMs: Date.now() - time });
  console.log(`PASS ${label}`);
}
async function screenshot(target, filename) {
  if (target.page.isClosed()) return;
  // Invitation fields are masked even when an error leaves the join form populated.
  await target.page.screenshot({
    path: path.join(evidence, filename),
    fullPage: false,
    mask: [
      target.page.locator('textarea[autocomplete="off"]'),
      target.page.locator('input[type=password]'),
    ],
  });
}
async function launch(profile, name, firstRun = false) {
  const env = { ...process.env, CAIRN_USER_DATA: path.join(temporary, profile) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [project],
    cwd: project,
    env,
    timeout: 25000,
  });
  applications.push(app);
  childProcesses.set(app, app.process());
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    errors.push({ profile, kind: 'page', message: redact(error.message).slice(0, 700) }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push({ profile, kind: 'console', message: redact(message.text()).slice(0, 700) });
  });
  await page.waitForFunction(() => !!window.cairn && !!document.querySelector('.navigation'));
  const target = { app, page, profile, name };
  currentWindow = target;
  if (firstRun) {
    assert.equal((await state(target)).preferences.locale, 'ko', 'new profile starts in Korean');
    await page.evaluate(
      (name) => window.cairn.savePreferences({ locale: 'en', displayName: name }),
      name,
    );
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Getting started', exact: true })
      .waitFor({ state: 'detached' });
  }
  return target;
}
async function nav(target, name) {
  currentWindow = target;
  const label = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\d+)?$`);
  const button = target.page
    .getByRole('navigation', { name: 'Cairn' })
    .getByRole('button', { name: label });
  await button.click();
  await until(
    () => button.getAttribute('aria-current'),
    (value) => value === 'page',
    'selected navigation page',
  );
}
async function nativeFolder(target, folder) {
  fs.mkdirSync(folder, { recursive: true });
  await target.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folder);
}
async function openFolder(target, folder) {
  await nav(target, 'Home');
  await nativeFolder(target, folder);
  await target.page
    .locator('.home-hero')
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  return ready(target);
}
async function ready(target) {
  let last;
  try {
    return await until(
      async () => (last = await state(target)),
      (value) =>
        value.current &&
        value.replica?.initialized &&
        value.replica.connection === 'online' &&
        !value.busy &&
        value.replica.pending === 0,
      'project initialized through authenticated connection',
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'ready-failure.json'),
      redact(JSON.stringify(last, null, 2)),
    );
    throw error;
  }
}
function projectFile(value, relative) {
  const found = value.current?.files.find((item) => item.path === relative && !item.deleted);
  assert.ok(found, `Expected project file ${relative}`);
  return found;
}
async function selectFile(target, relative) {
  await nav(target, 'Files');
  await target.page.keyboard.press(`${shortcut}+p`);
  const dialog = target.page.getByRole('dialog', { name: 'Quick Open', exact: true });
  await dialog.getByRole('textbox', { name: 'Search', exact: true }).fill(relative);
  await dialog.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' });
  await until(
    () => state(target),
    (value) => {
      const file = projectFile(value, relative);
      return file.kind === 'text' ? value.editor?.fileId === file.id : value.editor === null;
    },
    'selected file editor or binary preview',
  );
  await target.page
    .locator('.editor-route.visible .file-toolbar .file-path')
    .filter({ hasText: relative })
    .waitFor();
}
async function append(target, text) {
  const before = (await state(target)).editor.text;
  const editor = target.page.locator('.editor-route.visible .monaco-editor');
  await editor.waitFor();
  await editor.click();
  await target.page.keyboard.press(documentEnd);
  await target.page.keyboard.insertText(text);
  await until(
    () => state(target),
    (value) => value.editor?.text === before + text,
    'Monaco edit persisted in local document',
  );
}
async function command(target, input, scope) {
  return target.page.evaluate(
    async ({ input, scope }) => {
      const current = await window.cairn.state();
      return window.cairn.command(
        input,
        scope || { projectId: current.replica.projectId, clientId: current.replica.clientId },
      );
    },
    { input, scope },
  );
}
async function converged(host, friend) {
  let last;
  const caller = new Error().stack;
  try {
    return await until(
      async () => (last = [await state(host), friend ? await state(friend) : null]),
      ([a, b]) => {
        const peers = [a, b].filter(Boolean);
        return (
          peers.every(
            (value) =>
              value.replica?.connection === 'online' &&
              value.replica.initialized &&
              !value.replica.pending &&
              !value.replica.rejected &&
              value.replica.revision === a.replica.revision &&
              value.replica.manifestHash === a.replica.manifestHash &&
              value.replica.projections.every((p) => p.state === 'applied'),
          ) && a.team?.confirmedRevision === a.replica.revision
        );
      },
      'exact project catalogs and all projections confirmed',
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'convergence-failure.json'),
      redact(JSON.stringify({ caller, states: last }, null, 2)),
    );
    throw error;
  }
}
function diskMatches(root, files) {
  for (const file of files.filter((file) => !file.deleted && file.kind !== 'directory'))
    assert.equal(
      sha(fs.readFileSync(path.join(root, ...file.path.split('/')))),
      file.hash,
      `disk hash for ${file.path}`,
    );
}
async function confirm(target, title) {
  const dialog = title
    ? target.page.getByRole('dialog', { name: title, exact: true }).last()
    : target.page.getByRole('dialog').last();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function createFile(target, relative, content, directory = false) {
  await nav(target, 'Files');
  await target.page
    .getByRole('button', { name: directory ? 'New folder' : 'New file', exact: true })
    .click();
  const dialog = target.page.getByRole('dialog', {
    name: directory ? 'New folder' : 'New file',
    exact: true,
  });
  await dialog.getByLabel('Path within project', { exact: true }).fill(relative);
  if (!directory) await dialog.getByLabel('Content', { exact: true }).fill(content);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await until(
    () => state(target),
    (value) => value.current.files.some((file) => file.path === relative),
    'new file appears in real catalog',
  );
}
async function moveFile(target, from, to, action) {
  await selectFile(target, from);
  await target.page
    .locator('.editor-route.visible .file-toolbar')
    .getByRole('button', { name: action, exact: true })
    .click();
  const dialog = target.page.getByRole('dialog', { name: action, exact: true });
  await dialog.getByLabel('Path within project', { exact: true }).fill(to);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function closeApp(target, throughWindow = false) {
  const child = childProcesses.get(target.app);
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (throughWindow)
    await target.app
      .evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      })
      .catch((error) => {
        if (!/closed|destroyed/i.test(String(error))) throw error;
      });
  else await target.app.close();
  await bounded(exited, 10000, 'whole Electron process exits');
}

async function main() {
  const hostRoot = path.join(temporary, 'host-project'),
    friendRoot = path.join(temporary, 'friend-project');
  fs.mkdirSync(path.join(hostRoot, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(hostRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(hostRoot, 'ignored'), { recursive: true });
  const seed = 'seed LF\n',
    crlf = '첫줄\r\n第二行\r\n',
    binary = Buffer.from([0, 255, 1, 2, 3]);
  const fixtureSecret = 'RC_FIXTURE_ONLY_NOT_A_CREDENTIAL';
  secrets.add(fixtureSecret);
  fs.writeFileSync(path.join(hostRoot, 'live.txt'), seed);
  fs.writeFileSync(path.join(hostRoot, 'nested', 'windows.txt'), crlf);
  const longPath = `nested/${'long-file-name-'.repeat(6)}中文한글.ts`;
  fs.writeFileSync(path.join(hostRoot, longPath), 'export const checked = true;\n');
  fs.writeFileSync(path.join(hostRoot, 'assets', 'data.bin'), binary);
  fs.writeFileSync(path.join(hostRoot, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(hostRoot, '.env'), fixtureSecret);
  fs.writeFileSync(path.join(hostRoot, 'ignored', 'private.txt'), fixtureSecret);
  let host = await launch('host-profile', 'Owner 한글', true),
    friend;
  let invite, parsed, expected;

  await step(
    'Entry, Korean default, onboarding, renderer isolation and native-folder open',
    async () => {
      assert.equal(await host.page.title(), 'Cairn Next');
      assert.equal(host.page.url(), 'cairn://app/index.html');
      assert.deepEqual(
        await host.page.evaluate(() => ({
          require: typeof window.require,
          process: typeof window.process,
          bridge: !!window.cairn,
        })),
        { require: 'undefined', process: 'undefined', bridge: true },
      );
      assert.ok(
        await host.page
          .getByRole('heading', { name: 'A space to keep working', exact: true })
          .isVisible(),
      );
      assert.equal(await host.page.locator('vite-error-overlay').count(), 0);
      await screenshot(host, '01-home.png');
      const opened = await openFolder(host, hostRoot);
      assert.equal(opened.current.path, hostRoot);
      assert.equal(opened.current.kind, 'local');
      assert.equal(opened.team.enabled, false);
      assert.equal(
        opened.current.files.some(
          (file) => file.path === '.env' || file.path.startsWith('ignored/'),
        ),
        false,
      );
      await selectFile(host, 'live.txt');
      await selectFile(host, 'nested/windows.txt');
      assert.ok((await host.page.getByRole('tab').count()) >= 2);
      assert.equal((await state(host)).editor.lineEnding, 'crlf');
      await selectFile(host, longPath);
      assert.equal(
        await host.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
      await selectFile(host, 'assets/data.bin');
      await host.page
        .locator('.binary-preview')
        .getByText('Preview-only file', { exact: false })
        .waitFor();
      assert.equal((await state(host)).editor, null);
      await selectFile(host, 'live.txt');
      await screenshot(host, '02-files-tabs.png');
    },
  );

  await step(
    'Create team, copied LAN invitation, real authentication failure and UI retry',
    async () => {
      await nav(host, 'Team');
      await host.page.getByRole('button', { name: 'Create team', exact: true }).click();
      await until(
        () => state(host),
        (value) => value.team?.enabled && value.replica.connection === 'online',
        'team is exposed on LAN',
      );
      await host.page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
      invite = await host.app.evaluate(({ clipboard }) => clipboard.readText());
      parsed = JSON.parse(invite);
      secrets.add(invite);
      secrets.add(parsed.token);
      secrets.add(parsed.certificate);
      assert.equal(parsed.version, 2);
      assert.ok(parsed.token && parsed.fingerprint);
      assert.equal(new URL(parsed.address).protocol, 'wss:');
      assert.ok(
        !/^(localhost|127\.)/.test(new URL(parsed.address).hostname),
        'actual LAN invitation address',
      );
      friend = await launch('friend-profile', 'Peer 中文', true);
      await nav(friend, 'Team');
      await nativeFolder(friend, friendRoot);
      const wrong = JSON.stringify({ ...parsed, token: 'INVALID_TEST_TOKEN_'.repeat(3) });
      secrets.add(wrong);
      const invitationField = friend.page.locator('.page form textarea');
      await invitationField.fill(wrong);
      await friend.page.getByRole('button', { name: 'Choose folder', exact: true }).click();
      await friend.page.getByRole('button', { name: 'Join team', exact: true }).click();
      await until(
        () => state(friend),
        (value) => value.replica?.connection === 'error' && value.error?.code === 'AUTH_FAILED',
        'authentication rejection',
      );
      assert.equal(
        (await invitationField.inputValue()) === wrong,
        true,
        'retry preserves entered invitation',
      );
      assert.equal(await friend.page.locator('.folder-picker input').inputValue(), friendRoot);
      await invitationField.fill(invite);
      await friend.page.getByRole('button', { name: 'Join team', exact: true }).click();
      const pair = await converged(host, friend);
      assert.equal(pair[0].team.peers.length, 2);
      assert.equal(pair[1].current.kind, 'joined');
      await invitationField.fill('');
      assert.equal(fs.existsSync(path.join(friendRoot, '.env')), false);
      assert.equal(fs.existsSync(path.join(friendRoot, 'ignored', 'private.txt')), false);
      diskMatches(hostRoot, pair[0].current.files);
      diskMatches(friendRoot, pair[1].current.files);
      await screenshot(friend, '03-team-connected.png');
    },
  );

  await step(
    'Monaco multi-user edits, own undo/redo, Korean/Chinese CDP composition and CRLF Enter',
    async () => {
      await selectFile(host, 'live.txt');
      await selectFile(friend, 'live.txt');
      await append(host, 'HOST 한글\n');
      await converged(host, friend);
      await append(friend, 'PEER 中文\n');
      let pair = await converged(host, friend);
      expected = seed + 'HOST 한글\nPEER 中文\n';
      assert.equal(pair[0].editor.text, expected);
      assert.equal(pair[1].editor.text, expected);
      await friend.page.keyboard.press(`${shortcut}+z`);
      pair = await converged(host, friend);
      assert.equal(pair[0].editor.text, seed + 'HOST 한글\n');
      await friend.page.keyboard.press(`${shortcut}+y`);
      pair = await converged(host, friend);
      assert.equal(pair[0].editor.text, expected);
      const cdp = await friend.app.context().newCDPSession(friend.page);
      await friend.page.locator('.editor-route.visible .monaco-editor').click();
      await friend.page.keyboard.press(documentEnd);
      for (const text of ['ㅎ', '한', '한글'])
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      await cdp.send('Input.insertText', { text: '한글' });
      for (const text of ['zhong', '中文'])
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      await cdp.send('Input.insertText', { text: '中文' });
      await cdp.detach();
      expected += '한글中文';
      pair = await converged(host, friend);
      assert.equal(pair[0].editor.text, expected);
      await friend.page.keyboard.press('ArrowLeft');
      await friend.page.keyboard.press('Shift+ArrowLeft');
      await until(
        () => host.page.locator('.yRemoteSelectionHead').count(),
        (count) => count > 0,
        'authenticated remote cursor is rendered',
      );
      await screenshot(host, '04-collaboration-ime.png');
      await selectFile(host, 'nested/windows.txt');
      await append(host, 'tail');
      await host.page.keyboard.press('Enter');
      await host.page.keyboard.insertText('終');
      pair = await converged(host, friend);
      assert.equal(pair[0].editor.text, crlf + 'tail\r\n終');
      assert.equal(
        fs.readFileSync(path.join(friendRoot, 'nested', 'windows.txt'), 'utf8'),
        crlf + 'tail\r\n終',
      );
      assert.equal(sha(fs.readFileSync(path.join(friendRoot, 'assets', 'data.bin'))), sha(binary));
    },
  );

  await step(
    'File and folder creation, stable-identity rename/move, delete preview and trash restore through UI',
    async () => {
      await createFile(host, 'scratch', '', true);
      await createFile(host, 'scratch/ui.txt', 'draft\n');
      await converged(host, friend);
      const id = projectFile(await state(host), 'scratch/ui.txt').id;
      await moveFile(host, 'scratch/ui.txt', 'scratch/renamed.txt', 'Rename');
      await converged(host, friend);
      await moveFile(host, 'scratch/renamed.txt', 'moved-ui.txt', 'Move');
      let pair = await converged(host, friend);
      assert.equal(projectFile(pair[0], 'moved-ui.txt').id, id);
      await selectFile(host, 'moved-ui.txt');
      await host.page
        .locator('.editor-route.visible .file-toolbar')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await host.page
        .getByRole('dialog', { name: 'Delete', exact: true })
        .getByText('moved-ui.txt', { exact: true })
        .waitFor();
      await confirm(host, 'Delete');
      await converged(host, friend);
      assert.equal(fs.existsSync(path.join(hostRoot, 'moved-ui.txt')), false);
      await nav(host, 'Deleted files');
      const row = host.page
        .locator('.page section.card')
        .filter({ has: host.page.getByRole('heading', { name: 'moved-ui.txt', exact: true }) });
      await row.getByRole('button', { name: 'Restore', exact: true }).click();
      await confirm(host, 'Restore');
      pair = await converged(host, friend);
      assert.equal(projectFile(pair[0], 'moved-ui.txt').id, id);
      assert.equal(fs.readFileSync(path.join(hostRoot, 'moved-ui.txt'), 'utf8'), 'draft\n');
    },
  );

  await step(
    'Checkpoint creation, file comparison, selected restore and protective checkpoint through UI',
    async () => {
      await nav(host, 'Checkpoints');
      await host.page.getByLabel('Checkpoint name', { exact: true }).fill('UI checkpoint');
      await host.page.getByRole('button', { name: 'Create checkpoint', exact: true }).click();
      await until(
        () => state(host),
        (value) =>
          value.replica.metadata.checkpoints.some(
            (checkpoint) => checkpoint.name === 'UI checkpoint',
          ),
        'checkpoint created by visible form',
      );
      await converged(host, friend);
      await selectFile(host, 'moved-ui.txt');
      await append(host, 'after checkpoint\n');
      await converged(host, friend);
      await nav(host, 'Checkpoints');
      const row = host.page
        .locator('.page section.card')
        .filter({ has: host.page.getByRole('heading', { name: 'UI checkpoint', exact: true }) });
      await row.getByRole('button', { name: 'Compare & restore', exact: true }).click();
      const dialog = host.page.getByRole('dialog', {
        name: 'Checkpoints · UI checkpoint',
        exact: true,
      });
      await dialog.getByRole('checkbox', { name: 'moved-ui.txt', exact: true }).check();
      await dialog.getByRole('button', { name: /^Restore selected files/ }).click();
      await confirm(host, 'Restore');
      const pair = await converged(host, friend);
      assert.equal(fs.readFileSync(path.join(hostRoot, 'moved-ui.txt'), 'utf8'), 'draft\n');
      assert.ok(pair[0].replica.metadata.checkpoints.some((checkpoint) => checkpoint.protected));
      await screenshot(host, '05-checkpoints.png');
      await nav(host, 'Activity');
      await host.page.getByRole('button', { name: 'By session', exact: true }).click();
      await host.page.locator('.activity-row').first().click();
      await host.page
        .getByRole('dialog', { name: 'Activity', exact: true })
        .locator('.diff-text')
        .waitFor();
      await host.page
        .getByRole('dialog', { name: 'Activity', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    },
  );

  await step(
    'Real binary CAS conflict setup, preserved versions, UI comparison and Keep both resolution',
    async () => {
      const before = projectFile(await state(friend), 'assets/data.bin'),
        remote = Buffer.from([0, 10, 255, 20]),
        local = Buffer.from([0, 30, 255, 40]);
      await command(host, {
        kind: 'write',
        fileId: before.id,
        generation: before.generation,
        baseRevision: before.revision,
        baseHash: before.hash,
        data: encode(remote),
      });
      await converged(host, friend);
      const rejection = await command(friend, {
        kind: 'write',
        fileId: before.id,
        generation: before.generation,
        baseRevision: before.revision,
        baseHash: before.hash,
        data: encode(local),
      }).then(
        () => null,
        (error) => redact(error.message),
      );
      assert.ok(rejection?.includes('STALE_REVISION'), 'stale binary CAS must reject');
      const conflicted = await state(friend),
        conflict = conflicted.replica.metadata.conflicts.find(
          (item) => item.fileId === before.id && item.status === 'open',
        );
      assert.ok(conflict);
      assert.equal(conflict.localHash, sha(local));
      assert.equal(conflict.remoteHash, sha(remote));
      for (const [hash, bytes] of [
        [conflict.localHash, local],
        [conflict.remoteHash, remote],
      ]) {
        const value = await friend.page.evaluate((hash) => window.cairn.readBlob(hash), hash);
        assert.equal(Buffer.from(value.data, 'base64').compare(bytes), 0);
      }
      await nav(friend, 'Conflicts');
      await friend.page
        .locator('.page section.card')
        .filter({ has: friend.page.getByRole('heading', { name: 'assets/data.bin', exact: true }) })
        .getByRole('button', { name: 'Compare', exact: true })
        .click();
      const dialog = friend.page.getByRole('dialog', { name: 'Resolve', exact: true });
      await dialog.getByRole('radio', { name: 'Keep both', exact: true }).check();
      await screenshot(friend, '06-conflict-review.png');
      await dialog.getByRole('button', { name: 'Resolve', exact: true }).click();
      await confirm(friend, 'Resolve');
      const pair = await converged(host, friend);
      assert.ok(pair[0].current.files.some((file) => file.hash === sha(remote)));
      assert.ok(pair[0].current.files.some((file) => file.hash === sha(local)));
      assert.equal(pair[1].replica.rejected, 0);
    },
  );

  await step(
    'All navigation pages, ko/en/zh-TW UI, compact layout, legal text and snapshot export',
    async () => {
      const labels = {
        en: [
          'Home',
          'Projects',
          'Files',
          'Activity',
          'Team',
          'Conflicts',
          'Checkpoints',
          'Deleted files',
          'Settings',
        ],
        ko: ['홈', '프로젝트', '파일', '활동', '팀', '충돌', '체크포인트', '삭제된 파일', '설정'],
        'zh-TW': ['首頁', '專案', '檔案', '活動', '團隊', '衝突', '檢查點', '已刪除檔案', '設定'],
      };
      for (const label of labels.en) {
        await nav(host, label);
        assert.ok((await host.page.locator('main').innerText()).trim().length > 0);
        assert.equal(await host.page.locator('vite-error-overlay').count(), 0);
      }
      const saveLabels = { en: 'Save', ko: '저장', 'zh-TW': '儲存' };
      let current = 'en';
      for (const locale of ['ko', 'zh-TW', 'en']) {
        const profile = host.page.locator('.settings-page section.card').first();
        await profile.locator('select').first().selectOption(locale);
        await profile.getByRole('button', { name: saveLabels[current], exact: true }).click();
        await until(
          () => state(host),
          (value) => value.preferences.locale === locale,
          'language persisted',
        );
        assert.equal(await host.page.locator('html').getAttribute('lang'), locale);
        for (const label of labels[locale])
          assert.ok(
            await host.page
              .getByRole('navigation', { name: 'Cairn' })
              .getByRole('button', { name: label, exact: true })
              .isVisible(),
          );
        await screenshot(host, `07-settings-${locale}.png`);
        current = locale;
      }
      assert.ok(await host.page.getByText('PC server — Coming Soon', { exact: true }).isVisible());
      assert.equal(
        await host.page
          .locator('.coming-soon button, .coming-soon input, .coming-soon select')
          .count(),
        0,
      );
      assert.equal(
        await host.page.evaluate(
          () => 'startHost' in window.cairn || 'restartHost' in window.cairn,
        ),
        false,
      );
      await host.page.getByRole('button', { name: 'Licenses', exact: true }).click();
      await host.page
        .getByRole('dialog', { name: 'Licenses', exact: true })
        .locator('.legal-text')
        .waitFor();
      assert.ok((await host.page.locator('.legal-text').innerText()).length > 100);
      await host.page
        .getByRole('dialog', { name: 'Licenses', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      const output = path.join(temporary, 'snapshot.zip');
      await host.app.evaluate(({ dialog }, filename) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
      }, output);
      const snapshot = await state(host);
      await host.page.getByRole('button', { name: 'Export snapshot', exact: true }).click();
      await until(async () => fs.existsSync(output), Boolean, 'snapshot export file');
      const archive = unzipSync(fs.readFileSync(output));
      assert.ok(archive['.cairn-snapshot-manifest.json']);
      for (const file of snapshot.current.files.filter((file) => file.kind !== 'directory'))
        assert.equal(sha(archive[file.path]), file.hash, `ZIP bytes: ${file.path}`);
      assert.equal(
        Object.keys(archive).some(
          (name) =>
            name === '.env' || name.startsWith('ignored/') || name.startsWith('.cairn-next/'),
        ),
        false,
      );
      for (const bytes of Object.values(archive))
        assert.equal(Buffer.from(bytes).includes(Buffer.from(parsed.token)), false);
      await host.page
        .getByRole('button', { name: 'Copy diagnostics', exact: true })
        .first()
        .click();
      const diagnostics = await host.app.evaluate(({ clipboard }) => clipboard.readText());
      assert.equal(diagnostics.includes(parsed.token), false);
      assert.equal(diagnostics.includes(expected), false);
      await host.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1050, 760),
      );
      await delay(200);
      assert.equal(
        await host.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
      await screenshot(host, '08-compact.png');
    },
  );

  await step(
    'Closing creator window ends process/team; offline Monaco edit survives creator and peer restart',
    async () => {
      await selectFile(friend, 'live.txt');
      const oldPid = host.app.process().pid;
      await closeApp(host, true);
      await until(
        () => state(friend),
        (value) => value.replica.connection !== 'online',
        'creator window close ends team connection',
      );
      await append(friend, '\nOFFLINE-SAVED');
      expected += '\nOFFLINE-SAVED';
      const offline = await until(
        () => state(friend),
        (value) => value.replica.pending > 0 && value.editor.text === expected,
        'offline edit persists',
      );
      assert.equal(offline.replica.confirmedRevision, null);
      assert.equal(fs.readFileSync(path.join(friendRoot, 'live.txt'), 'utf8'), expected);
      await screenshot(friend, '09-offline.png');
      host = await launch('host-profile', 'Owner 한글');
      await ready(host);
      assert.notEqual(host.app.process().pid, oldPid);
      let pair = await converged(host, friend);
      assert.equal(pair[0].team.teamId, parsed.teamId);
      assert.equal(projectFile(pair[0], 'live.txt').hash, sha(expected));
      await closeApp(friend);
      friend = await launch('friend-profile', 'Peer 中文');
      await ready(friend);
      pair = await converged(host, friend);
      assert.equal(projectFile(pair[1], 'live.txt').hash, sha(expected));
      diskMatches(hostRoot, pair[0].current.files);
      diskMatches(friendRoot, pair[1].current.files);
      assert.equal(fs.readFileSync(path.join(hostRoot, '.env'), 'utf8'), fixtureSecret);
    },
  );

  await step(
    'Stale project scope rejects mutation; missing folder locate and remove-from-list preserve files',
    async () => {
      const prior = await state(host),
        stale = { projectId: prior.replica.projectId, clientId: prior.replica.clientId };
      const other = path.join(temporary, 'second-project');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'keep.txt'), 'keep this fixture\n');
      const opened = await openFolder(host, other);
      const projectId = opened.current.id;
      const rejected = await command(
        host,
        {
          kind: 'create',
          path: 'stale-must-not-exist.txt',
          nodeKind: 'text',
          data: encode('wrong context'),
        },
        stale,
      ).then(
        () => null,
        (error) => redact(error.message),
      );
      assert.ok(rejected?.includes('STALE_SESSION'));
      assert.equal(fs.existsSync(path.join(other, 'stale-must-not-exist.txt')), false);
      assert.equal(fs.existsSync(path.join(hostRoot, 'stale-must-not-exist.txt')), false);
      await host.page.evaluate(() => window.cairn.closeProject());
      const relocated = path.join(temporary, 'second-relocated');
      fs.renameSync(other, relocated);
      await host.page.reload();
      await host.page.waitForFunction(() => !!document.querySelector('.navigation'));
      await nav(host, 'Projects');
      let row = host.page.locator('.project-card').filter({ hasText: other });
      await row.getByText('Folder not found', { exact: false }).waitFor();
      await nativeFolder(host, relocated);
      await row.getByRole('button', { name: 'Locate folder', exact: true }).click();
      const found = await ready(host);
      assert.equal(found.current.id, projectId);
      assert.equal(found.current.path, relocated);
      assert.equal(
        fs.readFileSync(path.join(relocated, 'keep.txt'), 'utf8'),
        'keep this fixture\n',
      );
      await nav(host, 'Projects');
      row = host.page.locator('.project-card').filter({ hasText: relocated });
      await row.getByRole('button', { name: 'Remove from list', exact: true }).click();
      await confirm(host, 'Remove this project from the recent list?');
      const removed = await state(host);
      assert.equal(
        removed.projects.some((project) => project.id === projectId),
        false,
      );
      assert.equal(
        fs.readFileSync(path.join(relocated, 'keep.txt'), 'utf8'),
        'keep this fixture\n',
      );
      assert.ok(fs.existsSync(path.join(relocated, '.cairn-next', 'project.sqlite')));
      await screenshot(host, '10-projects-preserved.png');
    },
  );

  await step(
    'Isolated simulation edits and resets without real project, team or GitHub operations',
    async () => {
      const before = sha(fs.readFileSync(path.join(hostRoot, 'live.txt')));
      const projectsBefore = (await state(host)).projects.map((p) => p.id);
      await nav(host, 'Settings');
      await host.page.getByRole('button', { name: 'Open practice workspace', exact: true }).click();
      const demo = await until(
        () => state(host),
        (s) => s.simulation && !s.busy,
        'memory-only simulation opens',
      );
      assert.equal(demo.team.enabled, false);
      assert.equal(demo.team.port, 0);
      assert.ok(demo.current.path.startsWith('memory:'));
      const file = demo.current.files.find((f) => f.kind === 'text' && !f.deleted);
      await selectFile(host, file.path);
      const initial = (await state(host)).editor.text;
      await append(host, '\nSIMULATION-ONLY');
      assert.equal((await state(host)).editor.text, initial + '\nSIMULATION-ONLY');
      const blocked = await host.page.evaluate(async () => {
        try {
          await window.cairn.createTeam();
          return false;
        } catch (e) {
          return String(e).includes('SIMULATION');
        }
      });
      assert.equal(blocked, true);
      await nav(host, 'Settings');
      await host.page
        .locator('.settings-page')
        .getByRole('button', { name: 'Leave practice workspace', exact: true })
        .click();
      await until(
        () => state(host),
        (s) => !s.simulation,
        'simulation stops',
      );
      assert.equal(sha(fs.readFileSync(path.join(hostRoot, 'live.txt'))), before);
      assert.deepEqual(
        (await state(host)).projects.map((p) => p.id),
        projectsBefore,
      );
      await host.page.getByRole('button', { name: 'Open practice workspace', exact: true }).click();
      await until(
        () => state(host),
        (s) => s.simulation && !s.busy,
        'simulation resets',
      );
      await selectFile(host, file.path);
      assert.equal((await state(host)).editor.text, initial);
      await nav(host, 'Settings');
      await host.page
        .locator('.settings-page')
        .getByRole('button', { name: 'Leave practice workspace', exact: true })
        .click();
      await until(
        () => state(host),
        (s) => !s.simulation,
        'simulation clean exit',
      );
    },
  );
  assert.deepEqual(errors, [], 'no renderer exceptions or console errors');
  return {
    passed: true,
    packaged: Boolean(packaged),
    executable: packaged || 'development Electron',
    checks,
    errors,
    elapsedMs: Date.now() - started,
    evidence,
    environment: {
      browser: 'Browser plugin not available; explicit Electron Playwright harness',
      physicalDevices: false,
      physicalIME: false,
      mocked: ['native folder picker', 'native save picker'],
      githubWrites: false,
    },
  };
}

main()
  .then((result) => {
    fs.writeFileSync(path.join(evidence, 'release-results.json'), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        passed: true,
        checks: checks.length,
        elapsedMs: result.elapsedMs,
        evidence,
      }),
    );
  })
  .catch(async (error) => {
    process.exitCode = 1;
    try {
      if (currentWindow) await screenshot(currentWindow, 'failure.png');
    } catch {}
    const result = {
      passed: false,
      phase,
      checks,
      error: redact(error.message),
      errors,
      elapsedMs: Date.now() - started,
      evidence,
    };
    fs.writeFileSync(path.join(evidence, 'release-results.json'), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result, null, 2));
  })
  .finally(async () => {
    let allStopped = true;
    for (const app of [...applications].reverse()) {
      const child = childProcesses.get(app);
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      try {
        await bounded(app.close(), 5000, 'test app cleanup');
      } catch {
        allStopped = false;
      }
    }
    assert.equal(path.dirname(path.resolve(temporary)), parent);
    assert.ok(path.basename(temporary).startsWith('cairn-release-ui-'));
    if (allStopped) {
      try {
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        console.error('A temporary QA folder remained locked and was preserved.');
      }
    } else {
      process.exitCode = 1;
      console.error('A QA process did not stop; isolated fixture data was retained.');
    }
  });
