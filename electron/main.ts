import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path'

import Database from 'better-sqlite3'
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import { createShadowGit, exportPR } from './core/git'
import type { ExportPRInput, PRExportResult, ShadowGit } from './core/git'
import { ConflictsManager } from './core/conflicts'
import type { ConflictRecord, ConflictResolution } from './core/conflicts'
import { BlobStore } from './core/blobs'
import { computeProjectIdentity } from './core/identity'
import type { ProjectIdentity } from './core/identity'
import { AppError, wrapIpcHandler } from './core/errors'
import { ProjectsManager } from './core/projects'
import type { ProjectEntry } from './core/projects'
import { exportProjectSnapshot } from './core/snapshot/export'
import type { ExportSnapshotResult } from './core/snapshot/export'
import { getCurrentDiscoveryStatus } from './core/sync/discovery'
import type { DiscoveryStatus } from './core/sync/discovery'

import { createOplog } from './core/oplog'
import type { Oplog, Op } from './core/oplog'
import { TrashManager } from './core/trash'
import type { TrashEntry } from './core/trash'
import { ProjectWatcher } from './core/watcher'
import { IGNORED_DIRECTORIES, isBinaryFile, isSensitiveFile } from './core/watcher/watcher'
import {
  SnapshotDownloader,
  SnapshotSeeder,
  Sync,
  type DownloadProgress,
  type DownloadResult,
  type PeerInfo,
  type SeederInfo,
  type SeederState,
} from './core/sync'

interface ActiveProject {
  root: string
  oplog: Oplog
  watcher: ProjectWatcher
  trash: TrashManager
  conflicts: ConflictsManager
}

export interface LastSession {
  folder: string
  watching: boolean
  updatedAt: number
}

export interface AppSettings {
  autoStartWatching: boolean
  rememberLastFolder: boolean
  trashRetentionDays: number
}

export interface OnboardingState {
  completed: boolean
  completedAt?: number
}

export interface ProjectFileEntry {
  path: string
  name: string
  size: number
  mtime: number
}

export interface ProjectFileContent {
  path: string
  content: string
  size: number
  mtime: number
}

let activeProject: ActiveProject | undefined
let activeShadow: ShadowGit | undefined
let activeRoom: { roomCode: string; sync: Sync } | undefined
let activeSeeder: SnapshotSeeder | undefined
let activeDownloader: SnapshotDownloader | undefined
let projectsManager: ProjectsManager | undefined
let handlersRegistered = false
let isQuitting = false
let mainWindow: BrowserWindow | undefined
// 串行化监控启动，避免开发模式初始化与用户操作并发创建多个 watcher。
let startWatchingPromise: Promise<void> | undefined

const MAX_WATCHED_FILES = 2_000
const MAX_PROJECT_FILES = 5_000
const MAX_PROJECT_FILE_BYTES = 1_024 * 1_024
const FILE_COUNT_IGNORED_DIRECTORIES = new Set([
  '.cairn', '.git', '.next', '.nuxt', '.turbo', '.vibeswarm', '.cache', '.vscode',
  'build', 'coverage', 'dist', 'node_modules', 'target',
])

app.setName('Cairn')

// 开发进程与正式安装版使用独立用户数据目录，便于本机双实例联调。
if (!app.isPackaged && typeof app.setPath === 'function') {
  app.setPath('userData', join(app.getPath('appData'), 'Cairn-Dev'))
}

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

/**
 * 验证 renderer 请求的相对文件路径，且拒绝通过符号链接逃逸项目根目录。
 * 文件浏览只读取已存在的普通文件，因此不存在的路径直接视为无效。
 */
async function safeActiveProjectFilePath(filePath: string): Promise<string> {
  const projectRoot = activeProject?.root
  if (!projectRoot) {
    throw new AppError('请先选择项目', 'config')
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new AppError('文件路径不能为空', 'config')
  }

  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    isAbsolute(normalized)
    || win32.isAbsolute(normalized)
    || normalized.startsWith('/')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new AppError('文件路径必须位于当前项目内', 'permission')
  }

  const root = await realpath(projectRoot)
  const candidate = resolve(root, ...segments)
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new AppError('文件路径必须位于当前项目内', 'permission')
  }

  const target = await realpath(candidate)
  if (!target.startsWith(`${root}${sep}`)) {
    throw new AppError('文件路径通过符号链接越出项目目录', 'permission')
  }
  const metadata = await lstat(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AppError('只能查看项目中的普通文件', 'config')
  }
  return candidate
}

