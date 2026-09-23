import { describe, expect, it } from 'vitest'

import { countDiff } from './diffStats'

describe('countDiff', () => {
  it('空字符串返回零', () => {
    expect(countDiff('')).toEqual({ added: 0, removed: 0 })
  })

  it('忽略文件头与 hunk 元数据', () => {
    expect(countDiff('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@')).toEqual({
      added: 0,
      removed: 0,
    })
  })

  it('统计单个 hunk 的新增和删除行', () => {
    expect(
      countDiff('@@ -1,2 +1,2 @@\n keep\n-old value\n+new value'),
    ).toEqual({ added: 1, removed: 1 })
  })

  it('统计多个 hunk', () => {
    expect(
      countDiff(
        '@@ -1 +1 @@\n-old one\n+new one\n@@ -4 +4 @@\n-old two\n+new two',
      ),
    ).toEqual({ added: 2, removed: 2 })
  })

  it('不误统计前面有空格的加减号内容', () => {
    expect(countDiff(' +content\n -content')).toEqual({ added: 0, removed: 0 })
  })

  it('不误统计前面有空格的三加号或三减号内容', () => {
    expect(countDiff(' +++content\n ---content')).toEqual({
      added: 0,
      removed: 0,
    })
  })
})
