import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { userInfo } from 'node:os'

import chokidar, { type FSWatcher } from 'chokidar'
import { createTwoFilesPatch } from 'diff'

import { computeHash, type NewOp, type Oplog, type Op } from '../oplog'
import { TrashManager } from '../trash'
import { writeSnapshot } from './snapshot'

export interface ProjectWatcherOptions {
  debounceMs?: number
  author?: string
}

interface BaselineEntry {
  content: string
  snapshotHash: string
}

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.vibeswarm',
  '.cairn',
  'node_modules',
  'dist',
  'build',
])
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css', '.scss', '.yml', '.yaml', '.toml', '.xml', '.svg', '.vue', '.svelte', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.sh', '.sql'])
const BINARY_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite'])

/** 不同步常见密钥与凭据；.env.example 仍可作为团队模板共享。 */
export function isSensitiveFile(relativePath: string): boolean {
  const fileName = basename(relativePath).toLowerCase()
  return fileName === '.env'
    || (fileName.startsWith('.env.') && fileName !== '.env.example')
    || fileName.endsWith('.pem')
    || fileName.endsWith('.key')
    || fileName === 'id_rsa'
    || fileName === 'id_ed25519'
    || fileName === '.npmrc'
    || fileName === '.netrc'
    || fileName === 'credentials.json'
}

