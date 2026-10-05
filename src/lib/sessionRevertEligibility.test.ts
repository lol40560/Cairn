import { describe, expect, it } from 'vitest'

import { groupActivitySessions } from '@/lib/activitySessions'
import { getSessionRevertEligibility } from '@/lib/sessionRevertEligibility'
import type { Op } from '@/types/cairn'

function op(hash: string, path: string, timestamp: number, author = 'Cursor'): Op {
  return { author, diff: '@@ -1 +1 @@\n-old\n+new', filePath: path, hash, id: hash, parentHashes: [], source: 'remote', timestamp }
}

describe('getSessionRevertEligibility', () => {
  it('permits a session whose affected files have no later changes', () => {
    const operations = [op('first', 'src/a.ts', 1_000), op('second', 'src/b.ts', 2_000), op('other', 'src/c.ts', 3_000, 'Alice')]
    const session = groupActivitySessions(operations)[1]!
    expect(getSessionRevertEligibility(session, operations)).toMatchObject({ safe: true, safeFiles: ['src/a.ts', 'src/b.ts'] })
  })

  it('blocks a file changed later and never offers a force bypass', () => {
    const operations = [op('first', 'src/a.ts', 1_000), op('later', 'src/a.ts', 400_000)]
    const session = groupActivitySessions(operations)[1]!
    expect(getSessionRevertEligibility(session, operations)).toMatchObject({ safe: false, blockedFiles: [{ path: 'src/a.ts', reason: 'changed-later' }] })
  })

  it('blocks dirty editors and unresolved conflicts before considering history', () => {
    const operations = [op('first', 'src/a.ts', 1_000), op('second', 'src/b.ts', 2_000)]
    const session = groupActivitySessions(operations)[0]!
    const result = getSessionRevertEligibility(session, operations, { conflictPaths: ['src/b.ts'], dirtyPaths: ['src/a.ts'] })
    expect(result).toMatchObject({ safe: false, reasons: ['unsaved-editor', 'unresolved-conflict'] })
  })
})
