import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { packageProjectAsZip } from '../snapshot/export'
import type { SyncMessage } from './protocol'
import { DownloadProgress, SnapshotDownloader } from './downloader'
import { SNAPSHOT_CHUNK_SIZE } from './seeder'
import type { Sync } from './sync'

const roots: string[] = []

class FakeSync {
  downloader: SnapshotDownloader | undefined
  metadata: Extract<SyncMessage, { type: 'snapshot-meta' }> | undefined
  chunks: Buffer[] = []
  readonly broadcasts: SyncMessage[] = []
  readonly sent: Array<{ peerId: string; message: SyncMessage }> = []
  readonly retryPendingOps = vi.fn(async () => undefined)
  onWantChunk: ((message: Extract<SyncMessage, { type: 'want-chunk' }>) => void) | undefined

  broadcast(message: SyncMessage): void {
    this.broadcasts.push(message)
    if (message.type === 'want-snapshot' && this.metadata && this.downloader) {
      queueMicrotask(() => this.downloader?.handleSnapshotMeta('seed-peer', this.metadata!))
    }
  }

  send(peerId: string, message: SyncMessage): void {
    this.sent.push({ peerId, message })
    if (message.type === 'want-chunk' && this.downloader) {
      if (this.onWantChunk) {
        this.onWantChunk(message)
        return
      }
      const chunk = this.chunks[message.index]
      queueMicrotask(() => {
        if (chunk) {
          this.downloader?.handleChunk('seed-peer', {
            type: 'chunk',
            snapshotId: message.snapshotId,
            index: message.index,
            data: chunk.toString('base64'),
          })
        }
      })
    }
  }
}

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

async function configureSnapshot(sync: FakeSync, source: string): Promise<string> {
  const packaged = await packageProjectAsZip(source)
  const snapshotId = createHash('sha256').update(packaged.buffer).digest('hex')
  sync.chunks = Array.from(
    { length: Math.ceil(packaged.buffer.length / SNAPSHOT_CHUNK_SIZE) },
    (_, index) => packaged.buffer.subarray(index * SNAPSHOT_CHUNK_SIZE, (index + 1) * SNAPSHOT_CHUNK_SIZE),
  )
  sync.metadata = {
    type: 'snapshot-meta',
    snapshotId,
    projectName: 'shared-project',
    size: packaged.buffer.length,
    chunkCount: sync.chunks.length,
  }
  return snapshotId
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SnapshotDownloader', () => {
  it('按顺序接收完整快照并保留相对目录结构', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await mkdir(join(source, 'src', 'nested'), { recursive: true })
    await writeFile(join(source, 'src', 'nested', 'sample.ts'), 'export const value = 2\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader

    const result = await downloader.startDownload(snapshotId, target)

    expect(result.extractedFiles).toBe(1)
    expect(result.conflictFiles).toEqual([])
    await expect(readFile(join(target, 'src', 'nested', 'sample.ts'), 'utf8')).resolves.toBe('export const value = 2\n')
    expect(sync.sent.some(({ message }) => message.type === 'snapshot-done')).toBe(true)
    expect(sync.retryPendingOps).toHaveBeenCalledOnce()
  })

  it('哈希校验失败时拒绝解压', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const value = 2\n')
    const sync = new FakeSync()
    await configureSnapshot(sync, source)
    const snapshotId = '0'.repeat(64)
    sync.metadata = { ...sync.metadata!, snapshotId }
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader

    await expect(downloader.startDownload(snapshotId, target)).rejects.toThrow('哈希校验失败')
  })

  it('等待元数据超过十秒时失败', async () => {
    const target = await createDirectory('cairn-download-target-')
    const sync = new FakeSync()
    const downloader = new SnapshotDownloader(sync as unknown as Sync, { metaTimeoutMs: 1 })

    const pending = downloader.startDownload('a'.repeat(64), target)

    await expect(pending).rejects.toThrow('元数据超时')
  })

  it('已有不同内容时写入 .cairn-remote，而不覆盖本地文件', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const remote = true\n')
    await writeFile(join(target, 'sample.ts'), 'export const local = true\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader

    const result = await downloader.startDownload(snapshotId, target)

    await expect(readFile(join(target, 'sample.ts'), 'utf8')).resolves.toBe('export const local = true\n')
    await expect(readFile(join(target, 'sample.ts.cairn-remote'), 'utf8')).resolves.toBe('export const remote = true\n')
    expect(result.conflictFiles).toEqual([join(target, 'sample.ts.cairn-remote')])
  })

  it('已有相同内容时跳过文件', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    const content = 'export const same = true\n'
    await writeFile(join(source, 'sample.ts'), content)
    await writeFile(join(target, 'sample.ts'), content)
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader

    const result = await downloader.startDownload(snapshotId, target)

    expect(result.extractedFiles).toBe(0)
    expect(result.conflictFiles).toEqual([])
  })

  it('持续报告下载进度', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const value = 2\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader
    const progress: DownloadProgress[] = []

    await downloader.startDownload(snapshotId, target, (next) => progress.push(next))

    expect(progress.map((item) => item.status)).toContain('waiting-meta')
    expect(progress.map((item) => item.status)).toContain('downloading')
    expect(progress.map((item) => item.status)).toContain('done')
    expect(progress.some((item) => item.receivedChunks === item.totalChunks && item.totalChunks > 0)).toBe(true)
  })

  it('分块超时后重试，并在后续成功时继续下载', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const retry = true\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync, {
      chunkTimeoutMs: 5,
      retryDelayMs: 1,
    })
    sync.downloader = downloader
    let requests = 0
    sync.onWantChunk = (message) => {
      requests += 1
      if (requests === 2) {
        const chunk = sync.chunks[message.index]!
        queueMicrotask(() => downloader.handleChunk('seed-peer', {
          type: 'chunk', snapshotId: message.snapshotId, index: message.index, data: chunk.toString('base64'),
        }))
      }
    }

    await expect(downloader.startDownload(snapshotId, target)).resolves.toMatchObject({ extractedFiles: 1 })
    expect(requests).toBe(2)
  })

  it('分块连续三次超时后失败', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const timeout = true\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync, {
      chunkTimeoutMs: 2,
      maxChunkRetries: 3,
      retryDelayMs: 1,
    })
    sync.downloader = downloader
    sync.onWantChunk = () => undefined

    await expect(downloader.startDownload(snapshotId, target)).rejects.toThrow('Chunk 0 failed after 3 retries')
  })

  it('取消时中止正在等待的分块请求', async () => {
    const source = await createDirectory('cairn-download-source-')
    const target = await createDirectory('cairn-download-target-')
    await writeFile(join(source, 'sample.ts'), 'export const cancel = true\n')
    const sync = new FakeSync()
    const snapshotId = await configureSnapshot(sync, source)
    const downloader = new SnapshotDownloader(sync as unknown as Sync)
    sync.downloader = downloader
    sync.onWantChunk = () => downloader.cancel()

    await expect(downloader.startDownload(snapshotId, target)).rejects.toThrow('项目下载已取消')
  })
})
