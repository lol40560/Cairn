import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'
import type { Op } from '../oplog'

export interface PendingOp {
  op: Op
  failedAt: number
  attempts: number
}

/**
 * 保存暂时缺少基线内容的远端操作。
 *
 * 快照尚未下载完成时，修改操作不能安全地套用到空文件；保留它们，
 * 等文件基线出现后再尝试，避免把正常的时序问题展示成冲突。
 */
export class PendingOps {
  private readonly root: string

  constructor(projectRoot: string) {
    this.root = join(ensureCairnDataDir(projectRoot), 'pending')
  }

  async add(op: Op): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const existing = await this.read(op.hash)
    const entry: PendingOp = {
      op,
      failedAt: existing?.failedAt ?? Date.now(),
      attempts: (existing?.attempts ?? 0) + 1,
    }
    await writeFile(this.pathFor(op.hash), JSON.stringify(entry), 'utf8')
  }

  async list(): Promise<PendingOp[]> {
    try {
      const names = await readdir(this.root)
      const entries = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => this.readPath(join(this.root, name))),
      )
      return entries
        .filter((entry): entry is PendingOp => entry !== undefined)
        .sort((left, right) => left.failedAt - right.failedAt)
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
  }

  async remove(opHash: string): Promise<void> {
    await rm(this.pathFor(opHash), { force: true })
  }

  async retryAll(applyFn: (op: Op) => Promise<boolean>): Promise<void> {
    // list() 先回傳快照，後續 remove 不會影響尚未處理的 entry。
    const entries = await this.list()
    for (const entry of entries) {
      try {
        if (await applyFn(entry.op)) {
          await this.remove(entry.op.hash)
        }
      } catch (error) {
        // 保留失敗 entry，讓下一次基線或 blob 到達後仍可安全重試。
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[cairn:sync] 待重試操作失敗，將保留：${entry.op.hash.slice(0, 12)} (${detail})`)
      }
    }
  }

  private async read(opHash: string): Promise<PendingOp | undefined> {
    return this.readPath(this.pathFor(opHash))
  }

  private async readPath(filePath: string): Promise<PendingOp | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (!isPendingOp(parsed)) {
        console.warn(`[cairn:sync] 忽略无效待重试操作：${filePath}`)
        return undefined
      }
      return parsed
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }
      console.warn(`[cairn:sync] 无法读取待重试操作：${filePath}`, error)
      return undefined
    }
  }

  private pathFor(opHash: string): string {
    return join(this.root, `${opHash}.json`)
  }
}

function isPendingOp(value: unknown): value is PendingOp {
  return typeof value === 'object'
    && value !== null
    && 'op' in value
    && 'failedAt' in value
    && 'attempts' in value
    && typeof value.failedAt === 'number'
    && typeof value.attempts === 'number'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
