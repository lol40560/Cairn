import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTwoFilesPatch } from 'diff'

import { computeHash, createOplog, type NewOp, type Oplog, type Op } from '../oplog'
import { decodeMessages, encodeMessage, type PeerInfo, type SyncMessage } from './protocol'
import { Sync } from './sync'
import { Transport } from './transport'

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
})

describe('Sync', () => {
  it('直连地址会转发给 transport.connect 并等待 hello 连接', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )

    await sync.start({ discovery: false })
    await sync.connectToAddress('192.168.1.10', 49500)

    expect(transport.connect).toHaveBeenCalledWith('192.168.1.10', 49500)
    expect(sync.listPeers()).toEqual([
      { host: '192.168.1.10', lastSeen: expect.any(Number), peerId: 'direct-peer', port: 49500 },
    ])
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
    expect(applyRemoteChange).toHaveBeenCalledWith('deleted.ts', '')
    expect(writeFile).not.toHaveBeenCalled()
    await sync.stop()
  })

  it('无法应用远端 diff 时报告冲突且不覆盖本地内容', async () => {
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
    const conflict = waitForEvent<[Op, string]>(sync, 'conflict')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })

    await expect(conflict).resolves.toEqual([{
      ...remote,
      kind: 'modified',
      source: 'remote',
    }, content])
    expect(writeFile).not.toHaveBeenCalled()
    await sync.stop()
  })
})
