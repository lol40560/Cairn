/** Windows NSIS trial. Run explicitly with CAIRN_TEST_INSTALLER; optional
 * CAIRN_TEST_BASE_INSTALLER enables the genuine 0.1.0 -> RC legacy-preservation test.
 * No force-kill, recursive cleanup, manual registry edits, real account or GitHub write.
 * Fixtures remain outside the install directory for inspection, even after success. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron } = require('@playwright/test');
const Y = require('yjs');

const project = path.resolve(__dirname, '..');
const expectedVersion = require('../package.json').version;
const started = Date.now();
const steps = [];
const versions = [];
const artifacts = {};
const apps = [];
const nativeProcesses = [];
const sensitive = new Set();
let fixtureRoot,
  installDir,
  evidence,
  paths,
  phase = 'preflight',
  uiResult;
let legacyProtected, modernSaved, beforeUninstall;

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const value of sensitive) if (value) message = message.split(value).join('[redacted]');
  return message
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[redacted certificate]')
    .replace(/("(?:token|certificate|privateKey)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .slice(0, 3000);
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Timed out: ${label}; processes and fixture files were preserved`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(read, accepts, label, milliseconds = 25000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function step(name, run) {
  phase = name;
  const start = Date.now();
  await run();
  steps.push({ name, passed: true, elapsedMs: Date.now() - start });
  console.log(`PASS ${name}`);
}
function normalized(value) {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}
function inside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  return (
    !!relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}
function ownPath(target, allowRoot = false) {
  requireCondition(
    fixtureRoot &&
      (inside(fixtureRoot, target) ||
        (allowRoot && normalized(target) === normalized(fixtureRoot))),
    'A trial path escaped its freshly created fixture directory',
  );
  return path.resolve(target);
}
async function hashFile(filename) {
  const info = fs.lstatSync(filename);
  requireCondition(info.isFile() && !info.isSymbolicLink(), 'Hash target must be an ordinary file');
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return { sha256: digest.digest('hex'), bytes: info.size };
}
async function tree(root) {
  ownPath(root);
  requireCondition(fs.existsSync(root), 'Expected preserved fixture directory is absent');
  const files = {};
  let count = 0,
    bytes = 0;
  async function walk(directory, prefix) {
    const info = fs.lstatSync(directory);
    requireCondition(
      info.isDirectory() && !info.isSymbolicLink(),
      'Refusing to traverse a nonordinary fixture directory',
    );
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      requireCondition(++count <= 30000, 'Fixture inventory exceeds the bounded entry limit');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      ownPath(target);
      const stat = fs.lstatSync(target);
      requireCondition(!stat.isSymbolicLink(), 'Refusing a fixture link or junction');
      if (stat.isDirectory()) await walk(target, relative);
      else {
        requireCondition(stat.isFile(), 'Expected an ordinary fixture file');
        bytes += stat.size;
        requireCondition(
          bytes <= 2 * 1024 * 1024 * 1024,
          'Fixture inventory exceeds the bounded byte limit',
        );
        files[relative] = await hashFile(target);
      }
    }
  }
  await walk(root, '');
  return files;
}
function treeSummary(files) {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  return {
    files: entries.length,
    bytes: entries.reduce((total, [, file]) => total + file.bytes, 0),
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}
function unchanged(actual, expected, label) {
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter(
    (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
  );
  requireCondition(
    changed.length === 0,
    `${label} changed unexpectedly: ${changed.slice(0, 8).join(', ')}`,
  );
}
function executableFromCommand(value) {
  if (typeof value !== 'string') return null;
  const match =
    value.trim().match(/^"([^"]+\.exe)"/i) || value.trim().match(/^(.+?\.exe)(?:\s|$|,)/i);
  return match ? path.resolve(match[1]) : null;
}
async function captureProcess(
  executable,
  args,
  { label, timeout = 120000, env, verbatim = false, capture = false } = {},
) {
  // /D= is last and deliberately unquoted, as NSIS requires; argv0 itself remains quoted.
  const child = spawn(executable, args, {
    cwd: project,
    env: env ?? process.env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    ...(verbatim ? { argv0: `"${executable}"` } : {}),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  const record = { child, label, pid: child.pid, exited: false };
  nativeProcesses.push(record);
  let output = '',
    truncated = false;
  if (capture) {
    const collect = (chunk) => {
      if (output.length < 1024 * 1024) output += chunk.toString();
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  }
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => {
      record.exited = true;
      reject(new Error(`${label} could not start`));
    });
    child.once('exit', (code, signal) => {
      record.exited = true;
      resolve({ code, signal, output, truncated });
    });
  });
  try {
    return await bounded(completion, timeout, label);
  } catch (error) {
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    throw error;
  }
}
async function installations() {
  // Read-only inventory of both registry views. Never export values or modify keys.
  const script =
    "$ErrorActionPreference='Stop'; $result=@(); foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){ $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view); try{$root=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');if($null -ne $root){try{foreach($name in $root.GetSubKeyNames()){$item=$root.OpenSubKey($name);if($null -ne $item){try{$display=[string]$item.GetValue('DisplayName');if($display -match '^Cairn Next(?:$|\\s)'){$result+=@{display=$display;location=[string]$item.GetValue('InstallLocation');uninstall=[string]$item.GetValue('UninstallString');icon=[string]$item.GetValue('DisplayIcon');hive=[string]$hive;view=[string]$view}}}finally{$item.Dispose()}}}}finally{$root.Dispose()}}}finally{$base.Dispose()}}}; ConvertTo-Json -InputObject @($result) -Compress";
  const result = await captureProcess(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { label: 'read installed-product registry', timeout: 20000, capture: true },
  );
  requireCondition(
    result.code === 0 && !result.truncated,
    'Cannot safely inspect installed Cairn entries; trial aborted',
  );
  try {
    const rows = JSON.parse(result.output.trim() || '[]');
    requireCondition(Array.isArray(rows), 'Invalid registry inventory');
    return rows;
  } catch {
    throw new Error('Cannot parse installed-product inventory; trial aborted');
  }
}
function isOwnedRegistration(entry) {
  const location = entry.location ? path.resolve(entry.location) : null;
  const uninstall = executableFromCommand(entry.uninstall);
  const icon = executableFromCommand(entry.icon);
  if (location && normalized(location) !== normalized(installDir)) return false;
  if (uninstall && !inside(installDir, uninstall)) return false;
  if (icon && !inside(installDir, icon)) return false;
  return Boolean(location || uninstall || icon);
}
async function guardInstall(requirePresent = false) {
  const entries = await installations();
  requireCondition(
    entries.every(isOwnedRegistration),
    'An existing Cairn installation is outside this trial target. Aborted without installing or changing that installation',
  );
  if (requirePresent)
    requireCondition(
      entries.length > 0,
      'The isolated installed product has no verifiable uninstall registration',
    );
  return { matchingEntries: entries.length, onlyOwnedTarget: true };
}
async function install(installer, label) {
  ownPath(installDir);
  requireCondition(
    path.isAbsolute(installDir) && !/["\r\n]/.test(installDir),
    'NSIS target must be a safe absolute fixture path',
  );
  await guardInstall();
  const result = await captureProcess(installer, ['/S', '/currentuser', `/D=${installDir}`], {
    label,
    timeout: 180000,
    verbatim: true,
    // Any installer-launched child also inherits an isolated profile, never the
    // signed-in user's default application-data directory.
    env: { ...process.env, CAIRN_USER_DATA: paths.modernProfile },
  });
  requireCondition(
    result.code === 0,
    `${label} did not exit successfully (${result.code ?? result.signal ?? 'unknown'})`,
  );
  await until(
    async () => fs.existsSync(paths.executable) && fs.existsSync(paths.asar),
    Boolean,
    'installed app and archive appear',
  );
  await guardInstall(true);
  return hashFile(paths.asar);
}
async function launch(profile, label) {
  ownPath(profile);
  const env = { ...process.env, CAIRN_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: paths.executable,
    args: [],
    cwd: installDir,
    env,
    timeout: 30000,
  });
  // Cache the handle NOW. Playwright app.process() may throw after app.close().
  const child = app.process();
  const record = { app, child, label, closed: false };
  apps.push(record);
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.cairn);
  page.setDefaultTimeout(15000);
  const version = await app.evaluate(({ app }) => app.getVersion());
  versions.push({ phase: label, version });
  return { ...record, record, page, version };
}
async function normalClose(target) {
  const record = target.record ?? target;
  if (record.closed || record.child.exitCode !== null || record.child.signalCode !== null) {
    record.closed = true;
    return;
  }
  const exited = new Promise((resolve) => record.child.once('exit', resolve));
  await bounded(record.app.close(), 15000, `normal close: ${record.label}`);
  await bounded(exited, 15000, `process exit: ${record.label}`);
  record.closed = true;
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  requireCondition(port >= 1024, 'Expected a nonprivileged test port');
  return port;
}
function yjsAppend(snapshot, text) {
  const doc = new Y.Doc();
  doc.getText('content');
  try {
    Y.applyUpdate(doc, Buffer.from(snapshot.state, 'base64'));
    const vector = Y.encodeStateVector(doc);
    doc.getText('content').insert(doc.getText('content').length, text);
    return Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64');
  } finally {
    doc.destroy();
  }
}
async function protectedLegacy() {
  return {
    project: await tree(paths.legacyProject),
    workcopies: await tree(path.join(paths.legacyProfile, 'host-workcopies')),
    credential: await hashFile(path.join(paths.legacyProfile, 'private-session.encrypted')),
  };
}
async function verifyLegacy(label) {
  if (!legacyProtected) return;
  const current = await protectedLegacy();
  unchanged(current.project, legacyProtected.project, `${label}: legacy project`);
  unchanged(current.workcopies, legacyProtected.workcopies, `${label}: legacy workcopies`);
  assert.deepEqual(
    current.credential,
    legacyProtected.credential,
    `${label}: encrypted legacy session preserved`,
  );
}
async function releaseReady(target) {
  return until(
    () => target.page.evaluate(() => window.cairn.state()),
    (value) =>
      value.current &&
      value.replica?.initialized &&
      value.replica.connection === 'online' &&
      value.replica.pending === 0 &&
      value.replica.rejected === 0 &&
      value.replica.projections.every((p) => p.state === 'applied') &&
      value.team?.confirmedRevision === value.replica.revision,
    'modern saved project is confirmed',
  );
}
async function scopedCommand(target, input) {
  return target.page.evaluate(async (input) => {
    const state = await window.cairn.state();
    return window.cairn.command(input, {
      projectId: state.replica.projectId,
      clientId: state.replica.clientId,
    });
  }, input);
}
async function snapshotForUninstall() {
  const saved = {
    modernProject: await tree(paths.modernProject),
    modernProfile: await tree(paths.modernProfile),
  };
  if (legacyProtected) {
    saved.legacyProject = await tree(paths.legacyProject);
    saved.legacyProfile = await tree(paths.legacyProfile);
  }
  return saved;
}
function result(passed, error) {
  const preservation = beforeUninstall
    ? Object.fromEntries(
        Object.entries(beforeUninstall).map(([name, files]) => [name, treeSummary(files)]),
      )
    : undefined;
  return {
    passed,
    phase,
    expectedVersion,
    versions,
    artifacts,
    steps,
    elapsedMs: Date.now() - started,
    evidence,
    fixturePaths: paths,
    optionalLegacyUpgrade: legacyProtected
      ? 'Genuine 0.1.0 fixture created; completed steps identify upgrade verification'
      : 'not run unless CAIRN_TEST_BASE_INSTALLER is supplied',
    profileScope:
      'Isolated CAIRN_USER_DATA profiles outside the application directory; not a claim about real default OS user-data folders',
    profileCredential:
      'Modern synthetic credential saved only to local encrypted storage; no external authentication or GitHub request',
    preservation,
    ui: uiResult,
    error: error ? safeError(error) : undefined,
    activeNativeProcesses: nativeProcesses
      .filter((item) => !item.exited)
      .map((item) => ({ label: item.label, pid: item.pid })),
    activeAppProcesses: apps
      .filter(
        (item) => !item.closed && item.child.exitCode === null && item.child.signalCode === null,
      )
      .map((item) => ({ label: item.label, pid: item.child.pid })),
    cleanup:
      'No manual deletion or force-kill. Normal NSIS uninstall on success; no automatic rollback or cleanup after failure, and all remaining artifacts are retained.',
  };
}

async function main() {
  requireCondition(process.platform === 'win32', 'This installer trial only runs on Windows');
  requireCondition(
    process.env.CAIRN_TEST_INSTALLER,
    'Set CAIRN_TEST_INSTALLER to the candidate NSIS executable',
  );
  const candidate = path.resolve(process.env.CAIRN_TEST_INSTALLER);
  const base = process.env.CAIRN_TEST_BASE_INSTALLER
    ? path.resolve(process.env.CAIRN_TEST_BASE_INSTALLER)
    : null;
  for (const file of [candidate, base].filter(Boolean)) {
    requireCondition(/\.exe$/i.test(file), 'Installer must be an .exe');
    const info = fs.lstatSync(file);
    requireCondition(
      info.isFile() && !info.isSymbolicLink(),
      'Installer must be an existing ordinary file',
    );
  }
  const temporaryParent = fs.realpathSync.native(os.tmpdir());
  fixtureRoot = fs.mkdtempSync(path.join(temporaryParent, 'cairn-install-'));
  requireCondition(
    path.dirname(fixtureRoot) === temporaryParent &&
      path.basename(fixtureRoot).startsWith('cairn-install-'),
    'Invalid isolated fixture root',
  );
  installDir = path.join(fixtureRoot, 'app');
  const data = path.join(fixtureRoot, 'data');
  fs.mkdirSync(data);
  paths = {
    root: fixtureRoot,
    installDir,
    executable: path.join(installDir, 'Cairn Next.exe'),
    asar: path.join(installDir, 'resources', 'app.asar'),
    legacyProject: path.join(data, 'legacy-project'),
    legacyProfile: path.join(data, 'legacy-profile'),
    modernProject: path.join(data, 'modern-project'),
    modernProfile: path.join(data, 'modern-profile'),
  };
  for (const location of Object.values(paths)) ownPath(location, true);
  for (const location of [
    paths.legacyProject,
    paths.legacyProfile,
    paths.modernProject,
    paths.modernProfile,
  ]) {
    requireCondition(
      !inside(installDir, location),
      'Project and profile fixtures must remain outside the installation directory',
    );
    fs.mkdirSync(location);
  }
  evidence = path.resolve(
    project,
    '../outputs/qa/rc-install',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
  );
  fs.mkdirSync(evidence, { recursive: true });
  artifacts.candidateInstaller = { path: candidate, ...(await hashFile(candidate)) };
  if (base) artifacts.baseInstaller = { path: base, ...(await hashFile(base)) };

  await step(
    'Refuse any existing nontrial Cairn uninstall registration before the first install',
    async () => {
      await guardInstall();
    },
  );

  if (base) {
    await step(
      'Install genuine 0.1.0 and persist legacy text plus encrypted reconnect record',
      async () => {
        artifacts.baseAppAsar = await install(base, 'base NSIS installation');
        fs.writeFileSync(path.join(paths.legacyProject, 'legacy.txt'), 'legacy seed\n', {
          flag: 'wx',
        });
        const old = await launch(paths.legacyProfile, 'legacy 0.1.0');
        assert.equal(old.version, '0.1.0');
        await old.page.evaluate((input) => window.cairn.startHost(input), {
          root: paths.legacyProject,
          fileName: 'legacy.txt',
          name: 'Installer legacy fixture',
          port: await availablePort(),
          displayName: 'Installer fixture',
        });
        let saved = await until(
          () => old.page.evaluate(() => window.cairn.state()),
          (value) => value.client?.initialized && value.client.connection === 'online',
          'legacy authenticated owner client',
        );
        const update = yjsAppend(saved.client, 'saved before upgrade\n');
        await old.page.evaluate((input) => window.cairn.update(input), {
          update,
          fileId: saved.client.fileId,
          generation: saved.client.generation,
          clientId: saved.client.clientId,
        });
        saved = await until(
          () => old.page.evaluate(() => window.cairn.state()),
          (value) =>
            value.client?.pending === 0 &&
            value.client.text === 'legacy seed\nsaved before upgrade\n' &&
            value.host?.confirmedRevision === value.host?.revision &&
            value.host?.projection === 'applied',
          'legacy edit and authority projection durable',
        );
        requireCondition(
          fs.existsSync(path.join(paths.legacyProfile, 'private-session.encrypted')),
          'Legacy OS-encrypted reconnect record was not written',
        );
        await normalClose(old);
        legacyProtected = await protectedLegacy();
        assert.equal(
          fs.readFileSync(path.join(paths.legacyProject, 'legacy.txt'), 'utf8'),
          'legacy seed\nsaved before upgrade\n',
        );
        artifacts.legacyEncryptedSession = legacyProtected.credential;
      },
    );
  }

  await step(
    base
      ? 'Upgrade same target to RC and reject legacy open without modifying protected data'
      : 'Install RC in an isolated target and verify product version',
    async () => {
      artifacts.candidateAppAsar = await install(
        candidate,
        base ? 'RC NSIS upgrade' : 'RC NSIS installation',
      );
      artifacts.candidateExecutable = await hashFile(paths.executable);
      artifacts.blockedServerModes = [];
      for (const flag of ['--headless', '--server', '--daemon', '--host']) {
        const probeEnv = { ...process.env, CAIRN_USER_DATA: paths.modernProfile };
        delete probeEnv.ELECTRON_RUN_AS_NODE;
        const blocked = await captureProcess(paths.executable, [flag], {
          label: `reject unsupported mode ${flag}`,
          timeout: 15000,
          env: probeEnv,
        });
        assert.equal(blocked.code, 2, 'Packaged server/headless mode must not run');
        artifacts.blockedServerModes.push({ flag, exitCode: blocked.code });
      }
      const candidateApp = await launch(
        base ? paths.legacyProfile : paths.modernProfile,
        'candidate version and compatibility',
      );
      assert.equal(candidateApp.version, expectedVersion);
      if (base) {
        const denied = await candidateApp.page.evaluate(async (root) => {
          try {
            await window.cairn.openProject({ path: root });
            return { rejected: false };
          } catch (error) {
            return { rejected: true, code: String(error?.message).match(/\[([A-Z_]+)\]/)?.[1] };
          }
        }, paths.legacyProject);
        assert.deepEqual(denied, { rejected: true, code: 'LEGACY_PROJECT' });
        await normalClose(candidateApp);
        await verifyLegacy('after upgrade rejection');
      } else await normalClose(candidateApp);
    },
  );

  await step(
    'Persist modern Yjs edit, checkpoint and locally encrypted synthetic credential with scoped ReleaseApi',
    async () => {
      fs.writeFileSync(path.join(paths.modernProject, 'modern.txt'), 'modern seed\n', {
        flag: 'wx',
      });
      const modern = await launch(paths.modernProfile, 'modern project creation');
      assert.equal(modern.version, expectedVersion);
      await modern.page.evaluate(() =>
        window.cairn.savePreferences({
          locale: 'en',
          onboardingDone: true,
          displayName: 'Installer fixture',
        }),
      );
      await modern.page.evaluate(
        (root) => window.cairn.openProject({ path: root }),
        paths.modernProject,
      );
      let current = await releaseReady(modern);
      const file = current.current.files.find((file) => file.path === 'modern.txt');
      requireCondition(file?.kind === 'text', 'Modern text fixture missing from catalog');
      const editor = await modern.page.evaluate((id) => window.cairn.selectFile(id), file.id);
      requireCondition(editor, 'Modern editor state missing');
      await modern.page.evaluate((input) => window.cairn.update(input), {
        update: yjsAppend(editor, 'saved before repair\n'),
        fileId: editor.fileId,
        generation: editor.generation,
        clientId: editor.clientId,
      });
      current = await releaseReady(modern);
      const checkpoint = await scopedCommand(modern, {
        kind: 'checkpoint-create',
        name: 'Installer preservation checkpoint',
      });
      requireCondition(
        typeof checkpoint.result?.checkpointId === 'string',
        'Checkpoint save did not return an identity',
      );
      const synthetic = `installer-fixture-${randomBytes(24).toString('hex')}`;
      sensitive.add(synthetic);
      // Saving settings is local only. This never calls preview/publish or an external service.
      await modern.page.evaluate(
        (token) =>
          window.cairn.saveGitHub({
            owner: 'fixture',
            repo: 'installer-preservation',
            baseBranch: 'main',
            token,
          }),
        synthetic,
      );
      current = await releaseReady(modern);
      requireCondition(current.gitHub.hasToken, 'Synthetic encrypted credential was not retained');
      modernSaved = {
        projectId: current.current.projectId,
        recentId: current.current.id,
        fileId: file.id,
        checkpointId: checkpoint.result.checkpointId,
        text: 'modern seed\nsaved before repair\n',
        hash: createHash('sha256').update('modern seed\nsaved before repair\n').digest('hex'),
      };
      await normalClose(modern);
      assert.equal(
        fs.readFileSync(path.join(paths.modernProject, 'modern.txt'), 'utf8'),
        modernSaved.text,
      );
      artifacts.modernEncryptedCredential = await hashFile(
        path.join(paths.modernProfile, 'secrets.encrypted'),
      );
    },
  );

  await step(
    'Run the full existing release UI harness against the actually installed executable',
    async () => {
      const ui = await captureProcess(
        process.execPath,
        [path.join(project, 'tests', 'release.e2e.cjs')],
        {
          label: 'installed release UI harness',
          timeout: 600000,
          capture: true,
          env: { ...process.env, CAIRN_TEST_EXECUTABLE: paths.executable },
        },
      );
      const summaries = ui.output
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((value) => value && typeof value.passed === 'boolean' && value.evidence);
      const summary = summaries.at(-1);
      uiResult = summary
        ? {
            passed: summary.passed,
            checks: Array.isArray(summary.checks) ? summary.checks.length : summary.checks,
            evidence: summary.evidence,
            exitCode: ui.code,
          }
        : {
            passed: false,
            exitCode: ui.code,
            report:
              'Inspect the timestamped rc-packaged UI evidence; no raw child output is copied here',
          };
      requireCondition(
        ui.code === 0 && !ui.truncated && uiResult.passed && uiResult.checks >= 10,
        'Installed release UI harness did not complete all 10 stages; installation and fixtures remain for review',
      );
      const startup = await captureProcess(
        process.execPath,
        [path.join(project, 'tests/startup-close.e2e.cjs')],
        {
          label: 'installed startup-close regressions',
          timeout: 120000,
          capture: true,
          env: { ...process.env, CAIRN_TEST_EXECUTABLE: paths.executable },
        },
      );
      requireCondition(startup.code === 0, 'Installed startup-close regressions did not pass');
      const startupSummary = startup.output
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((value) => value?.passed === true && value?.evidence);
      requireCondition(startupSummary, 'Missing installed startup-close evidence');
      uiResult.startupClose = startupSummary;
    },
  );

  await step(
    'Same-version repair preserves closed project/profile bytes, then restored content and checkpoint reopen',
    async () => {
      const closedProject = await tree(paths.modernProject),
        closedProfile = await tree(paths.modernProfile);
      artifacts.repairedAppAsar = await install(candidate, 'same-version NSIS repair');
      assert.deepEqual(
        artifacts.repairedAppAsar,
        artifacts.candidateAppAsar,
        'Repair installs the identical candidate archive',
      );
      unchanged(await tree(paths.modernProject), closedProject, 'repair: closed modern project');
      unchanged(await tree(paths.modernProfile), closedProfile, 'repair: closed isolated profile');
      await verifyLegacy('after repair');
      const modern = await launch(paths.modernProfile, 'modern project after repair');
      assert.equal(modern.version, expectedVersion);
      const current = await releaseReady(modern);
      assert.equal(current.current.path, paths.modernProject);
      assert.equal(current.current.projectId, modernSaved.projectId);
      assert.equal(current.current.id, modernSaved.recentId);
      const file = current.current.files.find((file) => file.id === modernSaved.fileId);
      assert.equal(file?.hash, modernSaved.hash);
      requireCondition(
        current.replica.metadata.checkpoints.some(
          (checkpoint) =>
            checkpoint.id === modernSaved.checkpointId &&
            checkpoint.name === 'Installer preservation checkpoint',
        ),
        'Checkpoint did not survive repair',
      );
      requireCondition(current.gitHub.hasToken, 'Encrypted credential did not reopen after repair');
      assert.equal(
        fs.readFileSync(path.join(paths.modernProject, 'modern.txt'), 'utf8'),
        modernSaved.text,
      );
      await normalClose(modern);
      beforeUninstall = await snapshotForUninstall();
      artifacts.modernEncryptedCredentialBeforeUninstall = await hashFile(
        path.join(paths.modernProfile, 'secrets.encrypted'),
      );
    },
  );

  await step(
    'Normal isolated uninstall removes executable and preserves all closed profile/project/credential bytes',
    async () => {
      await guardInstall(true);
      const uninstallers = fs
        .readdirSync(installDir)
        .filter((name) => /^Uninstall Cairn Next\.exe$/i.test(name));
      requireCondition(
        uninstallers.length === 1,
        'Expected exactly one product uninstaller in the owned target',
      );
      const uninstaller = ownPath(path.join(installDir, uninstallers[0]));
      requireCondition(
        inside(installDir, uninstaller),
        'Uninstaller must be inside the owned installation',
      );
      const info = fs.lstatSync(uninstaller);
      requireCondition(
        info.isFile() && !info.isSymbolicLink(),
        'Uninstaller must be an ordinary file',
      );
      const registration = await installations();
      requireCondition(
        registration.some((entry) => {
          const command = executableFromCommand(entry.uninstall);
          return command && normalized(command) === normalized(uninstaller);
        }),
        'Installed registration does not name this exact uninstaller',
      );
      const removal = await captureProcess(uninstaller, ['/S', '/currentuser'], {
        label: 'normal NSIS uninstall',
        timeout: 180000,
        env: { ...process.env, CAIRN_USER_DATA: paths.modernProfile },
      });
      requireCondition(removal.code === 0, 'Normal uninstaller did not finish successfully');
      await until(
        async () => !fs.existsSync(paths.executable) && (await installations()).length === 0,
        Boolean,
        'owned executable and uninstall registration removed',
        90000,
      );
      const after = await snapshotForUninstall();
      for (const [name, files] of Object.entries(beforeUninstall))
        unchanged(after[name], files, `uninstall: ${name}`);
      await verifyLegacy('after uninstall');
      assert.deepEqual(
        await hashFile(path.join(paths.modernProfile, 'secrets.encrypted')),
        artifacts.modernEncryptedCredentialBeforeUninstall,
      );
    },
  );
  return result(true);
}

main()
  .then((value) => {
    fs.writeFileSync(path.join(evidence, 'install-results.json'), JSON.stringify(value, null, 2));
    console.log(JSON.stringify({ passed: true, steps: steps.length, evidence, fixtureRoot }));
  })
  .catch(async (error) => {
    process.exitCode = 1;
    // Failure keeps the installation and fixture files. Only known app handles get a
    // bounded normal-close attempt; no process is killed and no uninstaller is run here.
    for (const target of [...apps].reverse()) {
      try {
        await normalClose(target);
      } catch {}
    }
    const value = result(false, error);
    if (evidence)
      fs.writeFileSync(path.join(evidence, 'install-results.json'), JSON.stringify(value, null, 2));
    console.error(JSON.stringify(value, null, 2));
  });