/** 在启动监控前快速统计文件数，到达上限即停止遍历。 */
export async function countFiles(folder: string, limit: number): Promise<number> {
  let count = 0
  const stack = [folder]

  while (stack.length > 0 && count < limit) {
    const directory = stack.pop()
    if (!directory) continue

    try {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (FILE_COUNT_IGNORED_DIRECTORIES.has(entry.name)) continue
        if (entry.isDirectory()) {
          stack.push(join(directory, entry.name))
          continue
        }
        count += 1
        if (count >= limit) return count
      }
    } catch {
      // 单个不可读目录不应阻断其余项目文件的检查。
    }
  }

  return count
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

export async function stopWatching(preserveWatchState = false, waitForPendingStart = true): Promise<void> {
  // 启动尚未写入 activeProject 时，也要等待其完成后再停止。
  const pendingStart = startWatchingPromise
  if (pendingStart && waitForPendingStart) {
    try {
      await pendingStart
    } catch {
      // 启动失败时没有需要停止的活动项目。
    }
  }

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

function onboardingPath(): string {
  return join(app.getPath('userData'), 'onboarding.json')
}

function projectsPath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function getProjectsManager(): ProjectsManager {
  projectsManager ??= new ProjectsManager(projectsPath())
  return projectsManager
}

const defaultLastSession: LastSession = { folder: '', updatedAt: 0, watching: false }
const defaultSettings: AppSettings = { autoStartWatching: true, rememberLastFolder: true, trashRetentionDays: 30 }
const defaultOnboardingState: OnboardingState = { completed: false }

function normalizeTrashRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365
    ? value
    : defaultSettings.trashRetentionDays
}

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

/** 读取首次引导状态；文件缺失或损坏时视为尚未完成。 */
export async function readOnboarding(): Promise<OnboardingState> {
  try {
    const raw = JSON.parse(await readFile(onboardingPath(), 'utf8')) as Partial<OnboardingState>
    if (typeof raw.completed !== 'boolean') return defaultOnboardingState
    return typeof raw.completedAt === 'number'
      ? { completed: raw.completed, completedAt: raw.completedAt }
      : { completed: raw.completed }
  } catch {
    return defaultOnboardingState
  }
}

/** 持久化首次引导状态，写入完成前不会返回。 */
export async function writeOnboarding(data: OnboardingState): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(onboardingPath(), JSON.stringify(data), 'utf8')
}

export async function completeOnboarding(): Promise<void> {
  await writeOnboarding({ completed: true, completedAt: Date.now() })
}

export async function resetOnboarding(): Promise<void> {
  await writeOnboarding(defaultOnboardingState)
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

export async function listProjects(): Promise<Array<ProjectEntry & { available: boolean }>> {
  const manager = getProjectsManager()
  const projects = await manager.list()
  return Promise.all(projects.map(async (project) => ({
    ...project,
    available: await manager.checkAvailability(project.id),
  })))
}

export function addProject(projectPath: string): Promise<ProjectEntry> {
  return getProjectsManager().add(projectPath)
}

export function removeProject(id: string): Promise<void> {
  return getProjectsManager().remove(id)
}

export function setActiveProject(id: string): Promise<void> {
  return getProjectsManager().setActive(id)
}

export function getActiveProject(): Promise<ProjectEntry | undefined> {
  return getProjectsManager().getActive()
}

export function checkProjectAvailability(id: string): Promise<boolean> {
  return getProjectsManager().checkAvailability(id)
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
      trashRetentionDays: normalizeTrashRetentionDays(raw.trashRetentionDays),
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
    trashRetentionDays:
      partial.trashRetentionDays === undefined
        ? current.trashRetentionDays
        : normalizeTrashRetentionDays(partial.trashRetentionDays),
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

/** 仅允许从设置页打开明确的 HTTPS 外部链接。 */
export async function openExternal(url: string): Promise<void> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new AppError('外部链接格式不正确', 'config')
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new AppError('仅支持打开 HTTPS 链接', 'config')
  }
  await shell.openExternal(parsedUrl.toString())
}

