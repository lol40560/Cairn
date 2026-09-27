import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'

import { isBinaryFile } from '../watcher/watcher'
import { AppError } from '../errors'

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

const IGNORED_DIRECTORIES = new Set([
  '.cairn',
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  '.vscode',
])

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024

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

interface ExportFile {
  absolutePath: string
  relativePath: string
  size: number
}

/** 递归收集可导出的文本文件，保留其项目内相对路径。 */
async function collectExportFiles(projectRoot: string): Promise<{ files: ExportFile[]; skippedCount: number }> {
  const files: ExportFile[] = []
  const binaryByExtension = new Map<string, boolean>()
  let skippedCount = 0

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skippedCount += 1
        continue
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue
        }
        await visit(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const relativePath = relative(projectRoot, absolutePath).split(sep).join('/')
      if (await isBinaryFile(absolutePath, relativePath, binaryByExtension)) {
        skippedCount += 1
        continue
      }

      files.push({
        absolutePath,
        relativePath,
        size: (await stat(absolutePath)).size,
      })
    }
  }

  await visit(projectRoot)
  return { files, skippedCount }
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

async function writeZip(filePath: string, files: ExportFile[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filePath, { flags: 'wx' })
    const archive = new ZipArchive({ zlib: { level: 9 } })

    output.once('close', resolve)
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
 * 打包当前项目的文本文件快照。Cairn 内部数据、依赖、构建产物和 binary 文件均不会进入压缩包。
 */
export async function exportProjectSnapshot(
  projectRoot: string,
  options: ExportProjectSnapshotOptions = {},
): Promise<ExportSnapshotResult> {
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

  const tempDirectory = options.tempDirectory ?? tmpdir()
  await mkdir(tempDirectory, { recursive: true })
  const filePath = join(tempDirectory, `${basename(projectRoot)}-${randomUUID()}.zip`)

  await writeZip(filePath, files)
  const archiveStats = await stat(filePath)

  return {
    filePath,
    fileSize: archiveStats.size,
    fileCount: files.length,
    skippedCount,
  }
}
