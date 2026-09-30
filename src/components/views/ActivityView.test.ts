import { describe, expect, it } from 'vitest'

import { formatLineCount } from '@/lib/lineCount'

describe('formatLineCount', () => {
  it('保留小于一千的完整数字', () => {
    expect(formatLineCount(999)).toBe('999')
  })

  it('将一千到九千九百九十九格式化为一位小数的 k', () => {
    expect(formatLineCount(2_007)).toBe('2.0k')
    expect(formatLineCount(3_709)).toBe('3.7k')
  })

  it('将一万以上格式化为整数 k', () => {
    expect(formatLineCount(12_499)).toBe('12k')
    expect(formatLineCount(12_500)).toBe('13k')
  })
})