/** 在系统文件管理器中打开目录，或定位到一个具体文件。 */
export async function openInFileManager(targetPath: string): Promise<void> {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new AppError('路径不能为空', 'config')
  }
  if (!existsSync(targetPath)) {
    throw new AppError(`路径不存在：${targetPath}`, 'notFound')
  }

  if (statSync(targetPath).isDirectory()) {
    const error = await shell.openPath(targetPath)
    if (error) {
      throw new AppError(error, 'unknown')
    }
    return
  }

  shell.showItemInFolder(targetPath)
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

async function startRoom(roomCode: string, discovery = true): Promise<void> {
  if (!activeProject) {
    throw new Error('请先选择并开始监控一个项目')
  }

  const project = activeProject
  const blobStore = new BlobStore(project.root)
  const identity = await computeProjectIdentity(project.root)
  const sync = new Sync(
    { blobStore, identity, oplog: project.oplog, projectRoot: project.root, roomCode },
    {},
    {
      applyRemoteChange: (relativePath, content, deleted, blobHash) =>
        project.watcher.applyRemoteChange(relativePath, content, deleted, blobHash),
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
      fileExists: async (relativePath) => existsSync(projectFilePath(project.root, relativePath)),
      writeFile: async (relativePath, content) => {
        const targetPath = projectFilePath(project.root, relativePath)
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content, 'utf8')
      },
      writeBinaryFile: async (relativePath, content) => {
        const targetPath = projectFilePath(project.root, relativePath)
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content)
      },
      moveRemoteDeletionToTrash: async (relativePath, author, opHash) => {
        const targetPath = projectFilePath(project.root, relativePath)
        if (existsSync(targetPath)) {
          await project.trash.moveToTrash(relativePath, targetPath, author, opHash)
        }
      },
    },
  )
  sync.on('remoteOp', (op: Op) => { sendToWindow('cairn:op', op); void activeShadow?.commitOp(op, project.root).catch((error) => console.error(`[cairn:shadow] ${error.message}`)) })
  sync.on('conflictRecord', (conflict: ConflictRecord) =>
    sendToWindow('cairn:conflict', conflict),
  )
  sync.on('peerJoined', broadcastPeers)
  sync.on('peerLeft', broadcastPeers)
  sync.on('identityMismatch', (info) => sendToWindow('cairn:identity-mismatch', info))
  sync.on('error', (error: Error) => console.error(`[cairn:sync] ${error.message}`))

  try {
    console.info(`[cairn:sync] sync.start called with roomCode ${roomCode}`)
    await sync.start({ discovery })
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
  console.info(`[cairn:sync] createRoom requested roomCode ${roomCode}`)
  await startRoom(roomCode)
  return roomCode
}

export async function joinRoom(roomCode: string): Promise<void> {
  validateRoomCode(roomCode)
  await leaveRoom()
  console.info(`[cairn:sync] joinRoom requested roomCode ${roomCode}`)
  await startRoom(roomCode)
}

export async function leaveRoom(): Promise<void> {
  const room = activeRoom
  if (!room) {
    return
  }

  activeDownloader?.cancel()
  activeDownloader = undefined
  activeSeeder?.stop()
  activeSeeder = undefined
  room.sync.registerDownloader(undefined)
  room.sync.registerSeeder(undefined)
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

export async function getProjectIdentity(): Promise<ProjectIdentity> {
  if (!activeProject) {
    throw new AppError('No active project', 'config')
  }
  return computeProjectIdentity(activeProject.root)
}

/** 返回可供局域网队友使用的本机 IPv4 与当前同步监听端口。 */
export function getLocalEndpoint(): { host: string; port: number } | undefined {
  const port = activeRoom?.sync.getLocalPort()
  if (!port) {
    return undefined
  }

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (name === 'lo' || name.startsWith('utun')) {
      continue
    }
    const address = addresses?.find((item) => item.family === 'IPv4' && !item.internal)
    if (address) {
      return { host: address.address, port }
    }
  }

  return undefined
}

/** 在没有 mDNS 发现结果时，直接建立到队友端点的 TCP 连接。 */
export async function connectToAddress(input: { host: string; port: number; roomCode: string }): Promise<void> {
  if (!activeProject) {
    throw new Error('请先选择并开始监控一个项目')
  }
  validateRoomCode(input.roomCode)

  if (!activeRoom) {
    // 直连会话仅启动 TCP 传输，不发布或浏览 mDNS 服务。
    await startRoom(input.roomCode, false)
  } else if (activeRoom.roomCode !== input.roomCode) {
    throw new Error('直连邀请码与当前房间不一致')
  }

  await activeRoom!.sync.connectToAddress(input.host, input.port, input.roomCode)
  broadcastPeers()
}

