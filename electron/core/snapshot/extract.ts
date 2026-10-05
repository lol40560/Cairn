import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'

import {
  assertSafeProjectRelativePath,
  prepareSafeProjectWritePath,
  resolveSafeProjectPath,
} from '../fs/project-path'
import {
  resolveSnapshotExtractionLimits,
  type SnapshotExtractionLimitOverrides,
  type SnapshotExtractionLimits,
} from './limits'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as typeof import('yauzl')

export interface ExtractOptions {
  onConflict?: (relativePath: string) => void
  onFile?: (relativePath: string) => void
  overwrite?: boolean
  skip?: (relativePath: string) => boolean
  /** 测试或受控调用可收紧资源上限；生产环境使用默认硬上限。 */
  limits?: SnapshotExtractionLimitOverrides
}

/** 以 Buffer 读取 ZIP 条目，供 checkpoint 比较使用；仍沿用同一条 Zip Slip 防线。 */
export async function readZipEntries(
  buffer: Buffer,
  limitsOverride?: SnapshotExtractionLimitOverrides,
): Promise<Map<string, Buffer>> {
  const limits = resolveSnapshotExtractionLimits(limitsOverride)
  return new Promise<Map<string, Buffer>>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectPromise(openError ?? new Error('無法開啟 ZIP'))
        return
      }

      const entries = new Map<string, Buffer>()
      const budget = createExtractionBudget(limits)
      let completed = false
      const finish = (error?: Error): void => {
        if (completed) return
        completed = true
        zipfile.close()
        if (error) rejectPromise(error)
        else resolvePromise(entries)
      }

      zipfile.on('error', finish)
      zipfile.on('end', () => finish())
      zipfile.on('entry', (entry) => {
        if (/\/$/u.test(entry.fileName)) {
          zipfile.readEntry()
          return
        }

        const relativePath = entry.fileName.replaceAll('\\', '/')
        try {
          assertSafeProjectRelativePath(relativePath)
        } catch {
          finish(new Error(`ZIP 包含越界路徑：${entry.fileName}`))
          return
        }
        try {
          budget.beginEntry(entry.uncompressedSize)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`無法讀取 ZIP 條目：${entry.fileName}`))
            return
          }
          const chunks: Buffer[] = []
          let entryBytes = 0
          stream.on('data', (chunk: Buffer) => {
            if (completed) return
            try {
              entryBytes += chunk.length
              budget.consume(entryBytes, chunk.length)
              chunks.push(chunk)
            } catch (error) {
              stream.destroy()
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          })
          stream.once('error', finish)
          stream.once('end', () => {
            if (completed) return
            entries.set(relativePath, Buffer.concat(chunks))
            zipfile.readEntry()
          })
        })
      })
      zipfile.readEntry()
    })
  })
}

/** 安全解壓 ZIP 到專案內，防止 Zip Slip 並以 Buffer 保留二進位內容。 */
export async function extractZipBuffer(
  buffer: Buffer,
  targetRoot: string,
  options: ExtractOptions = {},
): Promise<void> {
  const limits = resolveSnapshotExtractionLimits(options.limits)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectPromise(openError ?? new Error('無法開啟 ZIP'))
        return
      }

      let completed = false
      const budget = createExtractionBudget(limits)
      const finish = (error?: Error): void => {
        if (completed) return
        completed = true
        zipfile.close()
        if (error) rejectPromise(error)
        else resolvePromise()
      }
      const readNext = (): void => zipfile.readEntry()

      zipfile.on('error', finish)
      zipfile.on('end', () => finish())
      zipfile.on('entry', (entry) => {
        if (/\/$/u.test(entry.fileName)) {
          readNext()
          return
        }

        const relativePath = entry.fileName.replaceAll('\\', '/')
        try {
          assertSafeProjectRelativePath(relativePath)
        } catch {
          finish(new Error(`ZIP 包含越界路徑：${entry.fileName}`))
          return
        }
        try {
          budget.beginEntry(entry.uncompressedSize)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (options.skip?.(relativePath)) {
          readNext()
          return
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`無法讀取 ZIP 條目：${entry.fileName}`))
            return
          }
          const chunks: Buffer[] = []
          let entryBytes = 0
          stream.on('data', (chunk: Buffer) => {
            if (completed) return
            try {
              entryBytes += chunk.length
              budget.consume(entryBytes, chunk.length)
              chunks.push(chunk)
            } catch (error) {
              stream.destroy()
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          })
          stream.once('error', finish)
          stream.once('end', () => {
            if (completed) return
            void (async () => {
              try {
                const content = Buffer.concat(chunks)
                const destination = await resolveSafeProjectPath(targetRoot, relativePath)
                if (options.overwrite === false) {
                  const exists = await existingContent(destination)
                  if (exists && !exists.equals(content)) {
                    options.onConflict?.(relativePath)
                    const remotePath = await prepareSafeProjectWritePath(targetRoot, `${relativePath}.cairn-remote`)
                    await writeFile(remotePath, content)
                    readNext()
                    return
                  }
                  if (exists) {
                    readNext()
                    return
                  }
                }
                const writePath = await prepareSafeProjectWritePath(targetRoot, relativePath)
                await writeFile(writePath, content)
                options.onFile?.(relativePath)
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

function createExtractionBudget(limits: SnapshotExtractionLimits): {
  beginEntry: (declaredSize: number) => void
  consume: (entryBytes: number, chunkBytes: number) => void
} {
  let entries = 0
  let totalBytes = 0

  return {
    beginEntry(declaredSize: number): void {
      entries += 1
      if (entries > limits.maxEntries) {
        throw new Error(`ZIP 条目数量超过 ${limits.maxEntries} 上限`)
      }
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > limits.maxEntryBytes) {
        throw new Error(`ZIP 条目大小超过 ${limits.maxEntryBytes} 字节上限`)
      }
      if (declaredSize > limits.maxTotalUncompressedBytes - totalBytes) {
        throw new Error(`ZIP 解压总大小超过 ${limits.maxTotalUncompressedBytes} 字节上限`)
      }
    },
    consume(entryBytes: number, chunkBytes: number): void {
      if (entryBytes > limits.maxEntryBytes) {
        throw new Error(`ZIP 条目大小超过 ${limits.maxEntryBytes} 字节上限`)
      }
      if (chunkBytes > limits.maxTotalUncompressedBytes - totalBytes) {
        throw new Error(`ZIP 解压总大小超过 ${limits.maxTotalUncompressedBytes} 字节上限`)
      }
      totalBytes += chunkBytes
    },
  }
}

async function existingContent(targetPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(targetPath)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
