import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { Discovery, selectPeerHosts } from './discovery'
import { Sync } from './sync'
import type { Oplog } from '../oplog'
import type { Transport } from './transport'

const { bonjourConstructor } = vi.hoisted(() => ({ bonjourConstructor: vi.fn() }))
vi.mock('bonjour-service', () => ({
  default: class {
    constructor() { bonjourConstructor() }
    publish() { return { stop() {} } }
    find() { return Object.assign(new EventEmitter(), { stop() {} }) }
    destroy() {}
  },
}))

describe('discovery address candidates', () => {
  it('keeps alternate IPv4 adapters before the hostname and skips unsupported IPv6 listeners', () => {
    expect(selectPeerHosts(['fe80::1', '2001:db8::1', '10.8.0.2', '192.168.1.20', '10.8.0.2'], 'host.local'))
      .toEqual(['10.8.0.2', '192.168.1.20', 'host.local'])
  })

  it('keeps a hostname fallback without malformed or unscoped link-local candidates', () => {
    expect(selectPeerHosts(['not-an-address', 'fe80::1'], 'host.local')).toEqual(['host.local'])
  })

  it('does not allocate multicast resources until discovery is requested', () => {
    bonjourConstructor.mockClear()
    const discovery = new Discovery()
    discovery.destroy()
    expect(bonjourConstructor).not.toHaveBeenCalled()
    discovery.startBrowse('TEST', 'local')
    expect(bonjourConstructor).toHaveBeenCalledOnce()
    discovery.destroy()
  })

  it('starts and stops a direct-only session without constructing Bonjour', async () => {
    bonjourConstructor.mockClear()
    const transport = Object.assign(new EventEmitter(), {
      setRoomCode() {}, setIdentity() {}, listen: async () => 41000,
      close: async () => undefined,
    })
    const sync = new Sync(
      { roomCode: 'TEST', oplog: {} as Oplog },
      { transport: transport as unknown as Transport },
    )
    await sync.start({ discovery: false })
    await sync.stop()
    expect(bonjourConstructor).not.toHaveBeenCalled()
  })
})
