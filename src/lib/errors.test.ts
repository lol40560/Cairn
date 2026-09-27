import { describe, expect, it } from 'vitest'

import { normalizeError } from './errors'

const translations: Record<string, string> = {
  errorConfig: '配置不完整，请打开设置检查',
  errorGithub: 'GitHub 操作失败',
  errorNetwork: '网络连接失败，请检查 WiFi 或防火墙',
  errorNotFound: '找不到资源',
  errorPermission: '权限不足，请检查文件夹权限',
  errorUnknown: '发生未知错误',
  errorGeneric: '出现问题，请重试。',
  errorTeammateUnreachable: '无法连接到队友。请检查是否在同一 WiFi。',
  errorTeammateClosed: '队友的 App 可能已关闭或无法连接。',
  errorGithubExpired: 'GitHub 登录已过期，请在设置里重新登录。',
  errorGithubRepoNotFound: '找不到该 GitHub 项目，请检查 owner 和 repo 名。',
  errorFileGone: '该文件已不存在。',
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
    expect(normalized.message).toBe('队友的 App 可能已关闭或无法连接。')
    expect(normalized.raw).toContain('ECONNREFUSED socket failure')
  })

  it.each([
    ['EHOSTUNREACH: host unreachable', 'network', '无法连接到队友。请检查是否在同一 WiFi。'],
    ['ECONNREFUSED: connection refused', 'network', '队友的 App 可能已关闭或无法连接。'],
    ['HttpError: Bad credentials', 'github', 'GitHub 登录已过期，请在设置里重新登录。'],
    ['octokit 404 GitHub repository not found', 'github', '找不到该 GitHub 项目，请检查 owner 和 repo 名。'],
    ['ENOENT: no such file or directory', 'notFound', '该文件已不存在。'],
  ] as const)('将 %s 本地化为用户可读文案', (message, category, expected) => {
    const normalized = normalizeError(new Error(message), t)

    expect(normalized.category).toBe(category)
    expect(normalized.message).toBe(expected)
  })

  it('为未知错误显示通用重试文案', () => {
    expect(normalizeError(new Error('unclassified issue'), t).message).toBe('出现问题，请重试。')
    expect(normalizeError({ category: 'unknown', message: 'unclassified issue', raw: 'trace' }, t).message).toBe('出现问题，请重试。')
  })
})
