import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReconnectManager, type ReconnectOptions } from './reconnect'

const managers: ReconnectManager[] = []

afterEach(() => {
  managers.splice(0).forEach((manager) => manager.stop())
  vi.useRealTimers()
})

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function createManager(
  connect: ReconnectOptions['connect'] = async () => undefined,
  maxAttempts = 20,
): ReconnectManager {
  const manager = new ReconnectManager({
    baseDelayMs: 1_000,
    connect,
    maxAttempts,
    maxDelayMs: 30_000,
  })
  managers.push(manager)
  return manager
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

  it.each(['success', 'failure'] as const)('ignores pending %s after stop', async (outcome) => {
    vi.useFakeTimers()
    const pending = deferred()
    const connect = vi.fn(() => pending.promise)
    const manager = createManager(connect)
    manager.markDisconnected('peer-a', '192.168.1.5', 49500)
    await vi.advanceTimersByTimeAsync(1_000)

    manager.stop()
    if (outcome === 'success') pending.resolve()
    else pending.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(manager.list()).toEqual([])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)('keeps a replacement connection after stale %s', async (outcome) => {
    vi.useFakeTimers()
    const pending = deferred()
    const manager = createManager(() => pending.promise)
    manager.markDisconnected('peer-a', '192.168.1.5', 49500)
    await vi.advanceTimersByTimeAsync(1_000)

    manager.markConnected('peer-a', '192.168.1.6', 49501)
    if (outcome === 'success') pending.resolve()
    else pending.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(manager.get('peer-a')).toEqual({
      peerId: 'peer-a', status: 'connected', attempt: 0, host: '192.168.1.6', port: 49501,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)('keeps the newer retry active after stale %s', async (outcome) => {
    vi.useFakeTimers()
    const previous = deferred()
    const current = deferred()
    const connect = vi.fn()
      .mockImplementationOnce(() => previous.promise)
      .mockImplementationOnce(() => current.promise)
    const manager = createManager(connect)
    manager.markDisconnected('peer-a', '192.168.1.5', 49500)
    await vi.advanceTimersByTimeAsync(1_000)
    manager.retryNow('peer-a')
    await vi.advanceTimersByTimeAsync(0)

    if (outcome === 'success') previous.resolve()
    else previous.reject(new Error('superseded failure'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(manager.get('peer-a')).toMatchObject({ status: 'reconnecting', attempt: 1 })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    current.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.get('peer-a')).toMatchObject({ status: 'connected', attempt: 0 })
  })
})