/** 暴露 mDNS 的只读诊断状态，便于定位发布或浏览失败。 */
export function getDiscoveryStatus(): DiscoveryStatus {
  return getCurrentDiscoveryStatus()
}

/** 开始向当前房间共享一次静态项目快照。 */
export async function startSharing(): Promise<SeederInfo> {
  if (!activeProject) {
    throw new Error('请先选择项目')
  }
  if (!activeRoom) {
    throw new Error('请先加入房间')
  }

  activeSeeder?.stop()
  activeRoom.sync.registerSeeder(undefined)
  const seeder = new SnapshotSeeder(activeProject.root, activeRoom.sync)
  activeSeeder = seeder
  activeRoom.sync.registerSeeder(seeder)
  try {
    const state = await seeder.start()
    return toSeederInfo(activeRoom.sync, state)
  } catch (error) {
    if (activeSeeder === seeder) {
      activeSeeder = undefined
      activeRoom.sync.registerSeeder(undefined)
    }
    throw error
  }
}

/** 停止共享当前项目快照。 */
export function stopSharing(): void {
  activeSeeder?.stop()
  activeSeeder = undefined
  activeRoom?.sync.registerSeeder(undefined)
}

/** 返回当前房间中已广播的项目快照。 */
export function listSeeders(): SeederInfo[] {
  return activeRoom?.sync.listSeeders() ?? []
}

/** 返回并确保用于接收队友项目的默认目录存在。 */
export async function getDefaultDownloadDir(): Promise<string> {
  const directory = join(app.getPath('home'), 'Cairn')
  await mkdir(directory, { recursive: true })
  return directory
}

/** 取消正在进行的项目下载；没有活动下载时保持幂等。 */
export function cancelDownload(): void {
  activeDownloader?.cancel()
}

/** 选择下载目标目录，不影响“上次项目文件夹”的会话数据。 */
export async function selectDownloadFolder(): Promise<string> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : (result.filePaths[0] ?? '')
}

/** 下载队友共享的项目快照，并将进度单向推送至渲染进程。 */
export async function downloadProject(input: { snapshotId: string; targetDir: string }): Promise<DownloadResult> {
  if (!activeRoom) {
    throw new Error('请先加入房间')
  }
  if (!input || typeof input.snapshotId !== 'string' || !input.snapshotId) {
    throw new Error('snapshotId 不能为空')
  }
  if (typeof input.targetDir !== 'string' || !isAbsolute(input.targetDir)) {
    throw new Error(`下载目标必须是绝对路径：${String(input?.targetDir)}`)
  }

  await mkdir(input.targetDir, { recursive: true })
  activeDownloader?.cancel()
  const room = activeRoom
  const downloader = new SnapshotDownloader(room.sync)
  activeDownloader = downloader
  room.sync.registerDownloader(downloader)
  try {
    return await downloader.startDownload(input.snapshotId, input.targetDir, (progress: DownloadProgress) => {
      sendToWindow('cairn:downloadProgress', progress)
    })
  } finally {
    if (activeDownloader === downloader) {
      activeDownloader = undefined
      room.sync.registerDownloader(undefined)
    }
  }
}

function toSeederInfo(sync: Sync, state: SeederState): SeederInfo {
  return {
    peerId: sync.getPeerId(),
    snapshotId: state.snapshotId,
    projectName: state.projectName,
    size: state.totalBytes,
  }
}

