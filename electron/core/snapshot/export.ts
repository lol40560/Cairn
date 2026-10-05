import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'

import { IgnoreMatcher } from '../ignore'
import {
  isBinaryFile,
  MAX_SYNCABLE_BINARY_SIZE,
  SYNCABLE_BINARY_EXTENSIONS,
} from '../watcher/watcher'
import { AppError } from '../errors'
import { MAX_SNAPSHOT_COMPRESSED_BYTES } from './limits'

const require = createRequire(import.meta.url)

interface Archive {
  file(path: string, data: { name: string }): void
  finalize(): void
  on(event: 'error', listener: (error: Error) => void): this
  pipe(destination: NodeJS.WritableStream): void
}

interface ArchiverModule {
  ZipArchive: new (options: { zlib: { level: number } }) => Archive
}

const { ZipArchive } = require('archiver') as ArchiverModule

const DEFAULT_MAX_SIZE_BYTES = MAX_SNAPSHOT_COMPRESSED_BYTES

export interface ExportSnapshotResult {
  filePath: string
  fileSize: number
  fileCount: number
  skippedCount: number
}

export interface ExportProjectSnapshotOptions {
  maxSizeBytes?: number
  /** 主进程传入 Electron 临时目录；测试和非 Electron 调用使用系统临时目录。 */
  tempDirectory?: string
}

export interface PackagedProjectSnapshot {
  buffer: Buffer
  fileCount: number
  skippedCount: number
}

interface ExportFile {
  absolutePath: string
  relativePath: string
  size: number
}

/** 递归收集可导出的文本與白名單二進制檔案，保留其项目内相对路径。 */
async function collectExportFiles(projectRoot: string): Promise<{ files: ExportFile[]; skippedCount: number }> {
  const files: ExportFile[] = []
  const binaryByExtension = new Map<string, boolean>()
  const ignoreMatcher = new IgnoreMatcher(projectRoot)
  const resolvedRoot = await realpath(projectRoot)
  let skippedCount = 0

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(projectRoot, absolutePath).split(sep).join('/')
      if (ignoreMatcher.isIgnored(relativePath)) continue

      let sourcePath = absolutePath
      let sourceSize: number | undefined
      if (entry.isSymbolicLink()) {
        try {
          const resolvedPath = await realpath(absolutePath)
          if (!isWithinProject(resolvedRoot, resolvedPath)) {
            skippedCount += 1
            continue
          }
          const targetStats = await stat(resolvedPath)
          // 不跟随目录链接，避免循环遍历；项目内文件链接可安全保留内容。
          if (!targetStats.isFile()) {
            skippedCount += 1
            continue
          }
          sourcePath = resolvedPath
          sourceSize = targetStats.size
        } catch {
          skippedCount += 1
          continue
        }
      }

      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue
      }

      const size = sourceSize ?? (await stat(sourcePath)).size
      const extension = extname(relativePath).toLowerCase()
      const syncableBinary = SYNCABLE_BINARY_EXTENSIONS.has(extension)
      if (syncableBinary && size > MAX_SYNCABLE_BINARY_SIZE) {
        skippedCount += 1
        continue
      }
      if (!syncableBinary && await isBinaryFile(sourcePath, relativePath, binaryByExtension)) {
        skippedCount += 1
        continue
      }

      files.push({
        absolutePath: sourcePath,
        relativePath,
        size,
      })
    }
  }

  await visit(projectRoot)
  return { files, skippedCount }
}

function isWithinProject(projectRoot: string, targetPath: string): boolean {
  const root = resolve(projectRoot)
  const target = resolve(targetPath)
  return target === root || target.startsWith(`${root}${sep}`)
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

async function createZipBuffer(files: ExportFile[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const output = new Writable({
      write(chunk: Buffer | string, _encoding, callback): void {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })
    const archive = new ZipArchive({ zlib: { level: 9 } })

    output.once('finish', () => resolve(Buffer.concat(chunks)))
    output.once('error', reject)
    archive.on('error', reject)
    archive.pipe(output)

    for (const file of files) {
      archive.file(file.absolutePath, { name: file.relativePath })
    }

    try {
      archive.finalize()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * 将项目的可同步文本及白名單二進制檔案打包为内存 ZIP。P2P seeder 与手动导出共用该入口，
 * 从而确保过滤规则和体积上限完全一致。
 */
export async function packageProjectAsZip(
  projectRoot: string,
  options: ExportProjectSnapshotOptions = {},
): Promise<PackagedProjectSnapshot> {
  const projectStats = await stat(projectRoot)
  if (!projectStats.isDirectory()) {
    throw new Error(`项目路径必须是目录：${projectRoot}`)
  }

  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES
  if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0) {
    throw new Error(`maxSizeBytes 必须是正整数，收到 ${maxSizeBytes}`)
  }

  const { files, skippedCount } = await collectExportFiles(projectRoot)
  const totalSize = files.reduce((total, file) => total + file.size, 0)
  if (totalSize > maxSizeBytes) {
    throw new AppError(
      `项目过大（${formatMegabytes(totalSize)} MB），超过 ${formatMegabytes(maxSizeBytes)} MB 上限。请手动打包。`,
      'config',
      { code: 'SNAPSHOT_TOO_LARGE' },
    )
  }

  return {
    buffer: await createZipBuffer(files),
    fileCount: files.length,
    skippedCount,
  }
}

/**
 * 打包当前项目快照。Cairn 内部数据、依赖、构建产物和非白名單 binary 文件均不会进入压缩包。
 */
export async function exportProjectSnapshot(
  projectRoot: string,
  options: ExportProjectSnapshotOptions = {},
): Promise<ExportSnapshotResult> {
  const packaged = await packageProjectAsZip(projectRoot, options)

  const tempDirectory = options.tempDirectory ?? tmpdir()
  await mkdir(tempDirectory, { recursive: true })
  const filePath = join(tempDirectory, `${basename(projectRoot)}-${randomUUID()}.zip`)

  await writeFile(filePath, packaged.buffer, { flag: 'wx' })

  return {
    filePath,
    fileSize: packaged.buffer.length,
    fileCount: packaged.fileCount,
    skippedCount: packaged.skippedCount,
  }
}
