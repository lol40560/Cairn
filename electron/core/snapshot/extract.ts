import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'

import {
  assertSafeProjectRelativePath,
  prepareSafeProjectWritePath,
  resolveSafeProjectPath,
} from '../fs/project-path'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as typeof import('yauzl')

export interface ExtractOptions {
  onConflict?: (relativePath: string) => void
  onFile?: (relativePath: string) => void
  overwrite?: boolean
  skip?: (relativePath: string) => boolean
}

/** 以 Buffer 读取 ZIP 条目，供 checkpoint 比较使用；仍沿用同一条 Zip Slip 防线。 */
export async function readZipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise<Map<string, Buffer>>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectPromise(openError ?? new Error('無法開啟 ZIP'))
        return
      }

      const entries = new Map<string, Buffer>()
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

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`無法讀取 ZIP 條目：${entry.fileName}`))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.once('error', finish)
          stream.once('end', () => {
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
  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectPromise(openError ?? new Error('無法開啟 ZIP'))
        return
      }

      let completed = false
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
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.once('error', finish)
          stream.once('end', () => {
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

async function existingContent(targetPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(targetPath)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