export async function startWatching(folder: string, fileLimit = MAX_WATCHED_FILES): Promise<void> {
  if (startWatchingPromise) {
    try {
      await startWatchingPromise
    } catch {
      // 上一次启动失败不应阻断新的用户请求。
    }
  }

  const currentPromise = (async () => {
    validateFolder(folder)
    const fileCount = await countFiles(folder, fileLimit)
    if (fileCount >= fileLimit) {
      throw new AppError(
        `该文件夹有超过 ${fileLimit} 个文件，Cairn 适合 1000 个文件以内的项目。请选择更小的文件夹。`,
        'config',
        { hint: 'hintChooseSmallerFolder' },
      )
    }
    // 严格模式的重复恢复会在第一个启动完成后到达这里，直接复用即可。
    if (activeProject?.root === folder) {
      const entry = await getProjectsManager().add(folder)
      await getProjectsManager().setActive(entry.id)
      return
    }

    // 当前启动任务已经登记在 startWatchingPromise，不能在这里等待自身完成。
    await stopWatching(false, false)

    const oplog = createOplog(folder)
    const trash = new TrashManager(folder)
    const conflicts = new ConflictsManager(folder)
    const watcher = new ProjectWatcher(folder, oplog, {}, trash)
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
      const cleaned = await trash.cleanup((await getSettings()).trashRetentionDays)
      if (cleaned > 0) {
        console.info(`[cairn:trash] 已自动清理 ${cleaned} 个过期条目`)
      }
      activeProject = { root: folder, oplog, watcher, trash, conflicts }
      activeShadow = shadow
      await writeLastSession({ folder, updatedAt: Date.now(), watching: true })
      // 项目索引失败不应撤销已成功启动的监控。
      try {
        const entry = await getProjectsManager().add(folder)
        await getProjectsManager().setActive(entry.id)
      } catch (error) {
        console.error('[cairn:projects] 记录最近项目失败', error)
      }
    } catch (error) {
      await watcher.stop()
      oplog.close()
      shadow.close()
      throw error
    }
  })()

  startWatchingPromise = currentPromise
  try {
    await currentPromise
  } finally {
    if (startWatchingPromise === currentPromise) {
      startWatchingPromise = undefined
    }
  }
}

export async function listRecentOps(limit: number): Promise<Op[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`listRecentOps limit 必须是 1..200 的整数，收到 ${limit}`)
  }

  return activeProject ? activeProject.oplog.listRecent(limit) : []
}

/** 列出当前项目中安全、可作为 UTF-8 文本预览的文件。 */
export async function listProjectFiles(): Promise<{ files: ProjectFileEntry[]; truncated: boolean }> {
  const projectRoot = activeProject?.root
  if (!projectRoot) {
    return { files: [], truncated: false }
  }

  const files: ProjectFileEntry[] = []
  const stack = ['']
  const binaryByExtension = new Map<string, boolean>()

  // 多读一条即可准确判断是否截断，避免把恰好 5000 个文件误报为截断。
  while (stack.length > 0 && files.length <= MAX_PROJECT_FILES) {
    const relativeDirectory = stack.pop()
    if (relativeDirectory === undefined) continue
    const absoluteDirectory = join(projectRoot, relativeDirectory)
    let entries
    try {
      entries = await readdir(absoluteDirectory, { encoding: 'utf8', withFileTypes: true })
    } catch (error) {
      console.warn(`[cairn:files] 无法读取目录 ${relativeDirectory || '.'}`, error)
      continue
    }

    for (const entry of entries) {
      if (files.length > MAX_PROJECT_FILES) break
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = join(projectRoot, relativePath)
      if (entry.isDirectory()) {
        stack.push(relativePath)
        continue
      }
      if (!entry.isFile() || isSensitiveFile(relativePath)) continue

      try {
        if (await isBinaryFile(absolutePath, relativePath, binaryByExtension)) continue
        const metadata = await stat(absolutePath)
        files.push({ name: entry.name, path: relativePath, size: metadata.size, mtime: metadata.mtimeMs })
      } catch (error) {
        console.warn(`[cairn:files] 跳过无法读取的文件 ${relativePath}`, error)
      }
    }
  }

  return {
    files: files.slice(0, MAX_PROJECT_FILES).sort((left, right) => left.path.localeCompare(right.path)),
    truncated: files.length > MAX_PROJECT_FILES,
  }
}

/** 以受限大小读取项目文件，内容只能由受信任主进程提供给 renderer。 */
export async function readProjectFile(filePath: string): Promise<ProjectFileContent> {
  const absolutePath = await safeActiveProjectFilePath(filePath)
  const metadata = await stat(absolutePath)
  if (metadata.size > MAX_PROJECT_FILE_BYTES) {
    throw new AppError('File too large to display', 'config', { code: 'FILE_TOO_LARGE' })
  }
  if (isSensitiveFile(filePath) || await isBinaryFile(absolutePath, filePath)) {
    throw new AppError('该文件不能在 Cairn 中显示', 'permission')
  }
  return {
    content: await readFile(absolutePath, 'utf8'),
    mtime: metadata.mtimeMs,
    path: filePath,
    size: metadata.size,
  }
}

