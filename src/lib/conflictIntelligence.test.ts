import { describe, expect, it } from 'vitest'
import { getConflictRisk, parseUnifiedDiffRanges, rangesOverlap } from './conflictIntelligence'
import type { Op } from '@/types/cairn'

const now = 1_000_000
const op = (overrides: Partial<Op> = {}): Op => ({ id: 'id', hash: Math.random().toString(16), author: 'Me', parentHashes: [], timestamp: now, filePath: 'src/auth.ts', diff: '@@ -10,2 +10,2 @@\n-a\n+b', source: 'local', ...overrides })

describe('conflict intelligence', () => {
  it('parses and compares hunk ranges', () => {
    expect(parseUnifiedDiffRanges('@@ -24,13 +24,12 @@')).toEqual([{ start: 24, end: 36 }])
    expect(rangesOverlap({ start: 24, end: 36 }, { start: 31, end: 42 })).toBe(true)
    expect(rangesOverlap({ start: 24, end: 36 }, { start: 37, end: 42 })).toBe(false)
  })
  it('does not warn for one contributor or another file', () => {
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: [op()], conflicts: [], now }).level).toBe('none')
    expect(getConflictRisk({ filePath: 'src/other.ts', ops: [op()], conflicts: [], now }).level).toBe('none')
  })
  it('marks shared recent activity without claiming conflict', () => {
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: [op(), op({ author: 'Alice', source: 'remote', baseHash: 'same', diff: '@@ -80,2 +80,2 @@' }), op({ baseHash: 'same' })], conflicts: [], now }).level).toBe('shared-recent')
  })
  it('uses divergent bases as evidence but expires ordinary recent activity', () => {
    const divergent = getConflictRisk({ filePath: 'src/auth.ts', ops: [op({ baseHash: 'one' }), op({ author: 'Alice', source: 'remote', baseHash: 'two' })], conflicts: [], now })
    expect(divergent).toMatchObject({ level: 'potential-overlap', reasons: ['divergent-base'] })
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: [op(), op({ author: 'Alice', source: 'remote' })], conflicts: [], now: now + 5 * 60_000 + 1 }).level).toBe('none')
  })
  it('keeps non-overlapping compatible hunks at the informational level', () => {
    const risk = getConflictRisk({ filePath: 'src/auth.ts', ops: [op({ baseHash: 'base', diff: '@@ -24,13 +24,13 @@' }), op({ author: 'Cursor', source: 'remote', baseHash: 'base', diff: '@@ -80,2 +80,2 @@' })], conflicts: [], now })
    expect(risk.level).toBe('shared-recent')
    expect(risk.contributors).toEqual(expect.arrayContaining(['Me', 'Cursor']))
  })
  it('uses dirty local and compatible overlapping hunks as stronger evidence', () => {
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: [op(), op({ author: 'Alice', source: 'remote' })], conflicts: [], dirty: true, now }).level).toBe('potential-overlap')
    const risk = getConflictRisk({ filePath: 'src/auth.ts', ops: [op({ baseHash: 'base' }), op({ author: 'Alice', source: 'remote', baseHash: 'base', diff: '@@ -11,2 +11,2 @@' })], conflicts: [], now })
    expect(risk.reasons).toContain('overlapping-range')
  })
  it('lets confirmed conflicts override expiry and all pre-conflict signals', () => {
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: [], conflicts: [{ filePath: 'src/auth.ts', opHash: 'a'.repeat(64), author: 'Alice', timestamp: 1, localContent: '' }], now: now + 99_999_999 }).level).toBe('confirmed-conflict')
  })
})
