import { describe, expect, it, vi } from 'vitest'

import { ReconnectManager, type ReconnectOptions } from './reconnect'

function createManager(
  connect: ReconnectOptions['connect'] = async () => undefined,
  maxAttempts = 20,
): ReconnectManager {
  return new ReconnectManager({
    baseDelayMs: 1_000,
    connect,
    maxAttempts,
    maxDelayMs: 30_000,
  })
}

describe('ReconnectManager', () => {
  it('markConnected 會記錄 connected 狀態與端點', () => {
    const manager = createManager()

    manager.markConnected('peer-a', '192.168.1.5', 49500)

    expect(manager.list()).toEqual([{
      attempt: 0,
      host: '192.168.1.5',
      peerId: 'peer-a',
      port: 49500,
      status: 'connected',
    }])
  })

  it('斷線後以第一段退避進入 reconnecting，成功後回到 connected', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(async () => undefined)
    const manager = createManager(connect)
    manager.markConnected('peer-a', '192.168.1.5', 49500)

    manager.markDisconnected('peer-a')
    expect(manager.list()[0]).toMatchObject({ attempt: 1, status: 'reconnecting' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(connect).toHaveBeenCalledWith('peer-a', '192.168.1.5', 49500)
    expect(manager.list()[0]).toMatchObject({ attempt: 0, status: 'connected' })
    manager.stop()
    vi.useRealTimers()
  })

  it('失敗時會增加次數並將延遲加倍', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(async () => { throw new Error('offline') })
    const manager = createManager(connect)
    manager.markConnected('peer-a', '192.168.1.5', 49500)

    manager.markDisconnected('peer-a')
    await vi.advanceTimersByTimeAsync(1_000)

    const state = manager.list()[0]
    expect(state).toMatchObject({ attempt: 2, status: 'reconnecting' })
    expect(state?.nextRetryAt).toBe(Date.now() + 2_000)
    manager.stop()
    vi.useRealTimers()
  })

  it('超過最大嘗試次數後標為 offline', async () => {
    vi.useFakeTimers()
    const manager = createManager(async () => { throw new Error('offline') }, 2)
    manager.markConnected('peer-a', '192.168.1.5', 49500)

    manager.markDisconnected('peer-a')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(manager.list()[0]).toMatchObject({ attempt: 2, status: 'offline' })
    manager.stop()
    vi.useRealTimers()
  })

  it('retryNow 會略過等待並立刻嘗試重連', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(async () => undefined)
    const manager = createManager(connect)
    manager.markConnected('peer-a', '192.168.1.5', 49500)
    manager.markDisconnected('peer-a')

    manager.retryNow('peer-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(connect).toHaveBeenCalledOnce()
    manager.stop()
    vi.useRealTimers()
  })

  it('stop 後不會繼續重連', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(async () => undefined)
    const manager = createManager(connect)
    manager.markConnected('peer-a', '192.168.1.5', 49500)
    manager.markDisconnected('peer-a')
    manager.stop()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(connect).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