/** 保存编辑器修改；后续操作日志由 watcher 按普通磁盘改动生成。 */
export async function saveProjectFile(
  filePath: string,
  content: string,
): Promise<{ saved: true; mtime: number }> {
  if (typeof content !== 'string') {
    throw new AppError('Invalid arguments', 'config')
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_BYTES) {
    throw new AppError('File too large to save (>1 MB)', 'config', { code: 'FILE_TOO_LARGE' })
  }

  const absolutePath = await safeActiveProjectFilePath(filePath)
  if (isSensitiveFile(filePath) || await isBinaryFile(absolutePath, filePath)) {
    throw new AppError('该文件不能在 Cairn 中保存', 'permission')
  }

  await writeFile(absolutePath, content, 'utf8')
  const metadata = await stat(absolutePath)
  return { saved: true, mtime: metadata.mtimeMs }
}

/** 返回当前项目中可恢复的已删除文件。 */
export async function listTrash(): Promise<TrashEntry[]> {
  // 未打开项目时，废纸篓视图应自然显示为空状态。
  return activeProject ? activeProject.trash.list() : []
}

/** 恢复后由 watcher 的 add 事件生成并广播恢复 op。 */
export async function restoreFromTrash(trashId: string): Promise<void> {
  // 视图卸载或切换项目期间的迟到请求不应产生错误提示。
  if (!activeProject) return
  if (typeof trashId !== 'string') throw new Error('废纸篓条目 ID 必须是字符串')
  await activeProject.trash.restore(trashId)
}

export async function purgeFromTrash(trashId: string): Promise<void> {
  // 没有活动项目时，清理操作是安全的空操作。
  if (!activeProject) return
  if (typeof trashId !== 'string') throw new Error('废纸篓条目 ID 必须是字符串')
  await activeProject.trash.purge(trashId)
}

export async function emptyTrash(): Promise<void> {
  const trash = activeProject?.trash
  if (!trash) return
  for (const entry of await trash.list()) {
    await trash.purge(entry.trashId)
  }
}

/** 未打开项目时返回空列表，方便冲突视图自然呈现空状态。 */
export async function listConflicts(): Promise<ConflictRecord[]> {
  return activeProject ? activeProject.conflicts.list() : []
}

export async function getConflict(opHash: string): Promise<ConflictRecord | undefined> {
  return activeProject?.conflicts.get(opHash)
}

export async function resolveConflict(
  opHash: string,
  resolution: ConflictResolution,
  content?: string,
): Promise<void> {
  if (!activeProject) return
  await activeProject.conflicts.resolve(opHash, resolution, content)
}

export async function deleteConflict(opHash: string): Promise<void> {
  if (!activeProject) return
  await activeProject.conflicts.delete(opHash)
}

export async function getTrashRetentionDays(): Promise<number> {
  return (await getSettings()).trashRetentionDays
}

