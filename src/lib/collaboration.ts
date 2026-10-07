import type { Op } from '@/types/cairn'

/**
 * 最近協作活動的唯一時間窗。它代表「剛剛有人動過這個檔案」，
 * 不代表對方目前正在編輯，因此 UI 不得將它描述成即時游標或鎖定狀態。
 */
export const RECENT_COLLABORATION_WINDOW_MS = 5 * 60_000

export type ContributorKind = 'me' | 'teammate' | 'ai' | 'unknown'

export interface RecentFileContributor {
  author: string
  kind: ContributorKind
  lastChangedAt: number
  source: Op['source']
}

/** 只根據 op 中已存在的作者名稱辨識明確標示的 AI 工具。 */
export function isAiAuthor(author: string): boolean {
  return /\b(cursor|claude|copilot|codex|chatgpt|gemini)\b/i.test(author)
}

export function contributorKind(op: Op): ContributorKind {
  if (isAiAuthor(op.author)) return 'ai'
  if (op.source === 'remote') return 'teammate'
  return op.source === 'local' ? 'me' : 'unknown'
}

export function recentFileContributors(
  ops: Op[],
  filePath: string,
  now = Date.now(),
): RecentFileContributor[] {
  const cutoff = now - RECENT_COLLABORATION_WINDOW_MS
  const latestByAuthor = new Map<string, RecentFileContributor>()

  for (const op of ops) {
    if (op.filePath !== filePath || op.timestamp < cutoff) continue
    const current = latestByAuthor.get(op.author)
    if (!current || op.timestamp > current.lastChangedAt) {
      latestByAuthor.set(op.author, {
        author: op.author,
        kind: contributorKind(op),
        lastChangedAt: op.timestamp,
        source: op.source,
      })
    }
  }

  return [...latestByAuthor.values()].sort((left, right) => right.lastChangedAt - left.lastChangedAt)
}

/** 遠端近期活動可作為同檔案重疊的非阻擋提示，但不是衝突判定。 */
export function recentRemoteContributors(ops: Op[], filePath: string, now = Date.now()): RecentFileContributor[] {
  return recentFileContributors(ops, filePath, now).filter((contributor) => contributor.source === 'remote')
}

export function hasRecentPotentialOverlap(ops: Op[], filePath: string, now = Date.now()): boolean {
  const contributors = recentFileContributors(ops, filePath, now)
  return contributors.some((contributor) => contributor.source === 'remote')
    && contributors.some((contributor) => contributor.source === 'local')
}
