import { createServer, type Server, type Socket } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Transport } from './transport'
import type { SyncMessage } from './protocol'

const transports: Transport[] = []
const servers: Server[] = []
const rawSockets: Socket[] = []

function transport(peerId: string): Transport {
  const instance = new Transport(peerId)
  instance.setRoomCode('shared-test-room')
  // Transport reports errors as events; assertions below check observable
  // connection and message behavior rather than throwing from an event handler.
  instance.on('error', () => undefined)
  transports.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((instance) => instance.close()))
  rawSockets.splice(0).forEach((socket) => socket.destroy())
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('authenticated connection coordination', () => {
  it('converges on one usable connection after simultaneous bidirectional dials', async () => {
    const first = transport('a-peer')
    const second = transport('z-peer')
    const [firstPort, secondPort] = await Promise.all([first.listen(), second.listen()])
    const secondMessages: SyncMessage[] = []
    const firstMessages: SyncMessage[] = []
    first.on('message', (_peer, message: SyncMessage) => firstMessages.push(message))
    second.on('message', (_peer, message: SyncMessage) => secondMessages.push(message))

    await Promise.all([
      first.connect('127.0.0.1', secondPort, 'a-to-z'),
      second.connect('127.0.0.1', firstPort, 'z-to-a'),
    ])
    await vi.waitFor(() => {
      expect(first.getConnectedPeerAtEndpoint('127.0.0.1', secondPort)).toBe('z-peer')
    })
    first.send('z-peer', { type: 'have', hash: 'from-a' })
    second.send('a-peer', { type: 'have', hash: 'from-z' })
    await vi.waitFor(() => {
      expect(secondMessages).toContainEqual({ type: 'have', hash: 'from-a' })
      expect(firstMessages).toContainEqual({ type: 'have', hash: 'from-z' })
    })
    expect(second.getConnectedPeerAtEndpoint('127.0.0.1', firstPort)).toBeUndefined()
  })

  it('completes a repeated direct attempt using the authenticated outgoing connection', async () => {
    const first = transport('a-peer')
    const second = transport('z-peer')
    const port = await second.listen()
    const secondConnected = vi.fn()
    const firstConnected = vi.fn()
    second.on('connect', secondConnected)
    first.on('connect', firstConnected)
    await first.connect('127.0.0.1', port, 'initial')
    await vi.waitFor(() => expect(first.getConnectedPeerAtEndpoint('127.0.0.1', port)).toBe('z-peer'))

    await first.connect('127.0.0.1', port, 'repeated')

    expect(firstConnected).toHaveBeenCalledWith('z-peer', { host: '127.0.0.1', port }, 'repeated')
    expect(secondConnected).toHaveBeenCalledTimes(1)
  })

  it('completes a direct attempt when the same peer already has a preferred inbound connection', async () => {
    const first = transport('z-peer')
    const second = transport('a-peer')
    const [firstPort, secondPort] = await Promise.all([first.listen(), second.listen()])
    const firstConnected = vi.fn()
    first.on('connect', firstConnected)
    await second.connect('127.0.0.1', firstPort)
    await vi.waitFor(() => expect(second.getConnectedPeerAtEndpoint('127.0.0.1', firstPort)).toBe('z-peer'))

    await first.connect('127.0.0.1', secondPort, 'reuse-inbound')

    await vi.waitFor(() => expect(firstConnected).toHaveBeenCalledWith(
      'a-peer', { host: '127.0.0.1', port: secondPort }, 'reuse-inbound',
    ))
    const messages: SyncMessage[] = []
    second.on('message', (_peer, message: SyncMessage) => messages.push(message))
    first.send('a-peer', { type: 'have', hash: 'still-connected' })
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'have', hash: 'still-connected' }))
  })

  it('closes a cancelled pending authentication without closing an established connection', async () => {
    const first = transport('a-peer')
    const second = transport('z-peer')
    const port = await second.listen()
    await first.connect('127.0.0.1', port, 'established')
    await vi.waitFor(() => expect(first.getConnectedPeerAtEndpoint('127.0.0.1', port)).toBe('z-peer'))
    first.cancelConnectionAttempt('established')
    expect(first.getConnectedPeerAtEndpoint('127.0.0.1', port)).toBe('z-peer')

    const server = createServer((socket) => rawSockets.push(socket))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test endpoint')
    const failures = vi.fn()
    first.on('connectionFailed', failures)
    await first.connect('127.0.0.1', address.port, 'cancel-me')
    await vi.waitFor(() => expect(rawSockets).toHaveLength(1))
    first.cancelConnectionAttempt('cancel-me')
    await vi.waitFor(() => expect(failures).toHaveBeenCalledWith(
      expect.any(Error), { host: '127.0.0.1', port: address.port }, 'cancel-me',
    ))
    expect(first.getConnectedPeerAtEndpoint('127.0.0.1', port)).toBe('z-peer')
    expect(first.getConnectedPeerAtEndpoint('127.0.0.1', address.port)).toBeUndefined()
  })
})