export async function setTrashRetentionDays(days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`废纸篓保留天数必须是 1..365 的整数，收到 ${days}`)
  }
  await updateSettings({ trashRetentionDays: days })
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
  ipcMain.handle('cairn:listProjectFiles', wrapIpcHandler(listProjectFiles))
  ipcMain.handle('cairn:readProjectFile', wrapIpcHandler((filePath: string) => readProjectFile(filePath)))
  ipcMain.handle(
    'cairn:saveProjectFile',
    wrapIpcHandler((filePath: string, content: string) => saveProjectFile(filePath, content)),
  )
  ipcMain.handle('cairn:createRoom', wrapIpcHandler(createRoom))
  ipcMain.handle('cairn:joinRoom', wrapIpcHandler((roomCode: string) => joinRoom(roomCode)))
  ipcMain.handle('cairn:leaveRoom', wrapIpcHandler(leaveRoom))
  ipcMain.handle('cairn:listPeers', wrapIpcHandler(listPeers))
  ipcMain.handle('cairn:getProjectIdentity', wrapIpcHandler(getProjectIdentity))
  ipcMain.handle('cairn:getLocalEndpoint', wrapIpcHandler(getLocalEndpoint))
  ipcMain.handle('cairn:connectToAddress', wrapIpcHandler((input) => connectToAddress(input)))
  ipcMain.handle('cairn:getDiscoveryStatus', wrapIpcHandler(getDiscoveryStatus))
  ipcMain.handle('cairn:checkFolder', wrapIpcHandler((folder: string) => checkFolder(folder)))
  ipcMain.handle('cairn:listProjects', wrapIpcHandler(listProjects))
  ipcMain.handle('cairn:addProject', wrapIpcHandler((projectPath: string) => addProject(projectPath)))
  ipcMain.handle('cairn:removeProject', wrapIpcHandler((id: string) => removeProject(id)))
  ipcMain.handle('cairn:setActiveProject', wrapIpcHandler((id: string) => setActiveProject(id)))
  ipcMain.handle('cairn:getActiveProject', wrapIpcHandler(getActiveProject))
  ipcMain.handle('cairn:checkProjectAvailability', wrapIpcHandler((id: string) => checkProjectAvailability(id)))
  ipcMain.handle('cairn:getLastSession', wrapIpcHandler(readLastSession))
  ipcMain.handle('cairn:clearLastSession', wrapIpcHandler(clearLastSession))
  ipcMain.handle('cairn:getOnboardingState', wrapIpcHandler(readOnboarding))
  ipcMain.handle('cairn:completeOnboarding', wrapIpcHandler(completeOnboarding))
  ipcMain.handle('cairn:resetOnboarding', wrapIpcHandler(resetOnboarding))
  ipcMain.handle('cairn:getSettings', wrapIpcHandler(getSettings))
  ipcMain.handle('cairn:updateSettings', wrapIpcHandler((partial) => updateSettings(partial)))
  ipcMain.handle('cairn:saveGithubConfig', wrapIpcHandler((config) => saveGithubConfig(config)))
  ipcMain.handle('cairn:getGithubConfig', wrapIpcHandler(getGithubConfig))
  ipcMain.handle('cairn:clearGithubConfig', wrapIpcHandler(clearGithubConfig))
  ipcMain.handle('cairn:resetGithubConfig', wrapIpcHandler(resetGithubConfig))
  ipcMain.handle('cairn:exportPR', wrapIpcHandler((options) => exportProjectPR(options)))
  ipcMain.handle('cairn:exportSnapshot', wrapIpcHandler(exportProjectSnapshotFile))
  ipcMain.handle('cairn:copyToClipboard', wrapIpcHandler((text: string) => copyToClipboard(text)))
  ipcMain.handle('cairn:openExternal', wrapIpcHandler((url: string) => openExternal(url)))
  ipcMain.handle('cairn:openInFileManager', wrapIpcHandler((targetPath: string) => openInFileManager(targetPath)))
  ipcMain.handle('cairn:startSharing', wrapIpcHandler(startSharing))
  ipcMain.handle('cairn:stopSharing', wrapIpcHandler(stopSharing))
  ipcMain.handle('cairn:downloadProject', wrapIpcHandler((input) => downloadProject(input)))
  ipcMain.handle('cairn:listSeeders', wrapIpcHandler(listSeeders))
  ipcMain.handle('cairn:getDefaultDownloadDir', wrapIpcHandler(getDefaultDownloadDir))
  ipcMain.handle('cairn:cancelDownload', wrapIpcHandler(cancelDownload))
  ipcMain.handle('cairn:selectDownloadFolder', wrapIpcHandler(selectDownloadFolder))
  ipcMain.handle('cairn:listTrash', wrapIpcHandler(listTrash))
  ipcMain.handle('cairn:restoreFromTrash', wrapIpcHandler((trashId: string) => restoreFromTrash(trashId)))
  ipcMain.handle('cairn:purgeFromTrash', wrapIpcHandler((trashId: string) => purgeFromTrash(trashId)))
  ipcMain.handle('cairn:emptyTrash', wrapIpcHandler(emptyTrash))
  ipcMain.handle('cairn:listConflicts', wrapIpcHandler(listConflicts))
  ipcMain.handle('cairn:getConflict', wrapIpcHandler((opHash: string) => getConflict(opHash)))
  ipcMain.handle('cairn:resolveConflict', wrapIpcHandler((opHash: string, resolution: ConflictResolution, content?: string) => resolveConflict(opHash, resolution, content)))
  ipcMain.handle('cairn:deleteConflict', wrapIpcHandler((opHash: string) => deleteConflict(opHash)))
  ipcMain.handle('cairn:getTrashRetentionDays', wrapIpcHandler(getTrashRetentionDays))
  ipcMain.handle('cairn:setTrashRetentionDays', wrapIpcHandler((days: number) => setTrashRetentionDays(days)))
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
  projectsManager = new ProjectsManager(projectsPath())
  await projectsManager.migrateFromLastSession(lastSessionPath())
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
