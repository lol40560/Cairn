import { describe, expect, it } from 'vitest'
import { createDemoWorkspace } from './demoWorkspace'

describe('demo workspace', () => {
  it('builds the deterministic base workspace and scenario files', () => {
    expect(createDemoWorkspace('ready').listFiles()).toHaveLength(6)
    expect(createDemoWorkspace('ai-change').readFile('src/api.ts')?.content).toContain('8000')
  })
  it('compares and restores only in memory with a safety checkpoint', () => {
    const workspace = createDemoWorkspace('recovery')
    const checkpoint = workspace.listCheckpoints()[0]!
    workspace.saveFile('src/api.ts', 'broken')
    expect(workspace.compareCheckpoint(checkpoint.id)).toContainEqual({ path: 'src/api.ts', status: 'modified' })
    const safety = workspace.restoreCheckpoint(checkpoint.id)
    expect(safety.source).toBe('auto-before-restore')
    expect(workspace.readFile('src/api.ts')?.content).toContain('8000')
  })
})
