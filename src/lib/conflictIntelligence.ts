import { RECENT_COLLABORATION_WINDOW_MS, recentFileContributors } from '@/lib/collaboration'
import type { ConflictRecord, Op } from '@/types/cairn'

/** 這些等級只描述已知風險，不會把單純同檔案協作誤報為衝突。 */
export type ConflictRiskLevel = 'none' | 'shared-recent' | 'potential-overlap' | 'confirmed-conflict'
export type ConflictRiskReason = 'same-file-recent' | 'dirty-local-and-remote' | 'overlapping-range' | 'divergent-base' | 'confirmed-conflict'

export interface LineRange { start: number; end: number }
export interface ConflictRisk {
  level: ConflictRiskLevel
  filePath: string
  contributors: string[]
  reasons: ConflictRiskReason[]
  latestActivityAt: number
  overlappingRanges?: LineRange[]
  conflictId?: string
}

export interface ConflictRiskInput {
  filePath: string
  ops: Op[]
  conflicts: ConflictRecord[]
  dirty?: boolean
  now?: number
}

/** 從 unified diff 的舊檔 hunk 讀取範圍；只有相同 base 的 hunk 才可比較。 */
export function parseUnifiedDiffRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = []
  const matcher = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/gm
  for (const match of diff.matchAll(matcher)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 0) continue
    // 插入點是零寬範圍，保留其位置以便精準比對相同插入點。
    ranges.push({ start, end: count === 0 ? start : start + count - 1 })
  }
  return ranges
}

export function rangesOverlap(left: LineRange, right: LineRange): boolean {
  return left.start <= right.end && right.start <= left.end
}

/** 集中推導檔案層級的協作／衝突訊號，供 Files 與 FileTree 共用。 */
export function getConflictRisk({ filePath, ops, conflicts, dirty = false, now = Date.now() }: ConflictRiskInput): ConflictRisk {
  const confirmed = conflicts.find((conflict) => conflict.filePath === filePath)
  if (confirmed) {
    return {
      level: 'confirmed-conflict', filePath, contributors: unique([confirmed.author]),
      reasons: ['confirmed-conflict'], latestActivityAt: confirmed.timestamp, conflictId: confirmed.opHash,
    }
  }

  const contributors = recentFileContributors(ops, filePath, now)
  const remoteOps = ops.filter((op) => op.filePath === filePath && op.source === 'remote' && op.timestamp >= now - RECENT_COLLABORATION_WINDOW_MS)
  const localOps = ops.filter((op) => op.filePath === filePath && op.source === 'local' && op.timestamp >= now - RECENT_COLLABORATION_WINDOW_MS)
  const names = contributors.map((contributor) => contributor.author)
  const latestActivityAt = contributors[0]?.lastChangedAt ?? 0
  if (remoteOps.length === 0) return { level: 'none', filePath, contributors: names, reasons: [], latestActivityAt }

  const reasons: ConflictRiskReason[] = []
  if (dirty) reasons.push('dirty-local-and-remote')

  const divergent = localOps.some((local) => remoteOps.some((remote) => Boolean(local.baseHash && remote.baseHash && local.baseHash !== remote.baseHash)))
  if (divergent) reasons.push('divergent-base')

  const overlaps: LineRange[] = []
  for (const local of localOps) {
    for (const remote of remoteOps) {
      // 不同 base 的行號不可安全比較；上方只會報 divergent-base。
      if (!local.baseHash || local.baseHash !== remote.baseHash) continue
      for (const left of parseUnifiedDiffRanges(local.diff)) {
        for (const right of parseUnifiedDiffRanges(remote.diff)) {
          if (rangesOverlap(left, right)) overlaps.push({ start: Math.max(left.start, right.start), end: Math.min(left.end, right.end) })
        }
      }
    }
  }
  if (overlaps.length > 0) reasons.push('overlapping-range')
  if (reasons.length > 0) return { level: 'potential-overlap', filePath, contributors: names, reasons, latestActivityAt, overlappingRanges: overlaps.length ? overlaps : undefined }

  const hasSharedActivity = contributors.length > 1 || (localOps.length > 0 && remoteOps.length > 0)
  return {
    level: hasSharedActivity ? 'shared-recent' : 'none', filePath, contributors: names,
    reasons: hasSharedActivity ? ['same-file-recent'] : [], latestActivityAt,
  }
}

export function remoteAuthorForRisk(ops: Op[], filePath: string, now = Date.now()): string | undefined {
  return ops
    .filter((op) => op.filePath === filePath && op.source === 'remote' && op.timestamp >= now - RECENT_COLLABORATION_WINDOW_MS)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.author
}

function unique(values: string[]): string[] { return [...new Set(values)] }
