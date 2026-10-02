import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

import type { SyncMessage } from './protocol'
import { SNAPSHOT_CHUNK_SIZE } from './seeder'
import type { Sync } from './sync'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as typeof import('yauzl')
const META_TIMEOUT_MS = 10_000
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024
export const CHUNK_TIMEOUT_MS = 5_000
export const MAX_CHUNK_RETRIES = 3

export interface SnapshotDownloaderOptions {
  /** 默认 10 秒；仅用于受控环境下的测试。 */
  metaTimeoutMs?: number
  /** 单个分块的等待时长；仅用于受控环境下的测试。 */
  chunkTimeoutMs?: number
  /** 单个分块的最大请求次数；仅用于受控环境下的测试。 */
  maxChunkRetries?: number
  /** 分块重试间隔；仅用于受控环境下的测试。 */
  retryDelayMs?: number
}

export interface DownloadProgress {
  snapshotId: string
  projectName: string
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  totalBytes: number
  status: 'idle' | 'waiting-meta' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed'
  error?: string
}

export interface DownloadResult {
  targetDir: string
  extractedFiles: number
  conflictFiles: string[]
}

interface DownloadSession {
  chunks: Buffer[]
  metaTimeout: NodeJS.Timeout | undefined
  peerId: string | undefined
  progress: DownloadProgress
  reject: (error: Error) => void
  resolveMeta: () => void
  rejectMeta: (error: Error) => void
  pendingChunk: {
    index: number
    resolve: () => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  } | undefined
  onProgress: ((progress: DownloadProgress) => void) | undefined
  settled: boolean
}

/** 接收一次快照、校验哈希并安全解压到目标目录。 */
export class SnapshotDownloader extends EventEmitter {
  private session: DownloadSession | undefined

  constructor(
    private readonly sync: Sync,
    private readonly options: SnapshotDownloaderOptions = {},
  ) {
    super()
  }

  async startDownload(
    snapshotId: string,
    targetDir: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    if (this.session) {
      throw new Error('已有项目下载正在进行')
    }
    if (!isAbsolute(targetDir)) {
      throw new Error(`下载目标必须是绝对路径：${targetDir}`)
    }

    await mkdir(targetDir, { recursive: true })

    return new Promise<DownloadResult>((resolvePromise, rejectPromise) => {
      let resolveMeta: () => void = () => undefined
      let rejectMeta: (error: Error) => void = () => undefined
      const metaReady = new Promise<void>((resolve, reject) => {
        resolveMeta = resolve
        rejectMeta = reject
      })
      const session: DownloadSession = {
        chunks: [],
        metaTimeout: undefined,
        peerId: undefined,
        progress: {
          snapshotId,
          projectName: '',
          receivedChunks: 0,
          totalChunks: 0,
          receivedBytes: 0,
          totalBytes: 0,
          status: 'waiting-meta',
        },
        reject: rejectPromise,
        resolveMeta,
        rejectMeta,
        pendingChunk: undefined,
        onProgress,
        settled: false,
      }
      this.session = session
      this.publishProgress(session)
      session.metaTimeout = setTimeout(() => {
        this.fail(session, new Error('等待项目快照元数据超时（10 秒）'))
      }, this.options.metaTimeoutMs ?? META_TIMEOUT_MS)
      this.sync.broadcast({ type: 'want-snapshot', snapshotId })

      void (async () => {
        try {
          await metaReady
          for (let index = 0; index < session.progress.totalChunks; index += 1) {
            await this.requestChunk(session, index)
          }

          this.updateProgress(session, { status: 'verifying' })
          const buffer = Buffer.concat(session.chunks)
          if (buffer.length !== session.progress.totalBytes) {
            throw new Error(`快照大小校验失败：预期 ${session.progress.totalBytes}，实际 ${buffer.length}`)
          }
          const actualId = createHash('sha256').update(buffer).digest('hex')
          if (actualId !== snapshotId) {
            throw new Error(`快照哈希校验失败：预期 ${snapshotId}，实际 ${actualId}`)
          }

          this.updateProgress(session, { status: 'extracting' })
          const result = await extractSnapshot(buffer, targetDir)
          // 快照提供了文件基线；现在可以重试此前因基线缺失而延后的远端操作。
          await this.sync.retryPendingOps()
          this.updateProgress(session, { status: 'done' })
          if (session.peerId) {
            this.sync.send(session.peerId, { type: 'snapshot-done', snapshotId })
          }
          this.complete(session)
          resolvePromise(result)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          this.fail(session, normalized)
        }
      })()
    })
  }

