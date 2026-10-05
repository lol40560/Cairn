import { describe, expect, it } from 'vitest'

import { contributorKind, recentFileContributors, recentRemoteContributors, RECENT_COLLABORATION_WINDOW_MS } from '@/lib/collaboration'
import type { Op } from '@/types/cairn'

const now = 1_000_000

function op(overrides: Partial<Op> = {}): Op {
  return {
    author: 'You',
    diff: '',
    filePath: 'src/auth.ts',
    hash: crypto.randomUUID(),
    id: crypto.randomUUID(),
    parentHashes: [],
    source: 'local',
    timestamp: now,
    ...overrides,
  }
}

describe('collaboration presence helpers', () => {
  it('attributes local, remote, and explicitly named AI operations safely', () => {
    expect(contributorKind(op())).toBe('me')
    expect(contributorKind(op({ author: 'Alice', source: 'remote' }))).toBe('teammate')
    expect(contributorKind(op({ author: 'Cursor', source: 'remote' }))).toBe('ai')
  })

  it('keeps the newest recent operation for every contributor on a file', () => {
    const contributors = recentFileContributors([
      op({ author: 'Alice', source: 'remote', timestamp: now - 4_000 }),
      op({ author: 'Alice', source: 'remote', timestamp: now - 1_000 }),
      op({ author: 'Cursor', source: 'remote', timestamp: now - 2_000 }),
      op({ author: 'Bob', filePath: 'src/other.ts', source: 'remote' }),
    ], 'src/auth.ts', now)

    expect(contributors).toEqual([
      expect.objectContaining({ author: 'Alice', lastChangedAt: now - 1_000 }),
      expect.objectContaining({ author: 'Cursor', kind: 'ai' }),
    ])
  })

  it('expires stale activity and returns only remote contributors for file indicators', () => {
    const ops = [
      op({ author: 'You', source: 'local' }),
      op({ author: 'Alice', source: 'remote', timestamp: now - 10_000 }),
      op({ author: 'Old peer', source: 'remote', timestamp: now - RECENT_COLLABORATION_WINDOW_MS - 1 }),
    ]

    expect(recentRemoteContributors(ops, 'src/auth.ts', now)).toEqual([
      expect.objectContaining({ author: 'Alice' }),
    ])
    expect(recentRemoteContributors(ops, 'src/other.ts', now)).toEqual([])
  })
})
