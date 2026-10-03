import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractZipBuffer } from '../snapshot/extract'
import { packageProjectAsZip } from '../snapshot/export'

export interface Checkpoint {
  createdAt: number
  fileCount: number
  id: string
  name: string
  sizeBytes: number
}

interface CheckpointManifest extends Checkpoint {
  skippedCount: number
}

/** 管理本機專案的可命名完整快照；不含任何網路傳輸邏輯。 */
export class CheckpointManager {
  constructor(private readonly projectRoot: string) {}

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
        // 損毀或不完整的 checkpoint 不應阻斷其他 checkpoint 的使用。
      }
    }
    return checkpoints.sort((left, right) => right.createdAt - left.createdAt)
  }

  async create(name: string): Promise<Checkpoint> {
    const trimmedName = validateName(name)
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
    const packaged = await packageProjectAsZip(this.projectRoot)
    const checkpointDir = this.checkpointDirectory(id)
    await mkdir(checkpointDir, { recursive: true })

    const manifest: CheckpointManifest = {
      createdAt: Date.now(),
      fileCount: packaged.fileCount,
      id,
      name: trimmedName,
      sizeBytes: packaged.buffer.length,
      skippedCount: packaged.skippedCount,
    }
    await writeFile(join(checkpointDir, 'snapshot.zip'), packaged.buffer, { flag: 'wx' })
    await writeFile(join(checkpointDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
    return toCheckpoint(manifest)
  }

  async restore(id: string): Promise<{ restored: number }> {
    const zipPath = join(this.checkpointDirectory(id), 'snapshot.zip')
    if (!existsSync(zipPath)) throw new Error(`Checkpoint not found: ${id}`)

    const buffer = await readFile(zipPath)
    for (const entry of await readdir(this.projectRoot)) {
      // 保留協作資料與使用者既有 Git 歷史。
      if (entry === '.cairn' || entry === '.git') continue
      await rm(join(this.projectRoot, entry), { force: true, recursive: true })
    }

    let restored = 0
    await extractZipBuffer(buffer, this.projectRoot, {
      onFile: () => { restored += 1 },
      overwrite: true,
      skip: (relativePath) => relativePath === '.cairn' || relativePath.startsWith('.cairn/'),
    })
    return { restored }
  }

  async delete(id: string): Promise<void> {
    await rm(this.checkpointDirectory(id), { force: true, recursive: true })
  }

  async has(id: string): Promise<boolean> {
    if (!isCheckpointId(id)) return false
    return existsSync(join(this.checkpointDirectory(id), 'snapshot.zip'))
  }

  private checkpointDirectory(id: string): string {
    if (!isCheckpointId(id)) throw new Error(`Invalid checkpoint id: ${id}`)
    return join(this.checkpointsRoot(), id)
  }

  private checkpointsRoot(): string {
    return join(this.projectRoot, '.cairn', 'checkpoints')
  }
}

function validateName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('Checkpoint name is required')
  if (name.length > 100) throw new Error('Checkpoint name too long')
  return name.trim()
}

function isCheckpointId(id: string): boolean {
  return /^\d{13}-[a-f\d]{8}$/u.test(id)
}

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
  return { createdAt, fileCount, id, name, sizeBytes }
}
