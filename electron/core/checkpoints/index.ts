import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { chmod, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'

import { assertNoCaseCollisions, assertSafeProjectRelativePath, isCaseInsensitiveFilesystem, prepareSafeProjectWritePath, resolveSafeProjectPath } from '../fs/project-path'
import { readZipEntries, readZipEntryContents } from '../snapshot/extract'
import { packageProjectAsZip } from '../snapshot/export'

export type CheckpointSource = 'manual' | 'auto-before-restore' | 'auto-before-revert' | 'auto-before-conflict-resolution'
export type CheckpointFileStatus = 'added' | 'modified' | 'deleted' | 'unchanged'

export interface Checkpoint {
  createdAt: number
  fileCount: number
  id: string
  name: string
  sizeBytes: number
  source: CheckpointSource
}

export interface CheckpointComparisonFile {
  binary: boolean
  checkpointSize?: number
  currentSize?: number
  path: string
  status: CheckpointFileStatus
}

export interface CheckpointComparison {
  checkpoint: Checkpoint
  currentRevision: string
  files: CheckpointComparisonFile[]
  summary: { added: number; deleted: number; modified: number; unchanged: number }
}

export interface CheckpointFileContents {
  binary: boolean
  checkpointContent?: string
  currentContent?: string
  path: string
}

export interface CreateCheckpointOptions {
  source?: CheckpointSource
}

export interface CheckpointManagerOptions {
  /** 測試用能力注入；省略時探測實際 project volume。 */
  caseInsensitiveFilesystem?: boolean
}

interface CheckpointManifest extends Checkpoint {
  skippedCount: number
}

const TEXT_EXTENSIONS = new Set([
  '.c', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rs', '.scss', '.sh', '.sql', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.svg',
])

/**
 * 管理完整可同步檔案快照。Checkpoint 不是 shadow Git commit；它只能安全還原
 * 已納入 snapshot 的檔案，不會觸碰 ignored 或未知檔案。
 */
export class CheckpointManager {
  constructor(
    private readonly projectRoot: string,
    private readonly options: CheckpointManagerOptions = {},
  ) {}

  async list(): Promise<Checkpoint[]> {
    const root = this.checkpointsRoot()
    if (!existsSync(root)) return []
    const checkpoints: Checkpoint[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isCheckpointId(entry.name)) continue
      try {
        const manifest = JSON.parse(await readFile(join(root, entry.name, 'manifest.json'), 'utf8')) as CheckpointManifest
        if (isCheckpointManifest(manifest)) checkpoints.push(toCheckpoint(manifest))
      } catch {
        // 不完整 checkpoint 不應阻斷其他安全 checkpoint。
      }
    }
    return checkpoints.sort((left, right) => right.createdAt - left.createdAt)
  }

  async create(name?: string, options: CreateCheckpointOptions = {}): Promise<Checkpoint> {
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
    const packaged = await packageProjectAsZip(this.projectRoot)
    const checkpointDir = this.checkpointDirectory(id)
    const temporaryDirectory = `${checkpointDir}.tmp-${randomBytes(3).toString('hex')}`
    const manifest: CheckpointManifest = {
      createdAt: Date.now(), fileCount: packaged.fileCount, id, name: checkpointName(name),
      sizeBytes: packaged.buffer.length, skippedCount: packaged.skippedCount, source: options.source ?? 'manual',
    }
    await mkdir(temporaryDirectory, { recursive: true })
    try {
      await writeFile(join(temporaryDirectory, 'snapshot.zip'), packaged.buffer, { flag: 'wx' })
      await writeFile(join(temporaryDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
      // ZIP 與 manifest 都完成後才使 checkpoint 可見。
      await rename(temporaryDirectory, checkpointDir)
    } catch (error) {
      await rm(temporaryDirectory, { force: true, recursive: true })
      throw error
    }
    console.info(`[cairn:checkpoint] 已建立 ${id} (${manifest.fileCount} files, ${manifest.source})`)
    return toCheckpoint(manifest)
  }

  async compare(id: string): Promise<CheckpointComparison> {
    const [checkpoint, targetEntries, currentEntries] = await Promise.all([
      this.readCheckpoint(id), this.readCheckpointEntries(id), this.currentEntries(),
    ])
    return makeComparison(checkpoint, targetEntries, currentEntries)
  }

  async readComparisonFile(id: string, requestedPath: string): Promise<CheckpointFileContents> {
    const path = this.assertRelativePath(requestedPath)
    const [targetFiles, currentEntries] = await Promise.all([this.readCheckpointFiles(id), this.currentEntries()])
    const targetEntries = new Map([...targetFiles].map(([path, entry]) => [path, entry.content]))
    const checkpointContent = targetEntries.get(path)
    const currentContent = currentEntries.get(path)
    if (!checkpointContent && !currentContent) throw new Error(`Checkpoint file not found: ${path}`)
    const binary = isBinaryPath(path, checkpointContent ?? currentContent!)
    return {
      binary,
      checkpointContent: binary || !checkpointContent ? undefined : checkpointContent.toString('utf8'),
      currentContent: binary || !currentContent ? undefined : currentContent.toString('utf8'),
      path,
    }
  }

  /** 呼叫端必須先建立 recovery checkpoint；此方法只處理受 snapshot 管理的檔案。 */
  async restore(id: string, expectedCurrentRevision?: string): Promise<{ removed: number; restored: number }> {
    const [targetFiles, currentEntries] = await Promise.all([this.readCheckpointFiles(id), this.currentEntries()])
    const targetEntries = new Map([...targetFiles].map(([path, entry]) => [path, entry.content]))
    assertNoCaseCollisions(
      [...targetEntries.keys(), ...currentEntries.keys()],
      this.options.caseInsensitiveFilesystem ?? await isCaseInsensitiveFilesystem(this.projectRoot),
    )
    const currentRevision = revisionFor(currentEntries)
    if (expectedCurrentRevision && expectedCurrentRevision !== currentRevision) {
      throw new Error('Project changed since the restore preview. Review the checkpoint again.')
    }

    let removed = 0
    let restored = 0
    const failedFiles: string[] = []
    for (const path of currentEntries.keys()) {
      if (targetEntries.has(path)) continue
      try {
        await unlink(await resolveSafeProjectPath(this.projectRoot, this.assertRelativePath(path)))
        removed += 1
      } catch (error) {
        failedFiles.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [path, content] of targetEntries) {
      try {
        if (currentEntries.get(path)?.equals(content)) {
          await restoreExecutableMode(
            await resolveSafeProjectPath(this.projectRoot, this.assertRelativePath(path)),
            targetFiles.get(path)?.mode ?? '100644',
          )
          continue
        }
        const destination = await prepareSafeProjectWritePath(this.projectRoot, this.assertRelativePath(path))
        await writeFile(destination, content)
        await restoreExecutableMode(destination, targetFiles.get(path)?.mode ?? '100644')
        restored += 1
      } catch (error) {
        failedFiles.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failedFiles.length > 0) {
      throw new Error(`Checkpoint restore was incomplete. Failed files: ${failedFiles.join('; ')}`)
    }
    console.info(`[cairn:checkpoint] 已恢復 ${id} (written ${restored}, removed ${removed})`)
    return { removed, restored }
  }

  async delete(id: string): Promise<void> { await rm(this.checkpointDirectory(id), { force: true, recursive: true }) }

  async has(id: string): Promise<boolean> {
    return isCheckpointId(id) && existsSync(join(this.checkpointDirectory(id), 'snapshot.zip'))
  }

  private async currentEntries(): Promise<Map<string, Buffer>> {
    const packaged = await packageProjectAsZip(this.projectRoot)
    return readZipEntries(packaged.buffer)
  }

  private async readCheckpoint(id: string): Promise<Checkpoint> {
    try {
      const manifest = JSON.parse(await readFile(join(this.checkpointDirectory(id), 'manifest.json'), 'utf8')) as CheckpointManifest
      if (!isCheckpointManifest(manifest)) throw new Error('invalid manifest')
      return toCheckpoint(manifest)
    } catch (error) {
      throw new Error(`Checkpoint not found: ${id}`, { cause: error })
    }
  }

  private async readCheckpointEntries(id: string): Promise<Map<string, Buffer>> {
    await this.readCheckpoint(id)
    return readZipEntries(await readFile(join(this.checkpointDirectory(id), 'snapshot.zip')))
  }

  private async readCheckpointFiles(id: string) {
    await this.readCheckpoint(id)
    return readZipEntryContents(await readFile(join(this.checkpointDirectory(id), 'snapshot.zip')))
  }

  private assertRelativePath(path: string): string {
    return assertSafeProjectRelativePath(path)
  }

  private checkpointDirectory(id: string): string {
    if (!isCheckpointId(id)) throw new Error(`Invalid checkpoint id: ${id}`)
    return join(this.checkpointsRoot(), id)
  }

  private checkpointsRoot(): string { return join(this.projectRoot, '.cairn', 'checkpoints') }
}

async function restoreExecutableMode(path: string, mode: '100644' | '100755'): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, mode === '100755' ? 0o755 : 0o644)
}

function checkpointName(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) return `Checkpoint · ${new Date().toISOString()}`
  if (name.length > 100) throw new Error('Checkpoint name too long')
  return name.trim()
}

function makeComparison(checkpoint: Checkpoint, target: Map<string, Buffer>, current: Map<string, Buffer>): CheckpointComparison {
  const summary = { added: 0, deleted: 0, modified: 0, unchanged: 0 }
  const files = [...new Set([...target.keys(), ...current.keys()])].sort((left, right) => left.localeCompare(right)).map((path) => {
    const checkpointContent = target.get(path)
    const currentContent = current.get(path)
    const status: CheckpointFileStatus = !checkpointContent ? 'added' : !currentContent ? 'deleted' : checkpointContent.equals(currentContent) ? 'unchanged' : 'modified'
    summary[status] += 1
    return { binary: isBinaryPath(path, checkpointContent ?? currentContent!), checkpointSize: checkpointContent?.length, currentSize: currentContent?.length, path, status }
  })
  return { checkpoint, currentRevision: revisionFor(current), files, summary }
}

function revisionFor(entries: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const path of [...entries.keys()].sort((left, right) => left.localeCompare(right))) {
    hash.update(path).update('\0').update(createHash('sha256').update(entries.get(path)!).digest())
  }
  return hash.digest('hex')
}

function isBinaryPath(path: string, content: Buffer): boolean {
  return !TEXT_EXTENSIONS.has(extname(path).toLowerCase()) && content.includes(0)
}

function isCheckpointId(id: string): boolean { return /^\d{13}-[a-f\d]{8}$/u.test(id) }

function isCheckpointManifest(value: unknown): value is CheckpointManifest {
  return typeof value === 'object' && value !== null
    && typeof (value as CheckpointManifest).id === 'string'
    && typeof (value as CheckpointManifest).name === 'string'
    && typeof (value as CheckpointManifest).createdAt === 'number'
    && typeof (value as CheckpointManifest).sizeBytes === 'number'
    && typeof (value as CheckpointManifest).fileCount === 'number'
}

function toCheckpoint(manifest: CheckpointManifest): Checkpoint {
  const { createdAt, fileCount, id, name, sizeBytes } = manifest
  return { createdAt, fileCount, id, name, sizeBytes, source: manifest.source ?? 'manual' }
}
