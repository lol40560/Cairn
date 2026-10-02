import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTwoFilesPatch } from 'diff'

import { computeHash, createOplog, type NewOp, type Oplog, type Op } from '../oplog'
import { createAuthHmac, decodeMessages, deriveAuthKey, deriveRoomHash, encodeMessage, type PeerInfo, type SyncMessage } from './protocol'
import { Sync } from './sync'
import { MAX_SYNC_MESSAGE_BYTES, Transport } from './transport'
import { writeSnapshot } from '../watcher/snapshot'

const roots: string[] = []
const transports: Transport[] = []

function waitForEvent<T extends unknown[]>(
  emitter: EventEmitter,
  event: string,
): Promise<T> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: T) => resolve(args))
  })
}

/** 让裸 TCP 客户端完成与 Transport 相同的认证握手，供边界测试使用。 */
async function authenticateRawClient(
  receiver: Transport,
  client: Socket,
  peerId = 'sender',
  roomCode = '',
): Promise<void> {
  let buffer = ''
  client.on('data', (chunk: Buffer) => {
    const decoded = decodeMessages(buffer + chunk.toString('utf8'))
    buffer = decoded.rest
    for (const message of decoded.messages) {
      if (message.type === 'auth-challenge') {
        client.write(encodeMessage({ type: 'auth-response', hmac: createAuthHmac(roomCode, message.nonce) }))
      }
      if (message.type === 'auth-ok') {
        client.write(encodeMessage({ type: 'hello', peerId, version: 1 }))
      }
    }
  })
  const connected = waitForEvent<[string]>(receiver, 'connect')
  client.write(encodeMessage({ type: 'auth-request', peerId, roomHash: deriveRoomHash(roomCode) }))
  await connected
}

async function createTestOplog(): Promise<{ oplog: Oplog; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-sync-'))
  roots.push(root)
  return { oplog: createOplog(root), root }
}

function createOp(id: string): NewOp {
  return {
    author: 'alice',
    diff: `+${id}`,
    filePath: `src/${id}.ts`,
    id,
    parentHashes: [],
    timestamp: Date.now(),
  }
}

class MockDiscovery extends EventEmitter {
  published: { peerId: string; port: number; roomCode: string } | undefined

  publish(options: { peerId: string; port: number; roomCode: string }): void {
    this.published = options
  }

  startBrowse(): void {}

  stopBrowse(): void {}

  stopPublish(): void {
    this.published = undefined
  }

  destroy(): void {}
}

class MockTransport extends EventEmitter {
  readonly broadcast = vi.fn()
  readonly connect = vi.fn(async () => {
    this.emit('connect', 'direct-peer')
  })
  readonly send = vi.fn()

  async close(): Promise<void> {}

  async listen(): Promise<number> {
    return 41000
  }

