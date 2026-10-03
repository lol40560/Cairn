import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as typeof import('yauzl')

export interface ExtractOptions {
  onConflict?: (relativePath: string) => void
  onFile?: (relativePath: string) => void
  overwrite?: boolean
  skip?: (relativePath: string) => boolean
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
        if (options.skip?.(relativePath)) {
          readNext()
          return
        }
        const destination = safeTargetPath(targetRoot, relativePath)
        if (!destination) {
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
            void (async () => {
              try {
                const content = Buffer.concat(chunks)
                if (options.overwrite === false) {
                  const exists = await existingContent(destination)
                  if (exists && !exists.equals(content)) {
                    options.onConflict?.(relativePath)
                    await writeFile(`${destination}.cairn-remote`, content)
                    readNext()
                    return
                  }
                  if (exists) {
                    readNext()
                    return
                  }
                }
                await mkdir(dirname(destination), { recursive: true })
                await writeFile(destination, content)
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

function safeTargetPath(targetRoot: string, entryName: string): string | undefined {
  const normalized = normalize(entryName)
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return undefined
  }
  const target = resolve(targetRoot, normalized)
  return relative(targetRoot, target).startsWith('..') ? undefined : target
}

async function existingContent(targetPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(targetPath)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
