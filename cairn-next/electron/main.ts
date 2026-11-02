import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CairnError, publicError } from '../core/common.js';
import { commandSchema, querySchema } from '../core/project/transport.js';
import { DesktopController } from './controller.js';
import { ProfileStore } from './preferences.js';
import type { CommandInput, StoreQuery } from '../shared/project.js';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(appDirectory, '../../web-dist');
const resourceDirectory = path.resolve(appDirectory, '../..');
if (process.env.CAIRN_USER_DATA) app.setPath('userData', path.resolve(process.env.CAIRN_USER_DATA));
// A GUI session is the only product runtime. No background/headless mode is shipped.
if (process.argv.some((v) => /^--(?:server|headless|daemon|host)(?:=|$)/.test(v))) app.exit(2);
if (!app.requestSingleInstanceLock()) app.exit(0);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cairn',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let window: BrowserWindow | null = null;
let controller: DesktopController | null = null;
let cleaned = false;
let quitting = false;
let startupStage = 'initializing';
const empty = z.undefined(),
  id = z.string().min(1).max(128),
  folder = z.string().min(1).max(4096),
  name = z.string().trim().min(1).max(60);
function validateSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame.url.startsWith('cairn://app/')
  )
    throw new CairnError('INVALID_CALLER', 'This request is not from the application window.');
}
function handle<T>(name: string, schema: z.ZodType<T>, action: (input: T) => unknown): void {
  ipcMain.handle(`cairn:${name}`, async (event, input) => {
    try {
      validateSender(event);
      return await action(schema.parse(input));
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? { code: 'INVALID_INPUT', message: 'Check the input format and length.' }
          : publicError(error);
      throw new Error(`[${detail.code}] ${detail.message}`);
    }
  });
}
function handlers(c: DesktopController): void {
  handle('state', empty, () => c.state());
  handle('choose-folder', empty, () => c.chooseFolder());
  handle('open-project', z.object({ path: folder }).strict(), (v) => c.openProject(v));
  handle('switch-project', id, (v) => c.switchProject(v));
  handle('locate-project', z.object({ id, path: folder }).strict(), (v) => c.locateProject(v));
  handle('remove-project', id, (v) => c.removeProject(v));
  handle('close-project', empty, () => c.closeProject());
  handle('select-file', id, (v) => c.selectFile(v));
  handle(
    'update',
    z
      .object({
        update: z.string().max(5592408),
        fileId: id,
        generation: z.number().int().positive(),
        clientId: id,
      })
      .strict(),
    (v) => c.update(v),
  );
  handle('awareness', z.string().max(90000), (v) => c.awareness(v));
  const command = z.unknown().transform((value, ctx) => {
    const parsed = commandSchema.safeParse({
      ...(value && typeof value === 'object' ? value : {}),
      opId: randomUUID(),
    });
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid command' });
      return z.NEVER;
    }
    const { opId, ...input } = parsed.data;
    return input as CommandInput;
  });
  handle(
    'command',
    z.object({ command, scope: z.object({ projectId: id, clientId: id }).strict() }).strict(),
    (v) => c.command(v.command, v.scope),
  );
  handle('query', querySchema, (v) => c.query(v as StoreQuery));
  handle('read-blob', z.string().regex(/^[a-f0-9]{64}$/), (v) => c.readBlob(v));
  handle('set-watching', z.boolean(), (v) => c.setWatching(v));
  handle('retry-projection', empty, () => c.retryProjection());
  handle('create-team', empty, () => c.createTeam());
  handle(
    'copy-invite',
    z
      .object({
        role: z.enum(['editor', 'viewer']),
        address: z.string().max(512).optional(),
        memberId: id.optional(),
      })
      .strict(),
    (v) => c.copyInvite(v),
  );
  handle(
    'join-team',
    z
      .object({
        invite: z.string().min(1).max(32768),
        directory: folder,
        name: name.optional(),
        address: z.string().max(512).optional(),
      })
      .strict(),
    (v) => c.joinTeam(v),
  );
  handle('cancel-join', empty, () => c.cancelJoin());
  handle('leave-team', empty, () => c.leaveTeam());
  handle('reconnect', empty, () => c.reconnect());
  handle('discover-teams', empty, () => c.discoverTeams());
  handle('revoke-member', id, (v) => c.revokeMember(v));
  handle(
    'save-preferences',
    z
      .object({
        locale: z.enum(['ko', 'en', 'zh-TW']).optional(),
        displayName: name.optional(),
        onboardingDone: z.boolean().optional(),
        source: z
          .object({
            kind: z.enum(['unknown', 'external', 'declared-ai', 'app']),
            tool: z.string().trim().min(1).max(120).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    (v) => c.savePreferences(v),
  );
  handle(
    'save-github',
    z
      .object({
        owner: z.string().max(39),
        repo: z.string().max(100),
        baseBranch: z.string().min(1).max(240),
        token: z.string().max(2048).optional(),
        clearToken: z.boolean().optional(),
      })
      .strict(),
    (v) => c.saveGitHub(v),
  );
  handle('preview-github', empty, () => c.previewGitHub());
  handle(
    'publish-github',
    z
      .object({
        previewId: id,
        selectedPaths: z.array(z.string().max(1024)).min(1).max(5000),
        title: z.string().trim().min(1).max(256),
        body: z.string().max(50000),
      })
      .strict(),
    (v) => c.publishGitHub(v),
  );
  handle('export-snapshot', empty, () => c.exportSnapshot());
  handle(
    'open-folder',
    z
      .object({ relativePath: z.string().min(1).max(1024).optional() })
      .strict()
      .optional(),
    (v) => c.openFolder(v),
  );
  handle('copy-text', z.string().max(1024 * 1024), (v) => c.copyText(v));
  handle('copy-diagnostics', empty, () => c.copyDiagnostics());
  handle('legal', empty, () => c.legal());
  handle('start-simulation', empty, () => c.startSimulation());
  handle('stop-simulation', empty, () => c.stopSimulation());
}
function show(): void {
  window?.show();
  window?.focus();
}
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await controller?.close();
  controller = null;
  app.quit();
}
app.on('before-quit', (event) => {
  if (!cleaned) {
    event.preventDefault();
    quitting = true;
    if (window && !window.isDestroyed()) window.close();
    else void cleanup();
  }
});
app.on('window-all-closed', () => {
  void cleanup();
});
app.on('activate', show);
app.on('second-instance', show);
void app
  .whenReady()
  .then(async () => {
    if (quitting || cleaned) return;
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ttf': 'font/ttf',
      '.woff2': 'font/woff2',
    };
    protocol.handle('cairn', async (request) => {
      try {
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.hostname !== 'app')
          return new Response('Not found', { status: 404 });
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html',
          resolved = path.resolve(webDirectory, relative);
        if (!resolved.startsWith(`${webDirectory}${path.sep}`))
          return new Response('Forbidden', { status: 403 });
        return new Response(new Uint8Array(await readFile(resolved)), {
          headers: {
            'Content-Type': mime[path.extname(resolved)] ?? 'application/octet-stream',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'",
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 960,
      minHeight: 680,
      title: 'Cairn Next',
      backgroundColor: '#f6f7f9',
      show: false,
      webPreferences: {
        preload: path.join(appDirectory, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (e) => e.preventDefault());
    window.webContents.on('will-attach-webview', (e) => e.preventDefault());
    window.webContents.on('will-prevent-unload', () => {
      quitting = false;
      void dialog.showMessageBox(window!, {
        type: 'warning',
        message: 'Some input has not been saved to this device yet.',
        detail: 'Retry local saving in the editor before closing. This window will stay open.',
      });
    });
    window.on('close', () => {
      quitting = true;
    });
    window.on('closed', () => {
      window = null;
      void cleanup();
    });
    window.once('ready-to-show', () => window?.show());
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { label: 'Cairn Next', submenu: [{ role: 'about' }, { role: 'quit' }] },
            { role: 'editMenu' },
            { role: 'windowMenu' },
          ])
        : null,
    );
    const profile = new ProfileStore(app.getPath('userData'), {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: async (value) => safeStorage.encryptStringAsync(value),
      decrypt: async (value) => (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
    });
    controller = new DesktopController(profile, {
      version: app.getVersion(),
      runtime: {
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
      },
      chooseFolder: async () => {
        const r = await dialog.showOpenDialog(window!, {
          properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      saveArchive: async (name) => {
        const r = await dialog.showSaveDialog(window!, {
          defaultPath: name,
          filters: [{ name: 'Project snapshot', extensions: ['zip'] }],
        });
        return r.canceled ? null : (r.filePath ?? null);
      },
      copy: (text) => clipboard.writeText(text),
      openPath: async (target) => {
        if (await shell.openPath(target))
          throw new CairnError(
            'OPEN_FOLDER_FAILED',
            'The operating system could not open this folder.',
          );
      },
      legal: async () => ({
        licenses: await readFile(path.join(resourceDirectory, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
        privacy: await readFile(path.join(resourceDirectory, 'docs/privacy.md'), 'utf8'),
      }),
    });
    controller.on('state', (state) => {
      if (window && !window.isDestroyed()) window.webContents.send('cairn:state', state);
    });
    controller.on('awareness', (update) => {
      if (window && !window.isDestroyed()) window.webContents.send('cairn:awareness', update);
    });
    handlers(controller);
    startupStage = 'loading-window';
    await window.loadURL('cairn://app/index.html');
    if (quitting || cleaned) return;
    startupStage = 'restoring-project';
    await controller.restore();
    startupStage = 'ready';
  })
  .catch((error: unknown) => {
    // Closing during initial navigation rejects loadURL before `closed` fires.
    // The normal cleanup path must finish; an error dialog would block that exit.
    if (quitting || cleaned) return;
    const failure = publicError(error);
    dialog.showErrorBox(
      'Cairn Next',
      `The app could not start. Check installation and access to the saved profile. Project data has been preserved.\n${startupStage}: ${failure.code}`,
    );
    app.exit(1);
  });
