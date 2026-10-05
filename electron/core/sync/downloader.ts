import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { extractZipBuffer } from '../snapshot/extract'
import { MAX_SNAPSHOT_COMPRESSED_BYTES } from '../snapshot/limits'
import type { SyncMessage } from './protocol'
import { SNAPSHOT_CHUNK_SIZE } from './seeder'
import type { Sync } from './sync'

const META_TIMEOUT_MS = 10_000
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
    if (!Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_SNAPSHOT_COMPRESSED_BYTES) {
      this.fail(session, new Error('项目过大，超过 50 MB 上限'))
      return
    }
    const expectedChunkCount = Math.ceil(message.size / SNAPSHOT_CHUNK_SIZE)
    if (!Number.isSafeInteger(message.chunkCount) || message.chunkCount < 0 || message.chunkCount !== expectedChunkCount) {
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
    if (!session || session.settled || peerId !== session.peerId || message.snapshotId !== session.progress.snapshotId) {
      return
    }

    const pending = session.pendingChunk
    if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index >= session.progress.totalChunks) {
      this.fail(session, new Error(`收到越界快照分块：${message.index}`))
      return
    }
    // 同一会话按序接收；重复或乱序分块代表对端违反快照协议，直接中止而非保留额外数据。
    if (session.chunks[message.index] || !pending || pending.index !== message.index) {
      this.fail(session, new Error(`收到重复或意外快照分块：${message.index}`))
      return
    }

    const expectedLength = expectedChunkLength(
      message.index,
      session.progress.totalBytes,
      session.progress.totalChunks,
    )
    if (message.data.length > maxBase64Length(expectedLength)) {
      this.fail(session, new Error(`快照分块编码超过大小上限：${message.index}`))
      return
    }

    const chunk = Buffer.from(message.data, 'base64')
    if (chunk.length !== expectedLength) {
      this.fail(session, new Error(`快照分块大小不匹配：${message.index}`))
      return
    }
    if (
      chunk.length > SNAPSHOT_CHUNK_SIZE ||
      session.progress.receivedBytes + chunk.length > session.progress.totalBytes ||
      session.progress.receivedBytes + chunk.length > MAX_SNAPSHOT_COMPRESSED_BYTES
    ) {
      this.fail(session, new Error(`快照分块累计大小超过上限：${message.index}`))
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
    this.releaseBuffers(session)
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
    this.releaseBuffers(session)
    session.progress.status = 'failed'
    session.progress.error = error.message
    this.publishProgress(session)
    this.emit('downloadError', error)
    if (this.session === session) {
      this.session = undefined
    }
    session.reject(error)
  }

  private releaseBuffers(session: DownloadSession): void {
    session.chunks.length = 0
    session.progress.receivedBytes = 0
  }
}

function expectedChunkLength(index: number, totalBytes: number, chunkCount: number): number {
  if (chunkCount === 0 || index < 0 || index >= chunkCount) {
    throw new Error(`无效快照分块索引：${index}`)
  }
  const offset = index * SNAPSHOT_CHUNK_SIZE
  return Math.min(SNAPSHOT_CHUNK_SIZE, totalBytes - offset)
}

function maxBase64Length(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4
}

/** 将 ZIP 中的文件安全合并到目标目录，绝不覆盖已有不同内容。 */
async function extractSnapshot(buffer: Buffer, targetDir: string): Promise<DownloadResult> {
  const conflictFiles: string[] = []
  let extractedFiles = 0
  await extractZipBuffer(buffer, targetDir, {
    onConflict: (relativePath) => conflictFiles.push(`${targetDir}/${relativePath}.cairn-remote`),
    onFile: () => { extractedFiles += 1 },
    overwrite: false,
  })
  return { conflictFiles, extractedFiles, targetDir }
}
