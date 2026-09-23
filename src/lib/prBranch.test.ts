import { describe, expect, it } from 'vitest'

import { createPRBranchName } from './prBranch'

describe('createPRBranchName', () => {
  it('为每次导出使用不同的时间戳后缀', () => {
    expect(createPRBranchName('PEFSY8', 1000)).toBe('cairn-PEFSY8-1000')
    expect(createPRBranchName('PEFSY8', 1001)).toBe('cairn-PEFSY8-1001')
  })
})
