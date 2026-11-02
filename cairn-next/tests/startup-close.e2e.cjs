/** Normal close during startup must never become a blocking startup-error dialog. */
const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const executable = process.env.CAIRN_TEST_EXECUTABLE || require('electron');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-startup-close-'));
const evidence = path.resolve(
  project,
  '../outputs/qa/rc-startup-close',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
fs.mkdirSync(evidence, { recursive: true });
const checks = [];
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 12000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
(async () => {
  for (const mode of ['immediate-window-close', 'legacy-rejection-close']) {
    const env = { ...process.env, CAIRN_USER_DATA: path.join(fixture, mode) };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      executablePath: executable,
      args: process.env.CAIRN_TEST_EXECUTABLE ? [] : [project],
      cwd: project,
      env,
      timeout: 20000,
    });
    const child = app.process();
    const page = await app.firstWindow();
    if (mode === 'legacy-rejection-close') {
      const root = path.join(fixture, 'legacy');
      fs.mkdirSync(path.join(root, '.cairn-next'), { recursive: true });
      fs.writeFileSync(path.join(root, '.cairn-next/server.sqlite'), 'preserve legacy marker');
      await page.waitForFunction(() => !!window.cairn);
      const code = await page.evaluate(async (root) => {
        try {
          await window.cairn.openProject({ path: root });
          return 'accepted';
        } catch (error) {
          return String(error.message).match(/\[([A-Z_]+)\]/)?.[1];
        }
      }, root);
      assert.equal(code, 'LEGACY_PROJECT');
    }
    const start = Date.now();
    await bounded(
      app.close(),
      'Normal startup close did not exit; owned app and fixture preserved',
    );
    assert.equal(child.exitCode, 0);
    checks.push({ mode, exitCode: child.exitCode, elapsedMs: Date.now() - start });
  }
  const result = {
    passed: true,
    executable: process.env.CAIRN_TEST_EXECUTABLE || 'development Electron',
    checks,
    fixture,
    evidence,
  };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch((error) => {
  process.exitCode = 1;
  fs.writeFileSync(
    path.join(evidence, 'result.json'),
    JSON.stringify({ passed: false, checks, error: error.message, fixture }, null, 2),
  );
  console.error(error.message);
});
