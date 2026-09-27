import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import Database from 'better-sqlite3'
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { createShadowGit, exportPR } from './core/git'
import type { ExportPRInput, PRExportResult, ShadowGit } from './core/git'
import { wrapIpcHandler } from './core/errors'
import { exportProjectSnapshot } from './core/snapshot/export'
import type { ExportSnapshotResult } from './core/snapshot/export'

import { createOplog } from './core/oplog'
import type { Oplog, Op } from './core/oplog'
import { ProjectWatcher } from './core/watcher'
import { Sync, type PeerInfo } from './core/sync'

interface ActiveProject {
  root: string
  oplog: Oplog
  watcher: ProjectWatcher
}

export interface LastSession {
  folder: string
  watching: boolean
  updatedAt: number
}

export interface AppSettings {
  autoStartWatching: boolean
  rememberLastFolder: boolean
}

let activeProject: ActiveProject | undefined
let activeShadow: ShadowGit | undefined
let activeRoom: { roomCode: string; sync: Sync } | undefined
let handlersRegistered = false
let isQuitting = false
let mainWindow: BrowserWindow | undefined

app.setName('Cairn')

function verifyNativeDatabase(): void {
  const database = new Database(':memory:')
  database.exec('SELECT 1')
  database.close()
  console.info('[cairn] better-sqlite3 in-memory database opened successfully')
}

/** 首次启动 Cairn 时复制旧版用户数据，失败不阻塞应用启动。 */
export async function migrateLegacyData(): Promise<void> {
  const newUserData = app.getPath('userData')
  const oldUserData = join(dirname(newUserData), 'VibeSwarm')
  if (!existsSync(oldUserData)) {
    return
  }
  if (existsSync(newUserData) && readdirSync(newUserData).length > 0) {
    return
  }

  try {
    await cp(oldUserData, newUserData, { recursive: true })
    console.info('[cairn] 已从 VibeSwarm 迁移用户数据')
  } catch (error) {
    console.error('[cairn] 数据迁移失败', error)
  }
}

function validateFolder(folder: string): void {
  if (typeof folder !== 'string') {
    throw new Error('项目路径必须是字符串')
  }

  if (!isAbsolute(folder)) {
    throw new Error(`项目路径必须是绝对路径：${folder}`)
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(folder)
  } catch {
    throw new Error(`项目路径不存在或无法访问：${folder}`)
  }

  if (!stats.isDirectory()) {
    throw new Error(`项目路径必须是目录：${folder}`)
  }
}

function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send(channel, payload)
}

export async function selectFolder(): Promise<string> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })

  const folder = result.canceled ? '' : (result.filePaths[0] ?? '')
  if (folder && (await getSettings()).rememberLastFolder) {
    const session = await readLastSession()
    await writeLastSession({ ...session, folder, updatedAt: Date.now() })
  }

  return folder
}

export async function stopWatching(preserveWatchState = false): Promise<void> {
  await leaveRoom()
  const project = activeProject
  if (!project) {
    return
  }

  activeProject = undefined
  activeShadow?.close()
  activeShadow = undefined
  try {
    await project.watcher.stop()
  } finally {
    project.oplog.close()
  }

  const session = await readLastSession()
  await writeLastSession({
    ...session,
    folder: project.root,
    updatedAt: Date.now(),
    watching: preserveWatchState,
  })
}

function lastSessionPath(): string {
  return join(app.getPath('userData'), 'last-session.json')
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

const defaultLastSession: LastSession = { folder: '', updatedAt: 0, watching: false }
const defaultSettings: AppSettings = { autoStartWatching: true, rememberLastFolder: true }

export async function readLastSession(): Promise<LastSession> {
  try {
    const raw = JSON.parse(await readFile(lastSessionPath(), 'utf8')) as Partial<LastSession>
    if (typeof raw.folder !== 'string' || typeof raw.watching !== 'boolean' || typeof raw.updatedAt !== 'number') {
      return defaultLastSession
    }
    return raw as LastSession
  } catch {
    return defaultLastSession
  }
}

export async function writeLastSession(session: LastSession): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(lastSessionPath(), JSON.stringify(session), 'utf8')
}