  setRoomCode(): void {}
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('sync protocol', () => {
  it('编解码单条、多条和不完整消息', () => {
    const first: SyncMessage = { hash: 'a', type: 'have' }
    const second: SyncMessage = { hash: 'b', type: 'want' }

    expect(decodeMessages(encodeMessage(first))).toEqual({ messages: [first], rest: '' })
    expect(decodeMessages(`${encodeMessage(first)}${encodeMessage(second)}`)).toEqual({
      messages: [first, second],
      rest: '',
    })
    expect(decodeMessages('{"type":"have"')).toEqual({
      messages: [],
      rest: '{"type":"have"',
    })
  })

  it('忽略非法 JSON 行并报告错误', () => {
    const report = vi.fn()

    const result = decodeMessages('{not-json}\n', report)

    expect(result).toEqual({ messages: [], rest: '' })
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('识别心跳消息', () => {
    expect(decodeMessages(`${encodeMessage({ type: 'ping' })}${encodeMessage({ type: 'pong' })}`)).toEqual({
      messages: [{ type: 'ping' }, { type: 'pong' }],
      rest: '',
    })
  })

  it('为同一邀请码稳定派生公开 hash 与 32 字节认证密钥', () => {
    expect(deriveRoomHash('ABCDEF')).toHaveLength(16)
    expect(deriveRoomHash('ABCDEF')).toBe(deriveRoomHash('ABCDEF'))
    expect(deriveRoomHash('ABCDEF')).not.toBe(deriveRoomHash('GHIJKL'))
    expect(deriveAuthKey('ABCDEF')).toHaveLength(32)
    expect(createAuthHmac('ABCDEF', 'nonce')).toMatch(/^[a-f0-9]{64}$/)
    expect(createAuthHmac('ABCDEF', 'nonce')).not.toBe(createAuthHmac('GHIJKL', 'nonce'))
  })
})

describe('transport', () => {
  it('让两个实例互连并互发消息', async () => {
    const first = new Transport('first')
    const second = new Transport('second')
    transports.push(first, second)
    const port = await second.listen()
    const connectedFirst = waitForEvent<[string]>(first, 'connect')
    const connectedSecond = waitForEvent<[string]>(second, 'connect')

    await first.connect('127.0.0.1', port)
    await expect(connectedFirst).resolves.toEqual(['second'])
    await expect(connectedSecond).resolves.toEqual(['first'])

    const received = waitForEvent<[string, SyncMessage]>(second, 'message')
    first.send('second', { hash: 'shared', type: 'have' })

    await expect(received).resolves.toEqual(['first', { hash: 'shared', type: 'have' }])
  })

  it('能够处理一次写入的多条消息', async () => {
    const first = new Transport('first')
    const second = new Transport('second')
    transports.push(first, second)
    const port = await second.listen()
    const firstConnected = waitForEvent(first, 'connect')
    await first.connect('127.0.0.1', port)
    await firstConnected
    const received: SyncMessage[] = []
    const allMessages = new Promise<void>((resolve) => {
      second.on('message', (_peerId: string, message: SyncMessage) => {
        received.push(message)
        if (received.length === 2) {
          resolve()
        }
      })
    })

    first.send('second', { hash: 'first', type: 'have' })
    first.send('second', { hash: 'second', type: 'want' })
    await allMessages

    expect(received).toEqual([
      { hash: 'first', type: 'have' },
      { hash: 'second', type: 'want' },
    ])
  })

  it('重复 peerId 连接时保留旧连接', async () => {
    const original = new Transport('same-peer')
    const duplicate = new Transport('same-peer')
    const receiver = new Transport('receiver')
    transports.push(original, duplicate, receiver)
    const port = await receiver.listen()
    const originalConnected = waitForEvent(original, 'connect')
    const receiverConnected = waitForEvent(receiver, 'connect')
    await original.connect('127.0.0.1', port)
    await originalConnected
    await receiverConnected
    const connectSpy = vi.fn()
    receiver.on('connect', connectSpy)

    await duplicate.connect('127.0.0.1', port)
    const received = waitForEvent<[string, SyncMessage]>(original, 'message')
    receiver.send('same-peer', { hash: 'kept', type: 'have' })

    await expect(received).resolves.toEqual([
      'receiver',
      { hash: 'kept', type: 'have' },
    ])
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('分块传输中文和 emoji 时保持 UTF-8 完整', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', () => resolve())
      client.connect(port, '127.0.0.1')
    })
    await authenticateRawClient(receiver, client)
    const received = waitForEvent<[string, SyncMessage]>(receiver, 'message')
    const message = encodeMessage({
      type: 'seeder-available',
      projectName: '中文 😀',
      size: 1,
      snapshotId: 'snapshot',
    })
    const bytes = Buffer.from(message)
    const splitAt = bytes.indexOf(Buffer.from('中')) + 1
    client.write(bytes.subarray(0, splitAt))
    client.write(bytes.subarray(splitAt))

    await expect(received).resolves.toEqual(['sender', {
      type: 'seeder-available',
      projectName: '中文 😀',
      size: 1,
      snapshotId: 'snapshot',
    }])
    client.destroy()
  })

  it('拒绝超过大小上限的单条同步消息', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', () => resolve())
      client.connect(port, '127.0.0.1')
    })
    await authenticateRawClient(receiver, client)
    const failure = waitForEvent<[Error]>(receiver, 'error')
    client.write(`{"type":"have","hash":"${'a'.repeat(MAX_SYNC_MESSAGE_BYTES + 1)}"}\n`)

    await expect(failure).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('超过') })])
    client.destroy()
  })

  it('收到 ping 时回复 pong', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    let received = ''
    const pong = new Promise<void>((resolve) => {
      client.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        if (received.includes('"pong"')) resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    await authenticateRawClient(receiver, client)
    client.write(encodeMessage({ type: 'ping' }))

    await expect(pong).resolves.toBeUndefined()
    client.destroy()
  })

  it('心跳超时会主动关闭静默连接', async () => {
    const receiver = new Transport('receiver', { heartbeatIntervalMs: 5, heartbeatTimeoutMs: 15 })
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    await authenticateRawClient(receiver, client)
    const disconnected = waitForEvent<[string]>(receiver, 'disconnect')

    await expect(disconnected).resolves.toEqual(['sender'])
    client.destroy()
  })

  it('错误邀请码会被认证层拒绝', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')
    client.write(encodeMessage({ type: 'auth-request', peerId: 'sender', roomHash: deriveRoomHash('GHIJKL') }))

    expect((await failed)[0].message).toBe('wrong-room')
    client.destroy()
  })

  it('无效 HMAC 会被认证层拒绝', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    client.on('data', (chunk: Buffer) => {
      const decoded = decodeMessages(chunk.toString('utf8'))
      if (decoded.messages.some((message) => message.type === 'auth-challenge')) {
        client.write(encodeMessage({ type: 'auth-response', hmac: '0'.repeat(64) }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')
    client.write(encodeMessage({ type: 'auth-request', peerId: 'sender', roomHash: deriveRoomHash('ABCDEF') }))

    expect((await failed)[0].message).toBe('认证失败')
    client.destroy()
  })

  it('未在有效期内响应 challenge 会被拒绝', async () => {
    const receiver = new Transport('receiver', { authTimeoutMs: 5 })
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')
    client.write(encodeMessage({ type: 'auth-request', peerId: 'sender', roomHash: deriveRoomHash('ABCDEF') }))

    expect((await failed)[0].message).toBe('认证超时')
    client.destroy()
  })
})

describe('Sync', () => {
  it('直连地址会转发给 transport.connect 并等待 hello 连接', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    const seeder = {
      announceToPeer: vi.fn(),
      handleWantChunk: vi.fn(),
      handleWantSnapshot: vi.fn(),
    }
    sync.registerSeeder(seeder)

    await sync.start({ discovery: false })
    await sync.connectToAddress('192.168.1.10', 49500)

    expect(transport.connect).toHaveBeenCalledWith('192.168.1.10', 49500)
    expect(sync.listPeers()).toEqual([
      { host: '192.168.1.10', lastSeen: expect.any(Number), peerId: 'direct-peer', port: 49500 },
    ])
    expect(seeder.announceToPeer).toHaveBeenCalledWith('direct-peer')
    await sync.stop()
  })

  it('直连地址拒绝空 host 与越界端口', async () => {
    const { oplog } = await createTestOplog()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: new MockTransport() as never },
    )

    await expect(sync.connectToAddress(' ', 49500)).rejects.toThrow('直连地址不能为空')
    await expect(sync.connectToAddress('192.168.1.10', 0)).rejects.toThrow('直连端口必须在 1 到 65535 之间')
    await expect(sync.connectToAddress('192.168.1.10', 65_536)).rejects.toThrow('直连端口必须在 1 到 65535 之间')
  })

  it('不同邀请码的 Sync 无法通过直连建立连接', async () => {
    const first = await createTestOplog()
    const second = await createTestOplog()
    const firstTransport = new Transport('first')
    const secondTransport = new Transport('second')
    transports.push(firstTransport, secondTransport)
    const firstSync = new Sync(
      { oplog: first.oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'first', transport: firstTransport },
    )
    const secondSync = new Sync(
      { oplog: second.oplog, roomCode: 'GHIJKL' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'second', transport: secondTransport },
    )
    firstSync.on('error', () => undefined)
    secondSync.on('error', () => undefined)
    await firstSync.start({ discovery: false })
    await secondSync.start({ discovery: false })

    await expect(firstSync.connectToAddress('127.0.0.1', secondSync.getLocalPort()!, 'ABCDEF')).rejects.toThrow('wrong-room')
    expect(firstSync.listPeers()).toEqual([])
    expect(secondSync.listPeers()).toEqual([])

    await firstSync.stop()
    await secondSync.stop()
  })

  it('路由快照消息并维护远端 seeder 列表', async () => {
    const { oplog } = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'local', transport: transport as unknown as never },
    )
    const seeder = {
      announceToPeer: vi.fn(),
      handleWantChunk: vi.fn(),
      handleWantSnapshot: vi.fn(),
    }
    const downloader = {
      cancel: vi.fn(),
      handleChunk: vi.fn(),
      handleSnapshotMeta: vi.fn(),
    }
    sync.registerSeeder(seeder)
    sync.registerDownloader(downloader)
    await sync.start()

    transport.emit('message', 'peer-a', {
      type: 'seeder-available',
      snapshotId: 'snapshot-a',
      projectName: 'project-a',
      size: 42,
    } satisfies SyncMessage)
    transport.emit('message', 'peer-a', { type: 'want-snapshot', snapshotId: 'local-snapshot' } satisfies SyncMessage)
    transport.emit('message', 'peer-a', { type: 'want-chunk', snapshotId: 'local-snapshot', index: 0 } satisfies SyncMessage)
    transport.emit('message', 'peer-a', {
      type: 'snapshot-meta',
      snapshotId: 'snapshot-a',
      projectName: 'project-a',
      size: 42,
      chunkCount: 1,
    } satisfies SyncMessage)
    transport.emit('message', 'peer-a', {
      type: 'chunk',
      snapshotId: 'snapshot-a',
      index: 0,
      data: 'YQ==',
    } satisfies SyncMessage)

    expect(sync.listSeeders()).toEqual([
      { peerId: 'peer-a', snapshotId: 'snapshot-a', projectName: 'project-a', size: 42 },
    ])
    expect(seeder.handleWantSnapshot).toHaveBeenCalledWith('peer-a', 'local-snapshot')
    expect(seeder.handleWantChunk).toHaveBeenCalledWith('peer-a', 'local-snapshot', 0)
    expect(downloader.handleSnapshotMeta).toHaveBeenCalledOnce()
    expect(downloader.handleChunk).toHaveBeenCalledOnce()

    await sync.stop()
  })

  it('连接断开时取消活动下载器', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    const downloader = {
      cancel: vi.fn(),
      handleChunk: vi.fn(),
      handleSnapshotMeta: vi.fn(),
    }
    sync.registerDownloader(downloader)
    await sync.start({ discovery: false })

    transport.emit('disconnect', 'peer-a')

    expect((downloader.cancel.mock.calls[0]?.[0] as Error).message).toContain('连接中断')
    await sync.stop()
  })

  it('重连成功后重新通告本地已有操作', async () => {
    const { oplog } = await createTestOplog()
    const localOp = oplog.putOp(createOp('after-reconnect'))
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    await sync.start({ discovery: false })

    transport.emit('connect', 'peer-a')

    expect(transport.send).toHaveBeenCalledWith('peer-a', { hash: localOp.hash, type: 'have' })
    await sync.stop()
  })

  it('通过同房间 discovery 在两个实例间同步 op', async () => {
    const first = await createTestOplog()
    const second = await createTestOplog()
    const input = {
      ...createOp('shared'),
      diff: createTwoFilesPatch('src/shared.ts', 'src/shared.ts', 'before\n', 'after\n'),
      filePath: 'src/shared.ts',
    }
    const sourceOp = first.oplog.putOp(input)
    const firstDiscovery = new MockDiscovery()
    const secondDiscovery = new MockDiscovery()
    const firstTransport = new Transport('first')
    const secondTransport = new Transport('second')
    transports.push(firstTransport, secondTransport)
    let secondContent = 'before\n'
    const applyRemoteChange = vi.fn(async () => undefined)
    const firstSync = new Sync(
      { oplog: first.oplog, roomCode: 'ABCDEF' },
      { discovery: firstDiscovery as unknown as never, peerId: 'first', transport: firstTransport },
    )
    const secondSync = new Sync(
      { oplog: second.oplog, roomCode: 'ABCDEF' },
      { discovery: secondDiscovery as unknown as never, peerId: 'second', transport: secondTransport },
      {
        applyRemoteChange,
        readFile: async () => secondContent,
        writeFile: async (path, content) => {
          void path
          secondContent = content
        },
      },
    )
    const remoteOp = waitForEvent<[Op]>(secondSync, 'remoteOp')

    await firstSync.start()
    await secondSync.start()
    const secondInfo: PeerInfo = {
      host: '127.0.0.1',
      lastSeen: Date.now(),
      peerId: 'second',
      port: secondDiscovery.published!.port,
    }
    firstDiscovery.emit('peer', secondInfo)

    await expect(remoteOp).resolves.toEqual([{ ...sourceOp, source: 'remote' }])
    expect(second.oplog.getOp(sourceOp.hash)).toEqual(sourceOp)
    expect(secondContent).toBe('after\n')
    expect(applyRemoteChange).toHaveBeenCalledWith('src/shared.ts', 'after\n')

    await firstSync.stop()
    await secondSync.stop()
  })

  it('收到远端 op 时写入 oplog 并只发出一次 remoteOp', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
    )
    const input = createOp('remote')
    const validOp: Op = { ...input, hash: computeHash(input) }
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: validOp, type: 'data' })
    await expect(remoteOp).resolves.toEqual([{
      ...validOp,
      kind: 'modified',
      source: 'remote',
    }])
    expect(target.oplog.getOp(validOp.hash)).toEqual({
      ...validOp,
      kind: 'modified',
    })
    await sync.stop()
  })

  it('收到已有远端 op 时静默忽略', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const input = createOp('existing')
    const existingOp = target.oplog.putOp(input)
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
    )
    const remoteOp = vi.fn()
    sync.on('remoteOp', remoteOp)

    await sync.start()
    transport.emit('message', 'source', { op: existingOp, type: 'data' })

    expect(remoteOp).not.toHaveBeenCalled()
    expect(target.oplog.getOp(existingOp.hash)).toEqual(existingOp)
    await sync.stop()
  })

  it('stop 后不再处理 discovery 事件', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
    )

    await sync.start()
    await sync.stop()
    discovery.emit('peer', {
      host: '127.0.0.1',
      lastSeen: Date.now(),
      peerId: 'source',
      port: 42000,
    } satisfies PeerInfo)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(sync.listPeers()).toEqual([])
  })

  it('收到远端 op 后应用 diff 到本地内容', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    let content = 'before\n'
    const input = {
      ...createOp('applied'),
      diff: createTwoFilesPatch('applied.ts', 'applied.ts', 'before\n', 'after\n'),
      filePath: 'applied.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const applyRemoteChange = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        readFile: async () => content,
        writeFile: async (_path, nextContent) => {
          content = nextContent
        },
      },
    )
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(content).toBe('after\n')
    expect(applyRemoteChange).toHaveBeenCalledWith('applied.ts', 'after\n')
    await sync.stop()
  })

  it('本地不存在文件时用创建操作重建文件', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = ''
    const input = {
      ...createOp('created'),
      diff: createTwoFilesPatch('/dev/null', 'created.ts', '', 'export const created = true\n'),
      filePath: 'created.ts',
      kind: 'created' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        readFile: async () => content,
        writeFile: async (_path, nextContent) => {
          content = nextContent
        },
      },
    )
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(content).toBe('export const created = true\n')
    await sync.stop()
  })

  it('创建空文件不会被当作删除', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    const input = {
      ...createOp('empty-created'),
      diff: createTwoFilesPatch('empty.ts', 'empty.ts', '', ''),
      filePath: 'empty.ts',
      kind: 'created' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const moveRemoteDeletionToTrash = vi.fn(async () => undefined)
    const applyRemoteChange = vi.fn(async () => undefined)
    const writeFile = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        moveRemoteDeletionToTrash,
        readFile: async () => '',
        writeFile,
      },
    )
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(moveRemoteDeletionToTrash).not.toHaveBeenCalled()
    expect(applyRemoteChange).toHaveBeenCalledWith('empty.ts', '')
    expect(writeFile).toHaveBeenCalledWith('empty.ts', '')
    await sync.stop()
  })

  it('拒绝通过符号链接写入项目外文件', async () => {
    const target = await createTestOplog()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-sync-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true\n', 'utf8')
    await symlink(join(outside, 'secret.ts'), join(target.root, 'external-link.ts'))
    const transport = new MockTransport()
    const input = {
      ...createOp('unsafe-link'),
      diff: createTwoFilesPatch('external-link.ts', 'external-link.ts', '', 'changed\n'),
      filePath: 'external-link.ts',
      kind: 'created' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const readFile = vi.fn(async () => '')
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        readFile,
        writeFile: vi.fn(async () => undefined),
      },
    )
    const failure = waitForEvent<[Error]>(sync, 'error')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })

    await expect(failure).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('符号链接越界') })])
    expect(readFile).not.toHaveBeenCalled()
    await sync.stop()
  })

  it('空基线无法应用修改操作时保存 pending，并在后续基线操作到达后自动重试', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = ''
    const input = {
      ...createOp('pending'),
      diff: createTwoFilesPatch('pending.ts', 'pending.ts', 'before\n', 'after\n'),
      filePath: 'pending.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const writeFile = vi.fn(async (_path: string, nextContent: string) => {
      content = nextContent
    })
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        readFile: async () => content,
        writeFile,
      },
    )
    const conflict = vi.fn()
    sync.on('conflict', conflict)
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(writeFile).not.toHaveBeenCalled()
    expect(conflict).not.toHaveBeenCalled()

    const baseInput = {
      ...createOp('pending-base'),
      diff: createTwoFilesPatch('/dev/null', 'pending.ts', '', 'before\n'),
      filePath: 'pending.ts',
      kind: 'created' as const,
    }
    const base = { ...baseInput, hash: computeHash(baseInput) }
    const baseRemoteOp = waitForEvent<[Op]>(sync, 'remoteOp')
    transport.emit('message', 'source', { op: base, type: 'data' })
    await baseRemoteOp

    expect(content).toBe('after\n')
    expect(writeFile).toHaveBeenCalledWith('pending.ts', 'after\n')
    await sync.stop()
  })

  it('收到远端删除 op 时先移入本地废纸篓，再清理 watcher 基线', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const moveRemoteDeletionToTrash = vi.fn(async () => undefined)
    const applyRemoteChange = vi.fn(async () => undefined)
    const input = {
      ...createOp('delete'),
      diff: createTwoFilesPatch('deleted.ts', 'deleted.ts', 'before\n', ''),
      filePath: 'deleted.ts',
      kind: 'deleted' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const writeFile = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        moveRemoteDeletionToTrash,
        readFile: async () => 'before\n',
        writeFile,
      },
    )
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(moveRemoteDeletionToTrash).toHaveBeenCalledWith('deleted.ts', remote.author, remote.hash)
    expect(applyRemoteChange).toHaveBeenCalledWith('deleted.ts', '', true)
    expect(writeFile).not.toHaveBeenCalled()
    await sync.stop()
  })

  it('无法应用远端 diff 时不覆盖本地内容，并持久化冲突信号', async () => {
    const target = await createTestOplog()
    const discovery = new MockDiscovery()
    const transport = new MockTransport()
    const content = 'different\n'
    const input = {
      ...createOp('conflict'),
      diff: createTwoFilesPatch('conflict.ts', 'conflict.ts', 'before\n', 'after\n'),
      filePath: 'conflict.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const writeFile = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, roomCode: 'ABCDEF' },
      { discovery: discovery as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        readFile: async () => content,
        writeFile,
      },
    )
    const conflict = vi.fn()
    sync.on('conflict', conflict)
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })

    await remoteOp
    expect(writeFile).not.toHaveBeenCalled()
    expect(conflict).toHaveBeenCalledWith(expect.objectContaining({ hash: remote.hash }), content)
    await sync.stop()
  })

  it('baseHash 匹配时直接应用远端 diff', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'base\n'
    const input = {
      ...createOp('base-match'),
      baseHash: createHash('sha256').update(content).digest('hex'),
      diff: createTwoFilesPatch('base-match.ts', 'base-match.ts', content, 'remote\n'),
      filePath: 'base-match.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )
    const applied = waitForEvent<[Op]>(sync, 'remoteOp')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await applied
    expect(content).toBe('remote\n')
    await sync.stop()
  })

  it('baseHash 不匹配时合并不重叠的本地和远端修改', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    const base = 'one\ntwo\nthree\n'
    let content = 'LOCAL\ntwo\nthree\n'
    await writeFile(join(target.root, 'merge.ts'), content, 'utf8')
    const baseHash = writeSnapshot(target.root, 'merge.ts', base)
    const input = {
      ...createOp('merge-clean'),
      baseHash,
      diff: createTwoFilesPatch('merge.ts', 'merge.ts', base, 'one\ntwo\nREMOTE\n'),
      filePath: 'merge.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )
    const applied = waitForEvent<[Op]>(sync, 'remoteOp')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await applied
    expect(content).toBe('LOCAL\ntwo\nREMOTE\n')
    await sync.stop()
  })

  it('三方合并冲突时保留主文件并保存远端版本', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    const base = 'same\n'
    let content = 'local\n'
    await writeFile(join(target.root, 'conflict.ts'), content, 'utf8')
    const baseHash = writeSnapshot(target.root, 'conflict.ts', base)
    const input = {
      ...createOp('merge-conflict'),
      baseHash,
      diff: createTwoFilesPatch('conflict.ts', 'conflict.ts', base, 'remote\n'),
      filePath: 'conflict.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )
    const conflict = waitForEvent<[Op, string]>(sync, 'conflict')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await conflict
    expect(content).toBe('local\n')
    await expect(readFile(join(target.root, 'conflict.ts.cairn-remote'), 'utf8')).resolves.toBe('remote\n')
    await sync.stop()
  })

  it('缺少 base 快照时退回普通 patch', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'base\n'
    const input = {
      ...createOp('missing-snapshot'),
      baseHash: 'f'.repeat(64),
      diff: createTwoFilesPatch('missing.ts', 'missing.ts', content, 'after\n'),
      filePath: 'missing.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )
    const applied = waitForEvent<[Op]>(sync, 'remoteOp')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await applied
    expect(content).toBe('after\n')
    await sync.stop()
  })

  it('本地不存在时跳过删除操作，保持幂等', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    const input = {
      ...createOp('missing-delete'),
      diff: createTwoFilesPatch('gone.ts', 'gone.ts', 'before\n', ''),
      filePath: 'gone.ts',
      kind: 'deleted' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const applyRemoteChange = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        fileExists: async () => false,
        readFile: async () => '',
        writeFile: vi.fn(async () => undefined),
      },
    )
    const applied = waitForEvent<[Op]>(sync, 'remoteOp')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await applied
    expect(applyRemoteChange).toHaveBeenCalledWith('gone.ts', '', true)
    await sync.stop()
  })
})
