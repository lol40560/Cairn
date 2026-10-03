import type { Op } from '@/types/cairn'

import { countDiff } from './diffStats'

export interface FileGroup {
  filePath: string
  ops: Op[]
  lastModified: number
  totalAdded: number
  totalRemoved: number
  totalOps: number
  authors: string[]
}

/** 將變更依檔案彙整，讓檔案而非單一事件成為主要瀏覽單位。 */
export function groupOpsByFile(ops: Op[]): FileGroup[] {
  const operationsByFile = new Map<string, Op[]>()

  for (const op of ops) {
    const fileOps = operationsByFile.get(op.filePath)
    if (fileOps) fileOps.push(op)
    else operationsByFile.set(op.filePath, [op])
  }

  const groups: FileGroup[] = []
  for (const [filePath, fileOps] of operationsByFile) {
    const sortedOps = [...fileOps].sort((left, right) => right.timestamp - left.timestamp)
    const authors = new Set<string>()
    let totalAdded = 0
    let totalRemoved = 0

    for (const op of sortedOps) {
      const stats = countDiff(op.diff)
      totalAdded += stats.added
      totalRemoved += stats.removed
      authors.add(op.author)
    }

    groups.push({
      authors: [...authors],
      filePath,
      lastModified: sortedOps[0]?.timestamp ?? 0,
      ops: sortedOps,
      totalAdded,
      totalOps: sortedOps.length,
      totalRemoved,
    })
  }

  return groups.sort((left, right) => right.lastModified - left.lastModified)
}
