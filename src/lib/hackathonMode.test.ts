import { describe, expect, it } from 'vitest'
import { DEMO_SCENES, getDemoScenario, sceneIndex } from './hackathonMode'
import { getConflictRisk } from './conflictIntelligence'

describe('hackathon scenario', () => {
  it('reconstructs deterministic simulation data without external state', () => {
    expect(getDemoScenario('ready', 1_700_000_005_000)).toEqual(getDemoScenario('ready', 1_700_000_005_000))
    expect(getDemoScenario('ai-change', 1_700_000_005_000).ops).toHaveLength(3)
  })
  it('feeds the real overlap classifier and real conflict shape', () => {
    const state = getDemoScenario('overlap', 1_700_000_005_000)
    expect(getConflictRisk({ filePath: 'src/auth.ts', ops: state.ops, conflicts: [], dirty: true, now: 1_700_000_005_000 }).level).toBe('potential-overlap')
    expect(getDemoScenario('conflict', 1_700_000_005_000).conflicts[0]?.remoteContent).toContain('timeout = 3000')
  })
  it('has a stable seven-scene order', () => {
    expect(DEMO_SCENES).toHaveLength(7)
    expect(sceneIndex('summary')).toBe(6)
  })
})