export async function clearLastSession(): Promise<void> {
  await writeLastSession({ ...defaultLastSession, updatedAt: Date.now() })
}

export async function checkFolder(folder: string): Promise<boolean> {
  if (!isAbsolute(folder)) {
    return false
  }

  try {
    return (await stat(folder)).isDirectory()
  } catch {
    return false
  }
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    return {
      autoStartWatching:
        typeof raw.autoStartWatching === 'boolean'
          ? raw.autoStartWatching
          : defaultSettings.autoStartWatching,
      rememberLastFolder:
        typeof raw.rememberLastFolder === 'boolean'
          ? raw.rememberLastFolder
          : defaultSettings.rememberLastFolder,
    }
  } catch {
    return defaultSettings
  }
}

export async function updateSettings(partial: Partial<AppSettings>): Promise<void> {
  const current = await getSettings()
  const next: AppSettings = {
    autoStartWatching:
      typeof partial.autoStartWatching === 'boolean'
        ? partial.autoStartWatching
        : current.autoStartWatching,
    rememberLastFolder:
      typeof partial.rememberLastFolder === 'boolean'
        ? partial.rememberLastFolder
        : current.rememberLastFolder,
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(next), 'utf8')
}

function githubConfigPath(): string {
  return join(app.getPath('userData'), 'github-config.json')
}

function githubTokenPath(): string {
  return join(app.getPath('userData'), 'github-token.bin')
}

export function validateGithubToken(token: string): void {
  const isAsciiVisible = /^[\x20-\x7E]+$/.test(token)
  const isClassicToken = /^ghp_[A-Za-z0-9]{36}$/.test(token)
  const isFineGrainedToken = /^github_pat_[A-Za-z0-9_]{82}$/.test(token)

  if (!isAsciiVisible || (!isClassicToken && !isFineGrainedToken)) {
    throw new Error('token 格式不正确，请重新从 GitHub 复制')
  }
}

export function validateGithubRepository(owner: string, repo: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('Owner 和 Repository 格式不正确')
  }
}

export async function saveGithubConfig(config: { token?: string; owner: string; repo: string }): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用')
  }

  const existing = await getGithubConfig()
  if ((!config.token && !existing.hasToken) || !config.owner || !config.repo) {
    throw new Error('GitHub token、Owner 和 Repository 不能为空')
  }

  validateGithubRepository(config.owner, config.repo)
  if (config.token) {
    validateGithubToken(config.token)
  }

  await mkdir(app.getPath('userData'), { recursive: true })
  if (config.token) {
    await writeFile(githubTokenPath(), safeStorage.encryptString(config.token))
  }

  await writeFile(githubConfigPath(), JSON.stringify({ owner: config.owner, repo: config.repo }), 'utf8')
}

export async function getGithubConfig(): Promise<{ owner: string; repo: string; hasToken: boolean }> {
  try {
    const config = JSON.parse(await readFile(githubConfigPath(), 'utf8')) as {
      owner: string
      repo: string
    }
    return { ...config, hasToken: existsSync(githubTokenPath()) }
  } catch {
    return { owner: '', repo: '', hasToken: false }
  }
}

export async function clearGithubConfig(): Promise<void> {
  await Promise.all([rm(githubConfigPath(), { force: true }), rm(githubTokenPath(), { force: true })])
}

export const resetGithubConfig = clearGithubConfig

export async function exportProjectPR(
  input: Omit<ExportPRInput, 'owner' | 'repo' | 'token'>,
): Promise<PRExportResult> {
  if (!activeShadow) {
    throw new Error('请先选择项目')
  }

  const config = await getGithubConfig()
  if (!config.hasToken) {
    throw new Error('请先配置 GitHub token')
  }

  const token = safeStorage.decryptString(await readFile(githubTokenPath()))
  validateGithubToken(token)
  validateGithubRepository(config.owner, config.repo)
  return exportPR(activeShadow, { ...input, owner: config.owner, repo: config.repo, token })
}

function formatSnapshotTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}`
}

/** 导出项目文本快照，并让用户决定最终 zip 保存位置。 */
export async function exportProjectSnapshotFile(): Promise<ExportSnapshotResult | { canceled: true }> {
  if (!activeProject) {
    throw new Error('请先选择项目')
  }

  const project = activeProject
  const temporary = await exportProjectSnapshot(project.root, {
    tempDirectory: app.getPath('temp'),
  })

  try {
    const result = await dialog.showSaveDialog({
      defaultPath: join(
        app.getPath('desktop'),
        `${basename(project.root)}-${formatSnapshotTimestamp(new Date())}.zip`,
      ),
      filters: [{ extensions: ['zip'], name: 'Zip Archive' }],
    })

    if (result.canceled || !result.filePath) {
      await rm(temporary.filePath, { force: true })
      return { canceled: true }
    }

    await rename(temporary.filePath, result.filePath)
    return { ...temporary, filePath: result.filePath }
  } catch (error) {
    await rm(temporary.filePath, { force: true })
    throw error
  }
}

/** 写入系统剪贴板，供受限渲染进程作为 navigator.clipboard 的后备方案。 */
export function copyToClipboard(text: string): void {
  if (typeof text !== 'string') {
    throw new Error('剪贴板内容必须是字符串')
  }
  clipboard.writeText(text)
}

function generateRoomCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let roomCode = ''
  for (let index = 0; index < 6; index += 1) {
    roomCode += alphabet[randomInt(alphabet.length)]
  }
  return roomCode
}

function validateRoomCode(roomCode: string): void {
  if (!/^[2-9A-HJ-NP-Z]{6}$/.test(roomCode)) {
    throw new Error(`房间码必须是 6 位大写字母或数字：${roomCode}`)
  }
}

function broadcastPeers(): void {
  sendToWindow('cairn:peers', listPeers())
}

function projectFilePath(projectRoot: string, relativePath: string): string {
  const root = resolve(projectRoot)
  const target = resolve(root, relativePath)
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`远端文件路径越界：${relativePath}`)
  }
  return target
}

async function startRoom(roomCode: string): Promise<void> {
  if (!activeProject) {
    throw new Error('请先选择并开始监控一个项目')
  }

  const project = activeProject
  const sync = new Sync(
    { oplog: project.oplog, roomCode },
    {},
    {
      applyRemoteChange: (relativePath, content) =>
        project.watcher.applyRemoteChange(relativePath, content),
      readFile: async (relativePath) => {
        try {
          return await readFile(projectFilePath(project.root, relativePath), 'utf8')
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return ''
          }
          throw error
        }
      },
      writeFile: async (relativePath, content) => {
        const targetPath = projectFilePath(project.root, relativePath)
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content, 'utf8')
      },
    },
  )
  sync.on('remoteOp', (op: Op) => { sendToWindow('cairn:op', op); void activeShadow?.commitOp(op, project.root).catch((error) => console.error(`[cairn:shadow] ${error.message}`)) })
  sync.on('conflict', (op: Op, localContent: string) =>
    sendToWindow('cairn:conflict', { op, localContent, source: 'remote' }),
  )
  sync.on('peerJoined', broadcastPeers)
  sync.on('peerLeft', broadcastPeers)
  sync.on('error', (error: Error) => console.error(`[cairn:sync] ${error.message}`))

  try {
    await sync.start()
    activeRoom = { roomCode, sync }
    broadcastPeers()
  } catch (error) {
    await sync.stop()
    throw error
  }
}

export async function createRoom(): Promise<string> {
  await leaveRoom()
  const roomCode = generateRoomCode()
  await startRoom(roomCode)
  return roomCode
}

export async function joinRoom(roomCode: string): Promise<void> {
  validateRoomCode(roomCode)
  await leaveRoom()
  await startRoom(roomCode)
}

export async function leaveRoom(): Promise<void> {
  const room = activeRoom
  if (!room) {
    return
  }

  activeRoom = undefined
  try {
    await room.sync.stop()
  } finally {
    broadcastPeers()
  }
}

export function listPeers(): PeerInfo[] {
  return activeRoom?.sync.listPeers() ?? []
}

export async function startWatching(folder: string): Promise<void> {
  validateFolder(folder)
  await stopWatching()

  const oplog = createOplog(folder)
  const watcher = new ProjectWatcher(folder, oplog)
  const shadow = createShadowGit(folder)

  watcher.on('op', (op) => {
    sendToWindow('cairn:op', op)
    activeRoom?.sync.announceLocalOp(op)
    void shadow.commitOp(op, folder).catch((error) => console.error(`[cairn:shadow] ${error.message}`))
  })
  watcher.on('error', (error) => {
    console.error(`[cairn:watcher] ${error.message}`)
  })

  try {
    await shadow.init()
    await watcher.start()
    activeProject = { root: folder, oplog, watcher }
    activeShadow = shadow
    await writeLastSession({ folder, updatedAt: Date.now(), watching: true })
  } catch (error) {
    await watcher.stop()
    oplog.close()
    shadow.close()
    throw error
  }
}

export async function listRecentOps(limit: number): Promise<Op[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`listRecentOps limit 必须是 1..200 的整数，收到 ${limit}`)
  }

  return activeProject ? activeProject.oplog.listRecent(limit) : []
}

export function registerIpcHandlers(): void {
  if (handlersRegistered) {
    return
  }

  handlersRegistered = true
  ipcMain.handle('cairn:selectFolder', wrapIpcHandler(selectFolder))
  ipcMain.handle('cairn:startWatching', wrapIpcHandler((folder: string) => startWatching(folder)))
  ipcMain.handle('cairn:stopWatching', wrapIpcHandler(() => stopWatching()))
  ipcMain.handle('cairn:listRecentOps', wrapIpcHandler((limit: number) => listRecentOps(limit)))
  ipcMain.handle('cairn:createRoom', wrapIpcHandler(createRoom))
  ipcMain.handle('cairn:joinRoom', wrapIpcHandler((roomCode: string) => joinRoom(roomCode)))
  ipcMain.handle('cairn:leaveRoom', wrapIpcHandler(leaveRoom))
  ipcMain.handle('cairn:listPeers', wrapIpcHandler(listPeers))
  ipcMain.handle('cairn:checkFolder', wrapIpcHandler((folder: string) => checkFolder(folder)))
  ipcMain.handle('cairn:getLastSession', wrapIpcHandler(readLastSession))
  ipcMain.handle('cairn:clearLastSession', wrapIpcHandler(clearLastSession))
  ipcMain.handle('cairn:getSettings', wrapIpcHandler(getSettings))
  ipcMain.handle('cairn:updateSettings', wrapIpcHandler((partial) => updateSettings(partial)))
  ipcMain.handle('cairn:saveGithubConfig', wrapIpcHandler((config) => saveGithubConfig(config)))
  ipcMain.handle('cairn:getGithubConfig', wrapIpcHandler(getGithubConfig))
  ipcMain.handle('cairn:clearGithubConfig', wrapIpcHandler(clearGithubConfig))
  ipcMain.handle('cairn:resetGithubConfig', wrapIpcHandler(resetGithubConfig))
  ipcMain.handle('cairn:exportPR', wrapIpcHandler((options) => exportProjectPR(options)))
  ipcMain.handle('cairn:exportSnapshot', wrapIpcHandler(exportProjectSnapshotFile))
  ipcMain.handle('cairn:copyToClipboard', wrapIpcHandler((text: string) => copyToClipboard(text)))
}

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow = window

  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  await migrateLegacyData()
  verifyNativeDatabase()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', (event) => {
  if (isQuitting) {
    return
  }

  event.preventDefault()
  void stopWatching(true).finally(() => {
    isQuitting = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
