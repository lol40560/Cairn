import { describe, expect, it } from 'vitest'

import { AppError, toAppError, wrapIpcHandler } from './errors'

describe('toAppError', () => {
  it('保留已分类的 AppError', () => {
    const error = new AppError('configured', 'config', { hint: 'hintRegenerateToken' })
    expect(toAppError(error)).toBe(error)
  })

  it.each([
    ['ENOENT: folder not found', 'notFound'],
    ['EACCES: permission denied', 'permission'],
    ['HttpError: GitHub API failed', 'github'],
    ['ECONNREFUSED socket failure', 'network'],
    ['token 格式不正确', 'config'],
    ['unclassified issue', 'unknown'],
  ] as const)('将 %s 分类为 %s', (message, category) => {
    expect(toAppError(new Error(message)).category).toBe(category)
  })

  it('为已知错误提供 hint key', () => {
    expect(toAppError(new Error('HttpError: Bad credentials')).hint).toBe('hintRegenerateToken')
    expect(toAppError(new Error('Bad credentials')).hint).toBe('hintRegenerateToken')
    expect(toAppError(new Error('octokit 404 Not Found')).hint).toBe('hintCheckRepo')
    expect(toAppError(new Error('项目路径不存在')).hint).toBe('hintReselectFolder')
    expect(toAppError(new Error('mDNS socket failure')).hint).toBe('hintCheckFirewall')
    expect(toAppError(new Error('github refused request')).hint).toBe('hintCheckGithubSettings')
  })
})

describe('wrapIpcHandler', () => {
  it('成功时返回 data', async () => {
    const handler = wrapIpcHandler(async (value: string) => value.toUpperCase())

    await expect(handler({}, 'ok')).resolves.toEqual({ data: 'OK', ok: true })
  })

  it('失败时返回完整序列化错误', async () => {
    const handler = wrapIpcHandler(async () => {
      throw new Error('ECONNREFUSED socket failure')
    })

    await expect(handler({})).resolves.toMatchObject({
      error: {
        category: 'network',
        hintKey: 'hintCheckFirewall',
        message: 'ECONNREFUSED socket failure',
        raw: expect.stringContaining('ECONNREFUSED socket failure'),
      },
      ok: false,
    })
  })
})
