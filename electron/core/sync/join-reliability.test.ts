import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Oplog } from '../oplog'
import { Sync } from './sync'
import type { Discovery } from './discovery'
import type { Transport } from './transport'
import { ReconnectManager } from './reconnect'

class TestDiscovery extends EventEmitter {
  publish = vi.fn()
  startBrowse = vi.fn()
  stopPublish = vi.fn()
  stopBrowse = vi.fn()
  destroy = vi.fn()
}

class TestTransport extends EventEmitter {
  connect = vi.fn<(host: string, port: number, attemptId?: string) => Promise<void>>(async () => undefined)
  cancelConnectionAttempt = vi.fn()
  getConnectedPeerAtEndpoint = vi.fn((): string | undefined => undefined)
  setRoomCode = vi.fn()
  setIdentity = vi.fn()
  listen = vi.fn(async () => 41000)
  close = vi.fn(async () => undefined)
  send = vi.fn()
  broadcast = vi.fn()
}

const sessions: Sync[] = []

async function setup() {
  const discovery = new TestDiscovery()
  const transport = new TestTransport()
  const sync = new Sync(
    { roomCode: 'TEST', oplog: { listAllHashes: () => [] } as unknown as Oplog },
    { discovery: discovery as unknown as Discovery, transport: transport as unknown as Transport, peerId: 'local' },
  )
  sync.on('error', () => undefined)
  sessions.push(sync)
  await sync.start()
  return { sync, discovery, transport }
}

function advertised(hosts?: string[]) {
  return { peerId: 'remote', host: hosts?.[0] ?? '192.168.1.20', hosts, port: 42000, lastSeen: Date.now() }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((sync) => sync.stop()))
  vi.useRealTimers()
})

describe('join connection coordination', () => {
  it('does not restart a stopped reconnect loop when its pending attempt rejects', async () => {
    vi.useFakeTimers()
    let rejectAttempt!: (error: Error) => void
    const connect = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAttempt = reject }))
    const manager = new ReconnectManager({ connect, baseDelayMs: 1_000, maxAttempts: 20, maxDelayMs: 30_000 })
    manager.markDisconnected('remote', '192.168.1.20', 42000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(connect).toHaveBeenCalledOnce()
    manager.stop()
    rejectAttempt(new Error('session stopped'))
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not announce or count a discovered peer before authentication', async () => {
    const { sync, discovery, transport } = await setup()
    const joined = vi.fn()
    sync.on('peerJoined', joined)
    discovery.emit('peer', advertised())
    expect(sync.listPeers()).toEqual([])
    expect(joined).not.toHaveBeenCalled()
    const attemptId = transport.connect.mock.calls[0]![2]
    transport.emit('connect', 'remote', { host: '192.168.1.20', port: 42000 }, attemptId)
    expect(sync.listPeers()).toEqual([expect.objectContaining({ peerId: 'remote' })])
    expect(joined).toHaveBeenCalledOnce()
  })

  it('retries an initial discovery failure and becomes connected only after authentication', async () => {
    vi.useFakeTimers()
    const { sync, discovery, transport } = await setup()
    const statuses = vi.fn()
    sync.on('peerStatusChanged', statuses)
    transport.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    discovery.emit('peer', advertised())
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.listPeers()).toEqual([])
    expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ status: 'reconnecting' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.connect).toHaveBeenCalledTimes(2)
    const attemptId = transport.connect.mock.calls[1]![2]
    transport.emit('connect', 'remote', { host: '192.168.1.20', port: 42000 }, attemptId)
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.listPeers()).toHaveLength(1)
    expect(statuses).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'connected' }))
  })

  it('tries another advertised interface when the first address cannot connect', async () => {
    const { sync, discovery, transport } = await setup()
    transport.connect.mockRejectedValueOnce(new Error('ENETUNREACH'))
    discovery.emit('peer', advertised(['10.8.0.2', '192.168.1.20']))
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2))
    const second = transport.connect.mock.calls[1]!
    expect(second.slice(0, 2)).toEqual(['192.168.1.20', 42000])
    transport.emit('connect', 'remote', { host: second[0], port: second[1] }, second[2])
    expect(sync.listPeers()[0]?.host).toBe('192.168.1.20')
  })

  it('shares pending direct attempts and reuses a connected endpoint', async () => {
    const { sync, transport } = await setup()
    const first = sync.connectToAddress('192.168.1.20', 42000)
    const second = sync.connectToAddress('192.168.1.20', 42000)
    expect(transport.connect).toHaveBeenCalledOnce()
    const attempt = transport.connect.mock.calls[0]!
    transport.emit('connect', 'remote', { host: attempt[0], port: attempt[1] }, attempt[2])
    await Promise.all([first, second])
    await sync.connectToAddress('192.168.1.20', 42000)
    expect(transport.connect).toHaveBeenCalledOnce()
  })

  it('cancels the pending socket when its connection deadline expires', async () => {
    vi.useFakeTimers()
    const { sync, transport } = await setup()
    const result = sync.connectToAddress('192.168.1.20', 42000).catch((error: unknown) => error)
    const attemptId = transport.connect.mock.calls[0]![2]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ code: 'ETIMEDOUT' })
    expect(transport.cancelConnectionAttempt).toHaveBeenCalledWith(attemptId)
    expect(sync.listPeers()).toEqual([])
  })

  it('does not share authentication promises for different expected peer identities', async () => {
    const { sync, discovery, transport } = await setup()
    discovery.emit('peer', advertised())
    discovery.emit('peer', { ...advertised(), peerId: 'another-peer' })
    expect(transport.connect).toHaveBeenCalledTimes(2)
    const [first, second] = transport.connect.mock.calls
    transport.emit('connect', 'remote', { host: first![0], port: first![1] }, first![2])
    // The other discovery claim must not be satisfied by that authenticated identity.
    transport.emit('connect', 'remote', { host: second![0], port: second![1] }, second![2])
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.cancelConnectionAttempt).toHaveBeenCalledWith(second![2])
    expect(sync.listPeers().map((peer) => peer.peerId)).toEqual(['remote'])
  })

  it('removes disconnected peers but retains a live TCP session when mDNS disappears', async () => {
    const { sync, discovery, transport } = await setup()
    const pending = sync.connectToAddress('192.168.1.20', 42000)
    const attemptId = transport.connect.mock.calls[0]![2]
    transport.emit('connect', 'remote', { host: '192.168.1.20', port: 42000 }, attemptId)
    await pending
    discovery.emit('peerLeft', 'remote')
    expect(sync.listPeers()).toHaveLength(1)
    transport.emit('disconnect', 'remote')
    expect(sync.listPeers()).toEqual([])
  })
})
