import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'
import { prepareSafeProjectWritePath, resolveSafeProjectPath } from '../fs/project-path'

export interface ConflictRecord {
  filePath: string
  opHash: string
  author: string
  timestamp: number
  baseContent?: string
  localContent: string
  remoteContent?: string
  mergedWithMarkers?: string
}

export type ConflictResolution = 'local' | 'remote' | 'merged'

/** 持久化冲突的双方内容，任何自动合并失败都不会覆盖主文件。 */
export class ConflictsManager {
  private readonly root: string

  constructor(private readonly projectRoot: string) {
    this.root = join(ensureCairnDataDir(projectRoot), 'conflicts')
  }

  async save(record: ConflictRecord): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.pathFor(record.opHash), JSON.stringify(record), 'utf8')
  }

  async list(): Promise<ConflictRecord[]> {
    try {
      const entries = await readdir(this.root)
      const records = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readPath(join(this.root, entry))))
      return records
        .filter((record): record is ConflictRecord => record !== undefined)
        .sort((left, right) => right.timestamp - left.timestamp)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async get(opHash: string): Promise<ConflictRecord | undefined> {
    return this.readPath(this.pathFor(opHash))
  }

  async resolve(opHash: string, resolution: ConflictResolution, content?: string): Promise<void> {
    const record = await this.get(opHash)
    if (!record) throw new Error(`找不到冲突记录：${opHash}`)
    await this.projectPath(record.filePath)

    if (resolution === 'remote') {
      if (record.remoteContent === undefined) throw new Error('冲突记录缺少远端内容')
      await writeFile(await prepareSafeProjectWritePath(this.projectRoot, record.filePath), record.remoteContent, 'utf8')
    }
    if (resolution === 'merged') {
      if (content === undefined) throw new Error('合并解决方案必须提供内容')
      await writeFile(await prepareSafeProjectWritePath(this.projectRoot, record.filePath), content, 'utf8')
    }

    await rm(await resolveSafeProjectPath(this.projectRoot, `${record.filePath}.cairn-remote`), { force: true })
    await this.delete(opHash)
  }

  async delete(opHash: string): Promise<void> {
    await rm(this.pathFor(opHash), { force: true })
  }

  private async readPath(filePath: string): Promise<ConflictRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      return isConflictRecord(parsed) ? parsed : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private pathFor(opHash: string): string {
    if (!/^[a-f0-9]{64}$/i.test(opHash)) throw new Error(`冲突 op hash 非法：${opHash}`)
    return join(this.root, `${opHash}.json`)
  }

  private async projectPath(relativePath: string): Promise<string> {
    return resolveSafeProjectPath(this.projectRoot, relativePath)
  }
}

function isConflictRecord(value: unknown): value is ConflictRecord {
  return typeof value === 'object' && value !== null
    && 'filePath' in value && 'opHash' in value && 'author' in value
    && 'timestamp' in value && 'localContent' in value
    && typeof value.filePath === 'string' && typeof value.opHash === 'string'
    && typeof value.author === 'string' && typeof value.timestamp === 'number'
    && typeof value.localContent === 'string'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
