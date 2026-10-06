import { describe, expect, it } from 'vitest'

import { ACTIVITY_SESSION_GAP_MS, groupActivitySessions } from '@/lib/activitySessions'
import type { Op } from '@/types/cairn'

function createOp(overrides: Partial<Op> = {}): Op {
  return {
    author: 'Alice',
    diff: '@@ -1 +1 @@\n-old\n+new',
    filePath: 'src/auth.ts',
    hash: `hash-${overrides.timestamp ?? 0}-${overrides.author ?? 'alice'}-${overrides.filePath ?? 'auth'}`,
    id: crypto.randomUUID(),
    parentHashes: [],
    source: 'remote',
    timestamp: 1_000,
    ...overrides,
  }
}

describe('groupActivitySessions', () => {
  it('groups a continuous author burst within the session gap', () => {
    const sessions = groupActivitySessions([
      createOp({ timestamp: 1_000 }),
      createOp({ filePath: 'src/api.ts', timestamp: 2_000 }),
      createOp({ timestamp: 3_000 }),
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ author: 'Alice', durationMs: 2_000, fileCount: 2, operationCount: 3 })
    expect(sessions[0]?.filePaths).toEqual(['src/auth.ts', 'src/api.ts'])
  })

  it('starts a new session when the inactivity gap is exactly exceeded', () => {
    const sessions = groupActivitySessions([
      createOp({ hash: 'first', timestamp: 1_000 }),
      createOp({ hash: 'second', timestamp: 1_000 + ACTIVITY_SESSION_GAP_MS + 1 }),
    ])

    expect(sessions.map((session) => session.id)).toEqual(['session:second', 'session:first'])
  })

  it('keeps operations exactly at the inactivity threshold in one session', () => {
    const sessions = groupActivitySessions([
      createOp({ hash: 'first', timestamp: 1_000 }),
      createOp({ hash: 'second', timestamp: 1_000 + ACTIVITY_SESSION_GAP_MS }),
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'session:first', operationCount: 2 })
  })

  it('keeps alternating authors as chronological separate workstreams', () => {
    const sessions = groupActivitySessions([
      createOp({ author: 'Alice', hash: 'a1', timestamp: 1_000 }),
      createOp({ author: 'Bob', hash: 'b1', timestamp: 2_000 }),
      createOp({ author: 'Alice', hash: 'a2', timestamp: 3_000 }),
    ])

    expect(sessions.map((session) => session.author)).toEqual(['Alice', 'Bob', 'Alice'])
    expect(sessions.map((session) => session.id)).toEqual(['session:a2', 'session:b1', 'session:a1'])
  })

  it('preserves Me, Teammate, and AI attribution and diff totals', () => {
    const sessions = groupActivitySessions([
      createOp({ author: 'You', hash: 'me', source: 'local', timestamp: 1_000 }),
      createOp({ author: 'Cursor', hash: 'ai', source: 'remote', timestamp: 2_000 }),
      createOp({ author: 'Alice', diff: '@@ -1 +1 @@\n-old\n+new\n+added', hash: 'team', source: 'remote', timestamp: 3_000 }),
    ])

    expect(sessions.map((session) => session.attribution)).toEqual(['teammate', 'ai', 'me'])
    expect(sessions[0]).toMatchObject({ totalAdded: 2, totalRemoved: 1 })
  })

  it('regression: legacy provenance is not attributed to me', () => {
    const sessions = groupActivitySessions([
      createOp({ hash: 'legacy', source: 'unknown', timestamp: 1_000 }),
    ])

    expect(sessions[0]?.attribution).toBe('unknown')
  })

  it('is stable for unordered input, empty input, and a large history', () => {
    const input = Array.from({ length: 400 }, (_, index) => createOp({
      filePath: `src/${index % 5}.ts`,
      hash: `op-${index}`,
      timestamp: index * 1_000,
    })).reverse()

    const once = groupActivitySessions(input)
    const twice = groupActivitySessions(input)
    expect(groupActivitySessions([])).toEqual([])
    expect(once).toHaveLength(1)
    expect(once).toEqual(twice)
    expect(once[0]?.operations.map((op) => op.timestamp)).toEqual([...once[0]!.operations].sort((left, right) => left.timestamp - right.timestamp).map((op) => op.timestamp))
  })
})