/** 以扩展名优先、NUL 字节兜底的方式判断文件是否为 binary。 */
export async function isBinaryFile(
  absolutePath: string,
  relativePath: string,
  binaryByExtension: Map<string, boolean> = new Map(),
): Promise<boolean> {
  const extension = extname(relativePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(extension)) return false
  if (BINARY_EXTENSIONS.has(extension)) return true
  const cached = binaryByExtension.get(extension)
  if (cached !== undefined) return cached
  try {
    const sample = (await readFile(absolutePath)).subarray(0, 8000)
    const binary = sample.includes(0)
    binaryByExtension.set(extension, binary)
    return binary
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export class ProjectWatcher extends EventEmitter {
  private readonly author: string
  private readonly baseline = new Map<string, BaselineEntry>()
  private readonly binaryByExtension = new Map<string, boolean>()
  private readonly debounceMs: number
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly fileQueues = new Map<string, Promise<void>>()
  private readonly oplog: Oplog
  private readonly projectRoot: string
  private readonly trash: TrashManager
  private activeRun = 0
  private initializing = false
  private readyResolver: (() => void) | undefined
  private startPromise: Promise<void> | undefined
  private watcher: FSWatcher | undefined

  constructor(
    projectRoot: string,
    oplog: Oplog,
    options: ProjectWatcherOptions = {},
    trash: TrashManager = new TrashManager(projectRoot),
  ) {
    super()
    this.projectRoot = projectRoot
    this.oplog = oplog
    this.debounceMs = options.debounceMs ?? 300
    this.author = options.author ?? userInfo().username
    this.trash = trash
  }

  on(event: 'op', listener: (op: Op) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as Parameters<EventEmitter['on']>[1])
  }

  async start(): Promise<void> {
    if (this.watcher) {
      return this.startPromise ?? Promise.resolve()
    }

    const run = ++this.activeRun
    this.baseline.clear()
    this.initializing = true

    const watcher = chokidar.watch(this.projectRoot, {
      ignoreInitial: false,
      ignored: (path) => this.isIgnoredPath(path),
      persistent: true,
    })
    this.watcher = watcher

    const initialTasks = new Set<Promise<void>>()
    const enqueueInitial = (absolutePath: string): void => {
      const task = this.enqueue(absolutePath, async () => {
        await this.captureBaseline(absolutePath, run)
      })
      initialTasks.add(task)
      void task.finally(() => initialTasks.delete(task))
    }

    watcher.on('add', (absolutePath) => {
      if (this.initializing) {
        enqueueInitial(absolutePath)
        return
      }
      this.schedule(absolutePath, run)
    })
    watcher.on('change', (absolutePath) => {
      if (this.initializing) {
        enqueueInitial(absolutePath)
        return
      }
      this.schedule(absolutePath, run)
    })
    watcher.on('unlink', (absolutePath) => {
      if (!this.initializing) {
        this.schedule(absolutePath, run)
      }
    })
    watcher.on('error', (error) =>
      this.reportError(this.toError('chokidar 监听错误', error)),
    )

    this.startPromise = new Promise((resolve) => {
      this.readyResolver = resolve
      watcher.once('ready', () => {
        if (!this.isActive(watcher, run)) {
          return
        }
        this.initializing = false
        void Promise.allSettled([...initialTasks]).then(() => {
          if (this.isActive(watcher, run)) {
            console.info(`[cairn:watcher] 已开始监控 ${this.projectRoot}`)
          }
          if (this.readyResolver === resolve) {
            this.readyResolver = undefined
          }
          resolve()
        })
      })
    })

    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async stop(): Promise<void> {
    const watcher = this.watcher
    ++this.activeRun
    this.initializing = false

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.fileQueues.clear()

    if (!watcher) {
      return
    }

    this.watcher = undefined
    this.readyResolver?.()
    this.readyResolver = undefined
    await watcher.close()
    console.info(`[cairn:watcher] 已停止监控 ${this.projectRoot}`)
  }

  async applyRemoteChange(relativePath: string, content: string, deleted = false): Promise<void> {
    const normalizedPath = this.assertSafeRelativePath(relativePath)
    const snapshotHash = writeSnapshot(this.projectRoot, normalizedPath, content)
    if (deleted) {
      this.baseline.delete(normalizedPath)
      return
    }
    this.baseline.set(normalizedPath, { content, snapshotHash })
  }

  private async captureBaseline(absolutePath: string, run: number): Promise<void> {
    try {
      const relativePath = this.toRelativePath(absolutePath)
      if (!await this.isSafeExistingPath(absolutePath)) {
        console.warn(`[cairn:watcher] 跳过指向项目外的符号链接：${relativePath}`)
        return
      }
      if (await this.isBinaryFile(absolutePath, relativePath)) return
      const content = await readFile(absolutePath, 'utf8')
      const snapshotHash = writeSnapshot(this.projectRoot, relativePath, content)

      if (this.isRunActive(run)) {
        this.baseline.set(relativePath, { content, snapshotHash })
      }
    } catch (error) {
      if (this.isMissingFile(error)) {
        return
      }
      this.reportError(this.toError('建立初始快照失败', error))
    }
  }

  private enqueue(
    absolutePath: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    let relativePath: string
    try {
      relativePath = this.toRelativePath(absolutePath)
    } catch (error) {
      this.reportError(this.toError('文件路径非法', error))
      return Promise.resolve()
    }

    const previous = this.fileQueues.get(relativePath) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error: unknown) => {
        this.reportError(this.toError('处理文件变更失败', error))
      })

    this.fileQueues.set(relativePath, current)
    void current.finally(() => {
      if (this.fileQueues.get(relativePath) === current) {
        this.fileQueues.delete(relativePath)
      }
    })

    return current
  }

  private schedule(absolutePath: string, run: number): void {
    let relativePath: string
    try {
      relativePath = this.toRelativePath(absolutePath)
    } catch (error) {
      this.reportError(this.toError('文件路径非法', error))
      return
    }

    const timer = this.debounceTimers.get(relativePath)
    if (timer) {
      clearTimeout(timer)
    }

    this.debounceTimers.set(
      relativePath,
      setTimeout(() => {
        this.debounceTimers.delete(relativePath)
        void this.enqueue(absolutePath, async () => {
          await this.processChange(absolutePath, relativePath, run)
        })
      }, this.debounceMs),
    )
  }

  private async processChange(
    absolutePath: string,
    relativePath: string,
    run: number,
  ): Promise<void> {
    if (!this.isRunActive(run)) {
      return
    }

    const previous = this.baseline.get(relativePath)
    let content = ''
    let deleted = false

    try {
      if (!await this.isSafeExistingPath(absolutePath)) {
        console.warn(`[cairn:watcher] 跳过指向项目外的符号链接：${relativePath}`)
        return
      }
      if (await this.isBinaryFile(absolutePath, relativePath)) {
        console.debug(`[cairn:watcher] 跳过 binary 文件：${relativePath}`)
        // v2-C 暂不为 binary 生成 op，因此也不会触发影子 Git 提交。
        return
      }
      content = await readFile(absolutePath, 'utf8')
    } catch (error) {
      if (!this.isMissingFile(error)) {
        this.reportError(this.toError(`读取文件失败：${relativePath}`, error))
        return
      }
      deleted = true
    }

    if (!this.isRunActive(run) || (deleted && !previous)) {
      return
    }

    const oldContent = previous?.content ?? ''
    if (!deleted && previous && oldContent === content) {
      return
    }

    let op: Op
    try {
      // 同时保存旧内容，远端 baseHash 不匹配时可用于三方合并。
      const baseHash = writeSnapshot(this.projectRoot, relativePath, oldContent)
      const input: NewOp = {
        id: randomUUID(),
        author: this.author,
        parentHashes: [],
        timestamp: Date.now(),
        filePath: relativePath,
        diff: createTwoFilesPatch(relativePath, relativePath, oldContent, content),
        kind: deleted ? 'deleted' : previous ? 'modified' : 'created',
        baseHash,
        source: 'local',
      }
      if (deleted) {
        await this.trash.moveToTrash(
          relativePath,
          absolutePath,
          this.author,
          computeHash(input),
          oldContent,
        )
      }

      const snapshotHash = writeSnapshot(this.projectRoot, relativePath, content)
      if (!this.isRunActive(run)) return

      op = this.oplog.putOp(input)
      const nextBaseline: BaselineEntry = { content, snapshotHash }
      if (deleted) this.baseline.delete(relativePath)
      else this.baseline.set(relativePath, nextBaseline)

    } catch (error) {
      if (deleted) {
        await this.restoreDeletedFile(absolutePath, oldContent)
      }
      if (previous) {
        this.baseline.set(relativePath, previous)
      } else {
        this.baseline.delete(relativePath)
      }
      this.reportError(this.toError(`写入变更失败：${relativePath}`, error))
      return
    }

    if (!this.isRunActive(run)) {
      return
    }

    try {
      this.emit('op', op)
    } catch (error) {
      this.reportError(this.toError(`通知变更失败：${relativePath}`, error))
    }
  }

  private isActive(watcher: FSWatcher, run: number): boolean {
    return this.watcher === watcher && this.isRunActive(run)
  }

  private isRunActive(run: number): boolean {
    return this.watcher !== undefined && this.activeRun === run
  }

  private isIgnoredPath(path: string): boolean {
    const relativePath = relative(this.projectRoot, path)
    if (relativePath.length === 0) {
      return false
    }

    return isSensitiveFile(relativePath) || relativePath
      .split(sep)
      .some((segment) => IGNORED_DIRECTORIES.has(segment))
  }

  /** 删除进入废纸篓后的后续步骤失败时，尽力恢复基线内容，绝不继续广播删除。 */
  private async restoreDeletedFile(absolutePath: string, content: string): Promise<void> {
    try {
      await access(absolutePath)
      return
    } catch {
      // 文件仍不存在，继续恢复。
    }

    try {
      await mkdir(dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, content, 'utf8')
      console.warn(`[cairn:watcher] 删除处理失败，已恢复文件：${absolutePath}`)
    } catch (restoreError) {
      console.error(`[cairn:watcher] 删除处理失败且无法恢复文件：${absolutePath}`, restoreError)
    }
  }

  private async isBinaryFile(absolutePath: string, relativePath: string): Promise<boolean> {
    return isBinaryFile(absolutePath, relativePath, this.binaryByExtension)
  }

  /** 允许项目内链接，拒绝任何解析后离开项目根目录的路径。 */
  private async isSafeExistingPath(absolutePath: string): Promise<boolean> {
    const [root, target] = await Promise.all([realpath(this.projectRoot), realpath(absolutePath)])
    const normalizedRoot = resolve(root)
    const normalizedTarget = resolve(target)
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  }

  private toRelativePath(absolutePath: string): string {
    const relativePath = relative(this.projectRoot, absolutePath)
    const segments = relativePath.split(sep)

    if (
      relativePath.length === 0 ||
      relativePath.startsWith('..') ||
      segments.includes('..') ||
      relativePath.startsWith(sep)
    ) {
      throw new Error(`路径不在项目根目录内：${absolutePath}`)
    }

    return segments.join('/')
  }

  private assertSafeRelativePath(relativePath: string): string {
    const normalizedPath = relativePath.replaceAll('\\', '/')
    const segments = normalizedPath.split('/')
    if (
      normalizedPath.length === 0 ||
      isAbsolute(normalizedPath) ||
      win32.isAbsolute(normalizedPath) ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new Error(`路径不在项目根目录内：${relativePath}`)
    }

    return normalizedPath
  }

  private isMissingFile(error: unknown): boolean {
    return isMissingFileError(error)
  }

  private reportError(error: Error): void {
    try {
      this.emit('error', error)
    } catch {
      console.error(`[cairn:watcher] ${error.message}`)
    }
  }

  private toError(context: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(`${context}：${message}`, { cause: error })
  }
}
