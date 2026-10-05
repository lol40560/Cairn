import { contributorKind, type ContributorKind } from '@/lib/collaboration'
import { countDiff } from '@/lib/diffStats'
import type { Op } from '@/types/cairn'

/** 同一作者连续工作之间允许的最长空档；与「近期协作」时间窗刻意分离。 */
export const ACTIVITY_SESSION_GAP_MS = 5 * 60_000

export interface ActivitySession {
  id: string
  author: string
  attribution: ContributorKind
  startedAt: number
  endedAt: number
  durationMs: number
  operations: Op[]
  filePaths: string[]
  operationCount: number
  fileCount: number
  totalAdded: number
  totalRemoved: number
}

interface MutableSession {
  author: string
  attribution: ContributorKind
  endedAt: number
  filePaths: string[]
  filePathSet: Set<string>
  firstOpHash: string
  operations: Op[]
  startedAt: number
  totalAdded: number
  totalRemoved: number
}

function compareChronologically(left: Op, right: Op): number {
  return left.timestamp - right.timestamp || left.hash.localeCompare(right.hash)
}

function canExtend(session: MutableSession, op: Op): boolean {
  return session.author === op.author
    && session.attribution === contributorKind(op)
    && op.timestamp - session.endedAt <= ACTIVITY_SESSION_GAP_MS
}

function addOperation(session: MutableSession, op: Op): void {
  session.operations.push(op)
  session.endedAt = Math.max(session.endedAt, op.timestamp)
  if (!session.filePathSet.has(op.filePath)) {
    session.filePathSet.add(op.filePath)
    session.filePaths.push(op.filePath)
  }
  const stats = countDiff(op.diff)
  session.totalAdded += stats.added
  session.totalRemoved += stats.removed
}

function finalize(session: MutableSession): ActivitySession {
  return {
    attribution: session.attribution,
    author: session.author,
    durationMs: Math.max(0, session.endedAt - session.startedAt),
    endedAt: session.endedAt,
    fileCount: session.filePaths.length,
    filePaths: session.filePaths,
    // 第一条 op 的 hash 是对相同输入稳定的可恢复引用。
    id: `session:${session.firstOpHash}`,
    operationCount: session.operations.length,
    operations: session.operations,
    startedAt: session.startedAt,
    totalAdded: session.totalAdded,
    totalRemoved: session.totalRemoved,
  }
}

/**
 * 以时间正序线性扫描：作者或来源改变、或超过空档阈值时开启新工作段。
 * 返回值按最新 session 在前，适配 Activity 的阅读顺序。
 */
export function groupActivitySessions(ops: Op[]): ActivitySession[] {
  const chronological = [...ops].sort(compareChronologically)
  const sessions: ActivitySession[] = []
  let current: MutableSession | undefined

  for (const op of chronological) {
    if (!current || !canExtend(current, op)) {
      if (current) sessions.push(finalize(current))
      const stats = countDiff(op.diff)
      current = {
        attribution: contributorKind(op),
        author: op.author,
        endedAt: op.timestamp,
        filePaths: [op.filePath],
        filePathSet: new Set([op.filePath]),
        firstOpHash: op.hash,
        operations: [op],
        startedAt: op.timestamp,
        totalAdded: stats.added,
        totalRemoved: stats.removed,
      }
      continue
    }
    addOperation(current, op)
  }

  if (current) sessions.push(finalize(current))
  return sessions.sort((left, right) => right.endedAt - left.endedAt || right.id.localeCompare(left.id))
}
