import { describe, expect, it } from 'vitest'

import { groupOpsByFile } from './groupOpsByFile'

function createOp(overrides: Partial<Parameters<typeof groupOpsByFile>[0][number]> = {}) {
  return {
    author: 'alice',
    diff: '@@ -1 +1 @@\n-old\n+new',
    filePath: 'src/app.ts',
    hash: crypto.randomUUID(),
    id: crypto.randomUUID(),
    parentHashes: [],
    timestamp: 100,
    ...overrides,
  }
}

describe('groupOpsByFile', () => {
  it('空数组返回空结果', () => {
    expect(groupOpsByFile([])).toEqual([])
  })

  it('將同一檔案的操作彙整並計算統計', () => {
    const groups = groupOpsByFile([
      createOp({ author: 'alice', timestamp: 100 }),
      createOp({ author: 'bob', diff: '@@ -1 +1 @@\n-old\n+new\n+added', timestamp: 300 }),
      createOp({ author: 'alice', timestamp: 200 }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ authors: ['bob', 'alice'], lastModified: 300, totalAdded: 4, totalOps: 3, totalRemoved: 3 })
    expect(groups[0]?.ops.map((op) => op.timestamp)).toEqual([300, 200, 100])
  })

  it('以最近一次變更排序不同檔案', () => {
    const groups = groupOpsByFile([
      createOp({ filePath: 'src/older.ts', timestamp: 10 }),
      createOp({ filePath: 'src/newer.ts', timestamp: 20 }),
    ])

    expect(groups.map((group) => group.filePath)).toEqual(['src/newer.ts', 'src/older.ts'])
  })
})
