import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'

export interface TrashEntry {
  trashId: string
  originalPath: string
  deletedAt: number
  author: string
  opHash: string
  sizeBytes: number
}

/** 管理项目内可恢复的已删除文件。 */
export class TrashManager {
  private readonly projectRoot: string
  private readonly trashRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
    this.trashRoot = join(ensureCairnDataDir(projectRoot), 'trash')
  }

  /**
   * 将源文件移动到废纸篓。watcher 收到 unlink 时源文件已经不存在，
   * 此时由 baselineContent 写入原始内容，仍可保证删除可恢复。
   */
  async moveToTrash(
    relativePath: string,
    absolutePath: string,
    author: string,
    opHash: string,
    baselineContent?: string | Buffer,
  ): Promise<string> {
    const originalPath = this.assertSafeRelativePath(relativePath)
    const expectedSourcePath = this.projectPath(originalPath)
    if (resolve(absolutePath) !== expectedSourcePath) {
      throw new Error(`废纸篓源文件路径不匹配：${absolutePath}`)
    }
    const trashId = `${Date.now()}-${randomBytes(4).toString('hex')}`
    const entryDirectory = this.entryDirectory(trashId)
    const contentPath = join(entryDirectory, 'content')
    const deletedAt = Date.now()

    await mkdir(entryDirectory, { recursive: true })
    try {
      if (existsSync(absolutePath)) {
        await rename(absolutePath, contentPath)
      } else if (baselineContent !== undefined) {
        await writeFile(contentPath, baselineContent)
      } else {
        throw new Error(`无法移入废纸篓，原始文件不存在：${originalPath}`)
      }

      const sizeBytes = (await stat(contentPath)).size
      const entry: TrashEntry = { trashId, originalPath, deletedAt, author, opHash, sizeBytes }
      await writeFile(join(entryDirectory, 'meta.json'), JSON.stringify(entry), 'utf8')
      return trashId
    } catch (error) {
      await rm(entryDirectory, { force: true, recursive: true })
      throw error
    }
  }

  /** 按删除时间倒序列出有效条目，并跳过损坏的元数据。 */
  async list(): Promise<TrashEntry[]> {
    if (!existsSync(this.trashRoot)) return []

    const entries = await readdir(this.trashRoot, { withFileTypes: true })
    const result = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        return this.readEntry(entry.name)
      } catch (error) {
        console.warn(`[cairn:trash] 跳过无效废纸篓条目 ${entry.name}`, error)
        return undefined
      }
    }))
    return result
      .filter((entry): entry is TrashEntry => entry !== undefined)
      .sort((left, right) => right.deletedAt - left.deletedAt)
  }

  /** 恢复条目；目标路径被占用时绝不覆盖。 */
  async restore(trashId: string): Promise<void> {
    const entry = await this.readEntry(trashId)
    const targetPath = this.projectPath(entry.originalPath)
    if (existsSync(targetPath)) {
      throw new Error(`无法恢复：${entry.originalPath} 已存在`)
    }

    await mkdir(dirname(targetPath), { recursive: true })
    await rename(join(this.entryDirectory(trashId), 'content'), targetPath)
    await rm(this.entryDirectory(trashId), { force: true, recursive: true })
  }

  /** 永久移除一个条目。 */
  async purge(trashId: string): Promise<void> {
    this.assertTrashId(trashId)
    await rm(this.entryDirectory(trashId), { force: true, recursive: true })
  }

  /** 清理超过保留期的条目。 */
  async cleanup(maxAgeDays: number): Promise<number> {
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
      throw new Error(`废纸篓保留天数必须是非负整数，收到 ${maxAgeDays}`)
    }

    const threshold = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const staleEntries = (await this.list()).filter((entry) => entry.deletedAt < threshold)
    await Promise.all(staleEntries.map((entry) => this.purge(entry.trashId)))
    return staleEntries.length
  }

  private async readEntry(trashId: string): Promise<TrashEntry> {
    this.assertTrashId(trashId)
    const raw = JSON.parse(await readFile(join(this.entryDirectory(trashId), 'meta.json'), 'utf8')) as Partial<TrashEntry>
    if (
      raw.trashId !== trashId ||
      typeof raw.originalPath !== 'string' ||
      typeof raw.deletedAt !== 'number' ||
      typeof raw.author !== 'string' ||
      typeof raw.opHash !== 'string' ||
      typeof raw.sizeBytes !== 'number'
    ) {
      throw new Error(`废纸篓元数据无效：${trashId}`)
    }
    this.assertSafeRelativePath(raw.originalPath)
    return raw as TrashEntry
  }

  private entryDirectory(trashId: string): string {
    this.assertTrashId(trashId)
    return join(this.trashRoot, trashId)
  }

  private projectPath(relativePath: string): string {
    const targetPath = resolve(this.projectRoot, relativePath)
    if (targetPath === this.projectRoot || !targetPath.startsWith(`${this.projectRoot}${sep}`)) {
      throw new Error(`废纸篓路径越界：${relativePath}`)
    }
    return targetPath
  }

  private assertSafeRelativePath(relativePath: string): string {
    const normalized = relativePath.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (
      normalized.length === 0 ||
      isAbsolute(normalized) ||
      win32.isAbsolute(normalized) ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
      relative(this.projectRoot, this.projectPath(normalized)).startsWith('..')
    ) {
      throw new Error(`废纸篓路径非法：${relativePath}`)
    }
    return normalized
  }

  private assertTrashId(trashId: string): void {
    if (!/^\d+-[a-f0-9]{8}$/.test(trashId)) {
      throw new Error(`废纸篓条目 ID 非法：${trashId}`)
    }
  }
}