  cancel(reason: Error = new Error('项目下载已取消')): void {
    const session = this.session
    if (!session || session.settled) {
      return
    }
    this.fail(session, reason)
  }

  handleSnapshotMeta(peerId: string, message: Extract<SyncMessage, { type: 'snapshot-meta' }>): void {
    const session = this.session
    if (!session || session.settled || session.progress.snapshotId !== message.snapshotId || session.peerId) {
      return
    }
    if (message.size > MAX_SNAPSHOT_BYTES) {
      this.fail(session, new Error('项目过大，超过 50 MB 上限'))
      return
    }
    if (message.chunkCount !== Math.ceil(message.size / SNAPSHOT_CHUNK_SIZE)) {
      this.fail(session, new Error('快照元数据无效：分块数量不匹配'))
      return
    }

    session.peerId = peerId
    if (session.metaTimeout) {
      clearTimeout(session.metaTimeout)
      session.metaTimeout = undefined
    }
    session.chunks = new Array(message.chunkCount)
    this.updateProgress(session, {
      projectName: message.projectName,
      totalBytes: message.size,
      totalChunks: message.chunkCount,
      status: 'downloading',
    })
    session.resolveMeta()
  }

  handleChunk(peerId: string, message: Extract<SyncMessage, { type: 'chunk' }>): void {
    const session = this.session
    const pending = session?.pendingChunk
    if (
      !session ||
      session.settled ||
      peerId !== session.peerId ||
      message.snapshotId !== session.progress.snapshotId ||
      !pending ||
      pending.index !== message.index
    ) {
      return
    }

    const chunk = Buffer.from(message.data, 'base64')
    if (chunk.length === 0 && session.progress.totalBytes > 0) {
      pending.reject(new Error(`收到空快照分块：${message.index}`))
      return
    }
    session.chunks[message.index] = chunk
    session.pendingChunk = undefined
    clearTimeout(pending.timeout)
    session.progress.receivedChunks += 1
    session.progress.receivedBytes += chunk.length
    this.publishProgress(session)
    pending.resolve()
  }

