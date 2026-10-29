// Parameterized diagnostic for retained, owned release-UI fixtures. No credentials are printed.
const { _electron } = require('@playwright/test');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const project = path.resolve(__dirname, '..');
const profiles = process.argv.slice(2);
if (!profiles.length || profiles.length > 2)
  throw new Error('Pass owner profile and optional peer profile.');
for (const profile of profiles)
  if (!path.resolve(profile).startsWith(path.join(tmpdir(), 'cairn-release-ui-')))
    throw new Error('Only an owned release-UI fixture profile is accepted.');
async function instrument(app) {
  await app.evaluate((_electron, root) => {
    const req = process.getBuiltinModule('module').createRequire(root + '/package.json');
    const { ProjectReplica } = req(root + '/dist/core/project/replica.js');
    const { ProjectStore } = req(root + '/dist/core/project/store.js');
    const { DesktopController } = req(root + '/dist/electron/controller.js');
    const { TeamConnection } = req(root + '/dist/core/project/transport.js');
    const metrics = (globalThis.__restartDebug = {
      timing: {},
      blobs: { calls: 0, cached: 0, bytes: 0 },
      failures: [],
      history: [],
      firstReadyAt: null,
      firstConfirmedAt: null,
      lastState: null,
    });
    const timed = (type, label, names) => {
      for (const name of names) {
        const original = type.prototype[name];
        type.prototype[name] = function (...args) {
          const start = performance.now();
          try {
            return original.apply(this, args);
          } finally {
            const value = (metrics.timing[label + '.' + name] ??= { calls: 0, ms: 0, maxMs: 0 });
            const elapsed = performance.now() - start;
            value.calls++;
            value.ms += elapsed;
            value.maxMs = Math.max(value.maxMs, elapsed);
          }
        };
      }
    };
    timed(ProjectStore, 'store', ['metadata', 'status']);
    timed(ProjectReplica, 'replica', ['status', 'emitState']);
    timed(DesktopController, 'controller', ['state', 'publish', 'editor']);
    const download = ProjectReplica.prototype.downloadBlob;
    ProjectReplica.prototype.downloadBlob = function (hash, size, ...rest) {
      metrics.blobs.calls++;
      metrics.blobs.cached += this.store.hasBlob(hash) ? 1 : 0;
      metrics.blobs.bytes += size ?? 0;
      return download.call(this, hash, size, ...rest);
    };
    const originalState = DesktopController.prototype.state;
    DesktopController.prototype.state = function (...args) {
      const state = originalState.apply(this, args),
        replica = state.replica;
      const summary = {
        busy: state.busy,
        error: state.error?.code ?? null,
        connection: replica?.connection ?? null,
        stage: replica?.transfer.stage ?? null,
        revision: replica?.revision ?? null,
        pending: replica?.pending ?? null,
        rejected: replica?.rejected ?? null,
        confirmed: replica?.confirmedRevision ?? null,
        peers: state.team?.peers.length ?? 0,
      };
      const key = JSON.stringify(summary);
      if (key !== metrics.lastKey) {
        metrics.lastKey = key;
        metrics.history.push({ time: Date.now(), ...summary });
      }
      metrics.lastState = summary;
      const ready =
        state.current &&
        replica?.initialized &&
        replica.connection === 'online' &&
        !state.busy &&
        replica.pending === 0;
      if (ready && metrics.firstReadyAt === null) metrics.firstReadyAt = Date.now();
      if (
        ready &&
        replica.confirmedRevision === replica.revision &&
        metrics.firstConfirmedAt === null
      )
        metrics.firstConfirmedAt = Date.now();
      return state;
    };
    const fail = TeamConnection.prototype.fail;
    TeamConnection.prototype.fail = function (error) {
      metrics.failures.push({ code: error?.code ?? null, name: error?.name ?? null });
      return fail.call(this, error);
    };
  }, project);
}
async function measure(profile, label, applications) {
  const environment = { ...process.env, CAIRN_USER_DATA: path.resolve(profile) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const launchAt = Date.now();
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [project],
    cwd: project,
    env: environment,
    timeout: 25000,
  });
  applications.push(app);
  await instrument(app);
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.cairn);
  const windowAt = Date.now();
  await page.evaluate(() => window.cairn.state());
  let metrics;
  const deadline = windowAt + 20000;
  do {
    metrics = await app.evaluate(() => {
      const state = globalThis.__restartDebug;
      return {
        firstReadyAt: state.firstReadyAt,
        firstConfirmedAt: state.firstConfirmedAt,
        lastState: state.lastState,
        history: state.history,
        failures: state.failures,
        blobs: state.blobs,
        timing: state.timing,
      };
    });
    if (metrics.firstConfirmedAt !== null) break;
    await delay(50);
  } while (Date.now() < deadline);
  console.log(
    JSON.stringify({
      label,
      readyFromLaunchMs: metrics.firstReadyAt === null ? null : metrics.firstReadyAt - launchAt,
      confirmedFromLaunchMs:
        metrics.firstConfirmedAt === null ? null : metrics.firstConfirmedAt - launchAt,
      readyFromWindowMs: metrics.firstReadyAt === null ? null : metrics.firstReadyAt - windowAt,
      confirmedFromWindowMs:
        metrics.firstConfirmedAt === null ? null : metrics.firstConfirmedAt - windowAt,
      ...metrics,
      history: metrics.history.map(({ time, ...state }) => ({
        elapsedMs: time - launchAt,
        ...state,
      })),
    }),
  );
  if (metrics.firstConfirmedAt === null)
    throw new Error(label + ' did not confirm within 20 seconds of window readiness');
}
(async () => {
  const applications = [];
  try {
    for (let i = 0; i < profiles.length; i++)
      await measure(profiles[i], i === 0 ? 'owner' : 'peer', applications);
  } finally {
    for (const app of applications.reverse()) await app.close();
  }
})().catch((error) => {
  console.error(
    JSON.stringify({
      diagnosticFailure: error.code ?? error.name,
      message: String(error.message).slice(0, 300),
    }),
  );
  process.exitCode = 1;
});
