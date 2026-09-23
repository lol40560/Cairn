import { describe, expect, it, vi } from 'vitest'

import type { Op } from '@/types/cairn'

import { restoreLastSession, type SessionRestoreActions, type SessionRestoreApi } from './sessionRestore'

function setup(session: { folder: string; watching: boolean; updatedAt: number }, settings = { autoStartWatching: true, rememberLastFolder: true }): { api: SessionRestoreApi; actions: SessionRestoreActions } {
  return {
    api: {
      checkFolder: vi.fn(async () => ({ data: true, ok: true }) as const),
      clearLastSession: vi.fn(async () => ({ data: undefined, ok: true }) as const),
      getLastSession: vi.fn(async () => ({ data: session, ok: true }) as const),
      getSettings: vi.fn(async () => ({ data: settings, ok: true }) as const),
      listRecentOps: vi.fn(async () => ({ data: [] as Op[], ok: true }) as const),
      startWatching: vi.fn(async () => ({ data: undefined, ok: true }) as const),
    },
    actions: {
      replaceOps: vi.fn(),
      setFolder: vi.fn(),
      setStatus: vi.fn(),
      setUnavailable: vi.fn(),
    },
  }
}

describe('restoreLastSession', () => {
  it('上次正在监控时自动恢复监控', async () => {
    const { api, actions } = setup({ folder: '/project', updatedAt: 1, watching: true })

    await restoreLastSession(api, actions)

    expect(api.startWatching).toHaveBeenCalledWith('/project')
    expect(actions.setStatus).toHaveBeenCalledWith('watching')
  })

  it('上次未监控时只回填文件夹', async () => {
    const { api, actions } = setup({ folder: '/project', updatedAt: 1, watching: false })

    await restoreLastSession(api, actions)

    expect(actions.setFolder).toHaveBeenCalledWith('/project')
    expect(api.startWatching).not.toHaveBeenCalled()
    expect(actions.setStatus).toHaveBeenCalledWith('idle')
  })

  it('文件夹不可用时清空会话并显示提示', async () => {
    const { api, actions } = setup({ folder: '/missing', updatedAt: 1, watching: true })
    vi.mocked(api.checkFolder).mockResolvedValue({ data: false, ok: true })

    await restoreLastSession(api, actions)

    expect(api.clearLastSession).toHaveBeenCalledOnce()
    expect(actions.setUnavailable).toHaveBeenCalledWith(true)
    expect(api.startWatching).not.toHaveBeenCalled()
  })

  it('关闭记住文件夹时完全跳过恢复', async () => {
    const { api, actions } = setup(
      { folder: '/project', updatedAt: 1, watching: true },
      { autoStartWatching: true, rememberLastFolder: false },
    )

    await restoreLastSession(api, actions)

    expect(api.checkFolder).not.toHaveBeenCalled()
    expect(api.startWatching).not.toHaveBeenCalled()
    expect(actions.setFolder).not.toHaveBeenCalled()
  })
})
