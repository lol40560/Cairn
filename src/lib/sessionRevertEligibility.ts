import type { ActivitySession } from '@/lib/activitySessions'
import type { Op } from '@/types/cairn'

export type SessionRevertBlockReason = 'changed-later' | 'unresolved-conflict' | 'unsaved-editor' | 'missing-history' | 'binary-file'

export interface SessionRevertEligibility {
  blockedFiles: Array<{ path: string; reason: SessionRevertBlockReason }>
  reasons: SessionRevertBlockReason[]
  safe: boolean
  safeFiles: string[]
}

/**
 * 僅判斷是否可以「考慮」回滾；目前 op diff 並不足以安全做三方還原，
 * 因此任何風險都明確阻斷，且不提供 force 路徑。
 */
export function getSessionRevertEligibility(
  session: ActivitySession,
  allOps: Op[],
  options: { binaryPaths?: Iterable<string>; conflictPaths?: Iterable<string>; dirtyPaths?: Iterable<string> } = {},
): SessionRevertEligibility {
  const binaryPaths = new Set(options.binaryPaths)
  const conflictPaths = new Set(options.conflictPaths)
  const dirtyPaths = new Set(options.dirtyPaths)
  const sessionHashes = new Set(session.operations.map((op) => op.hash))
  const blockedFiles: Array<{ path: string; reason: SessionRevertBlockReason }> = []
  const safeFiles: string[] = []

  for (const path of session.filePaths) {
    const laterChange = allOps.some((op) => !sessionHashes.has(op.hash) && op.filePath === path && op.timestamp > session.endedAt)
    const reason: SessionRevertBlockReason | undefined = dirtyPaths.has(path) ? 'unsaved-editor'
      : conflictPaths.has(path) ? 'unresolved-conflict'
        : binaryPaths.has(path) ? 'binary-file'
          : laterChange ? 'changed-later'
            : session.operations.some((op) => !op.diff) ? 'missing-history'
              : undefined
    if (reason) blockedFiles.push({ path, reason })
    else safeFiles.push(path)
  }
  const reasons = [...new Set(blockedFiles.map((entry) => entry.reason))]
  return { blockedFiles, reasons, safe: blockedFiles.length === 0, safeFiles }
}