  private async requestChunk(
    session: DownloadSession,
    index: number,
  ): Promise<void> {
    const maxRetries = this.options.maxChunkRetries ?? MAX_CHUNK_RETRIES
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        await this.waitForChunk(session, index)
        return
      } catch (error) {
        if (session.settled) {
          throw error
        }
        if (attempt === maxRetries - 1) {
          throw new Error(`Chunk ${index} failed after ${maxRetries} retries`, { cause: error })
        }
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, this.options.retryDelayMs ?? 500)
        })
      }
    }
  }

  private waitForChunk(session: DownloadSession, index: number): Promise<void> {
    return new Promise<void>((resolveChunk, rejectChunk) => {
      if (!session.peerId || session.settled) {
        rejectChunk(new Error('下载已取消'))
        return
      }
      const pending = {
        index,
        reject: (error: Error): void => {
          clearTimeout(pending.timeout)
          rejectChunk(error)
        },
        resolve: (): void => {
          clearTimeout(pending.timeout)
          resolveChunk()
        },
        timeout: undefined as unknown as NodeJS.Timeout,
      }
      pending.timeout = setTimeout(() => {
        if (session.pendingChunk === pending) {
          session.pendingChunk = undefined
          rejectChunk(new Error(`等待分块 ${index} 超时`))
        }
      }, this.options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS)
      session.pendingChunk = pending
      this.sync.send(session.peerId, { type: 'want-chunk', snapshotId: session.progress.snapshotId, index })
      this.publishProgress(session)
    })
  }

  private updateProgress(
    session: DownloadSession,
    update: Partial<DownloadProgress>,
  ): void {
    Object.assign(session.progress, update)
    this.publishProgress(session)
  }

  private publishProgress(session: DownloadSession): void {
    const progress = { ...session.progress }
    session.onProgress?.(progress)
    this.emit('progress', progress)
  }

  private complete(session: DownloadSession): void {
    if (session.metaTimeout) {
      clearTimeout(session.metaTimeout)
    }
    if (session.pendingChunk) {
      clearTimeout(session.pendingChunk.timeout)
      session.pendingChunk = undefined
    }
    session.settled = true
    if (this.session === session) {
      this.session = undefined
    }
  }

  private fail(session: DownloadSession, error: Error): void {
    if (session.settled) {
      return
    }
    if (session.metaTimeout) {
      clearTimeout(session.metaTimeout)
    }
    session.settled = true
    if (session.pendingChunk) {
      const pending = session.pendingChunk
      session.pendingChunk = undefined
      pending.reject(error)
    }
    session.rejectMeta(error)
    session.progress.status = 'failed'
    session.progress.error = error.message
    this.publishProgress(session)
    this.emit('downloadError', error)
    if (this.session === session) {
      this.session = undefined
    }
    session.reject(error)
  }
}

/** 将 ZIP 中的文件安全合并到目标目录，绝不覆盖已有不同内容。 */
async function extractSnapshot(buffer: Buffer, targetDir: string): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectPromise(openError ?? new Error('无法打开项目快照'))
        return
      }

      const conflictFiles: string[] = []
      let extractedFiles = 0
      let completed = false
      const finish = (error?: Error): void => {
        if (completed) {
          return
        }
        completed = true
        zipfile.close()
        if (error) {
          rejectPromise(error)
        } else {
          resolvePromise({ targetDir, extractedFiles, conflictFiles })
        }
      }
      const readNext = (): void => zipfile.readEntry()

      zipfile.on('error', finish)
      zipfile.on('end', () => finish())
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          readNext()
          return
        }

        const targetPath = safeTargetPath(targetDir, entry.fileName)
        if (!targetPath) {
          finish(new Error(`快照包含越界路径：${entry.fileName}`))
          return
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`无法读取 ZIP 条目：${entry.fileName}`))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.once('error', finish)
          stream.once('end', () => {
            void (async () => {
              try {
                const content = Buffer.concat(chunks)
                const destination = await destinationForContent(targetPath, content, conflictFiles)
                if (destination) {
                  await mkdir(dirname(destination), { recursive: true })
                  await writeFile(destination, content)
                  extractedFiles += 1
                }
                readNext()
              } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)))
              }
            })()
          })
        })
      })
      readNext()
    })
  })
}

function safeTargetPath(targetDir: string, entryName: string): string | undefined {
  const normalizedEntry = normalize(entryName)
  if (isAbsolute(normalizedEntry) || normalizedEntry === '..' || normalizedEntry.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return undefined
  }
  const targetPath = resolve(targetDir, normalizedEntry)
  return relative(targetDir, targetPath).startsWith('..') ? undefined : targetPath
}

async function destinationForContent(
  targetPath: string,
  content: Buffer,
  conflictFiles: string[],
): Promise<string | undefined> {
  try {
    const existing = await readFile(targetPath)
    if (existing.equals(content)) {
      return undefined
    }
    const conflictPath = `${targetPath}.cairn-remote`
    conflictFiles.push(conflictPath)
    return conflictPath
  } catch (error) {
    if (isMissingPath(error)) {
      return targetPath
    }
    throw error
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
