import { describe, expect, it } from 'vitest'

import { normalizeError } from './errors'

const translations: Record<string, string> = {
  errorConfig: '配置不完整，请打开设置检查',
  errorGithub: 'GitHub 操作失败',
  errorNetwork: '网络连接失败，请检查 WiFi 或防火墙',
  errorNotFound: '找不到资源',
  errorPermission: '权限不足，请检查文件夹权限',
  errorUnknown: '发生未知错误',
  hintCheckRepo: '检查 owner 和 repo 拼写',
}
const t = (key: keyof typeof translations): string => translations[key]

describe('normalizeError', () => {
  it('还原并本地化序列化错误', () => {
    expect(
      normalizeError(
        {
          error: {
            category: 'github',
            hintKey: 'hintCheckRepo',
            message: 'HttpError: Not Found',
            raw: 'stack trace',
          },
          ok: false,
        },
        t,
      ),
    ).toEqual({
      category: 'github',
      hint: '检查 owner 和 repo 拼写',
      message: 'GitHub 操作失败',
      raw: 'stack trace',
    })
  })

  it('处理普通 Error', () => {
    const normalized = normalizeError(new Error('ECONNREFUSED socket failure'), t)

    expect(normalized.category).toBe('network')
    expect(normalized.message).toBe('网络连接失败，请检查 WiFi 或防火墙')
    expect(normalized.raw).toContain('ECONNREFUSED socket failure')
  })
})
