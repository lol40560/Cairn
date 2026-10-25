import { describe, expect, it } from 'vitest'

import { AppError, redactErrorDetails, serializeAppError, toAppError, wrapIpcHandler } from './errors'

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

  it.each([
    ['EHOSTUNREACH: host unreachable', 'errorTeammateUnreachable'],
    ['ECONNREFUSED: connection refused', 'errorTeammateClosed'],
    ['HttpError: Bad credentials', 'errorGithubExpired'],
    ['octokit 404 GitHub repository not found', 'errorGithubRepoNotFound'],
    ['ENOENT: no such file or directory', 'errorFileGone'],
  ])('为 %s 指定友好展示 key', (message, code) => {
    expect(toAppError(new Error(message)).code).toBe(code)
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


describe('team join error diagnostics', () => {
  it.each([
    ['请先选择并开始监控一个项目', 'config', 'errorProjectRequired'],
    ['邀请码必须是 128-bit Base32 房间密钥', 'config', 'errorInvalidCode'],
    ['认证超时', 'network', 'errorTimeout'],
    ['连接 192.168.0.1:1234 在认证完成前关闭', 'network', 'errorConnectionClosed'],
    ['Connection closed before TCP connection completed', 'network', 'errorConnectionClosed'],
    ['wrong-room', 'network', 'errorAuthentication'],
    ['Invalid server proof', 'network', 'errorAuthentication'],
    ['认证失败', 'network', 'errorAuthentication'],
    ['Unsupported protocol version: 3', 'network', 'errorVersionMismatch'],
    ['mDNS publish failed', 'network', 'errorDiscovery'],
  ])('preserves the actionable reason for %s', (message, category, code) => {
    expect(serializeAppError(new Error(message))).toMatchObject({ category, code, message })
  })

  it('retains typed project/address errors from the main process', () => {
    for (const code of ['errorProjectRequired', 'errorInvalidAddress']) {
      expect(serializeAppError(new AppError('configuration problem', 'config', { code }))).toMatchObject({ category: 'config', code })
    }
  })

  it('redacts credentials from both serialized messages and local details', () => {
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const message = `roomCode="${secret}" token=not-for-diagnostics https://user:private-pass@example.test/join?invite=private-invite#secret=fragment-secret Authorization: Bearer private.bearer.token`
    const result = serializeAppError(new Error(message))
    for (const value of [result.message, result.raw, redactErrorDetails(message)]) {
      for (const credential of [secret, 'not-for-diagnostics', 'private-pass', 'private-invite', 'fragment-secret', 'private.bearer.token']) {
        expect(value).not.toContain(credential)
      }
      expect(value).toContain('[redacted')
    }
  })

  it('keeps endpoint and operating-system failure evidence', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 192.168.1.10:59728'), { code: 'ECONNREFUSED' })
    expect(serializeAppError(error)).toMatchObject({ category: 'network', code: 'errorTeammateClosed', message: error.message })
    expect(serializeAppError(error).raw).toContain('192.168.1.10:59728')
  })
})
