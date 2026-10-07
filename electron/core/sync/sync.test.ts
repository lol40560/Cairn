import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTwoFilesPatch } from 'diff'

import { computeHash, createOplog, CURRENT_OP_HASH_VERSION, type NewOp, type Oplog, type Op } from '../oplog'
import { BlobStore } from '../blobs'
import { AUTH_PROTOCOL_VERSION, createClientProof, createServerProof, decodeMessages, decryptTransportMessage, deriveAuthKey, deriveRoomHash, deriveTransportSessionKeys, encryptTransportMessage, encodedMessageByteLength, encodeMessage, generateRoomSecret, isSyncMessageWithinLimit, MAX_APPLICATION_MESSAGE_BYTES, MAX_SYNC_MESSAGE_BYTES, normalizeRoomSecret, SYNC_PROTOCOL_VERSION, type PeerInfo, type SyncMessage, type TransportSessionKeys } from './protocol'
import { Sync } from './sync'
import { Transport } from './transport'
import { writeSnapshot } from '../watcher/snapshot'

const roots: string[] = []
const transports: Transport[] = []
const rawServers: Server[] = []
const rawSockets: Socket[] = []

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
): Promise<{ encode(message: SyncMessage): string; onMessage(listener: (message: SyncMessage) => void): void; send(message: SyncMessage): void }> {
  let buffer = ''
  const clientNonce = 'a'.repeat(64)
  let serverNonce = ''
  let keys: TransportSessionKeys | undefined
  let receiveSequence = 0n
  let sendSequence = 1n
  const messages = new EventEmitter()
  client.on('data', (chunk: Buffer) => {
    const decoded = decodeMessages(buffer + chunk.toString('utf8'))
    buffer = decoded.rest
    for (const message of decoded.messages) {
      if (message.type === 'auth-challenge') {
        serverNonce = message.serverNonce
        expect(message.serverProof).toBe(createServerProof(roomCode, deriveRoomHash(roomCode), clientNonce, message.serverNonce))
        client.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: createClientProof(roomCode, deriveRoomHash(roomCode), clientNonce, message.serverNonce) }))
      }
      if (message.type === 'auth-ok') {
        keys = deriveTransportSessionKeys(roomCode, deriveRoomHash(roomCode), clientNonce, serverNonce)
        client.write(encodeMessage(encryptTransportMessage(keys, 'client-to-server', 0n, { type: 'hello', peerId, version: SYNC_PROTOCOL_VERSION })))
      }
      if (message.type === 'secure' && keys) {
        const decrypted = decryptTransportMessage(keys, 'server-to-client', message)
        expect(message.sequence).toBe(receiveSequence.toString())
        receiveSequence += 1n
        messages.emit('message', decrypted)
      }
    }
  })
  const connected = waitForEvent<[string]>(receiver, 'connect')
  client.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId, roomHash: deriveRoomHash(roomCode), clientNonce }))
  await connected
  const encodeSecure = (message: SyncMessage): string => {
    if (!keys) throw new Error('raw secure client 未完成认证')
    const frame = encodeMessage(encryptTransportMessage(keys, 'client-to-server', sendSequence, message))
    sendSequence += 1n
    return frame
  }
  return {
    encode: encodeSecure,
    onMessage: (listener) => messages.on('message', listener),
    send: (message) => client.write(encodeSecure(message)),
  }
}

async function listenRawServer(handler: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    rawSockets.push(socket)
    handler(socket)
  })
  rawServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动测试 TCP 服务')
  return address.port
}

async function connectRawSocket(port: number): Promise<Socket> {
  const socket = new Socket()
  rawSockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => resolve())
    socket.connect(port, '127.0.0.1')
  })
  return socket
}

function onRawMessages(socket: Socket, listener: (message: SyncMessage) => void): void {
  let buffer = ''
  socket.on('data', (chunk: Buffer) => {
    const decoded = decodeMessages(buffer + chunk.toString('utf8'))
    buffer = decoded.rest
    decoded.messages.forEach(listener)
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
    hashVersion: CURRENT_OP_HASH_VERSION,
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
  readonly connect = vi.fn(async (host: string, port: number, attemptId?: string) => {
    this.emit('connect', 'direct-peer', { host, port }, attemptId)
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
  rawSockets.splice(0).forEach((socket) => socket.destroy())
  await Promise.all(rawServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
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
    expect(createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), 'a', 'b')).toMatch(/^[a-f0-9]{64}$/)
    expect(createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), 'a', 'b')).not.toBe(createClientProof('GHIJKL', deriveRoomHash('GHIJKL'), 'a', 'b'))
  })

  it('使用长度前缀 transcript 区分角色与字段边界', () => {
    const roomHash = deriveRoomHash('ABCDEF')

    expect(createClientProof('ABCDEF', roomHash, 'ab', 'c')).not.toBe(createClientProof('ABCDEF', roomHash, 'a', 'bc'))
    expect(createClientProof('ABCDEF', roomHash, 'client', 'server')).not.toBe(createServerProof('ABCDEF', roomHash, 'client', 'server'))
  })

  it('以实际 UTF-8 wire frame 限制 ASCII、CJK 与 emoji 内容', () => {
    const op = {
      ...createOp('wire-size'),
      hash: 'a'.repeat(64),
      hashVersion: CURRENT_OP_HASH_VERSION,
    }
    const ascii = { type: 'data' as const, op: { ...op, diff: 'a'.repeat(128) } }
    const cjk = { type: 'data' as const, op: { ...op, diff: '漢'.repeat(128) } }
    const emoji = { type: 'data' as const, op: { ...op, diff: '🧭'.repeat(128) } }
    expect(encodedMessageByteLength(cjk)).toBeGreaterThan(encodedMessageByteLength(ascii))
    expect(encodedMessageByteLength(emoji)).toBeGreaterThan(encodedMessageByteLength(cjk))
    expect(isSyncMessageWithinLimit(ascii)).toBe(true)
    expect(isSyncMessageWithinLimit({ type: 'data', op: { ...op, diff: '🧭'.repeat(MAX_SYNC_MESSAGE_BYTES) } })).toBe(false)
  })

  it('T-05: 新房间邀请码使用 128-bit 随机 Base32 密钥，并可规范化分组输入', () => {
    const first = generateRoomSecret()
    const second = generateRoomSecret()
    expect(first).toMatch(/^[A-Z2-7]{26}$/)
    expect(second).toMatch(/^[A-Z2-7]{26}$/)
    expect(first).not.toBe(second)
    expect(normalizeRoomSecret(first.match(/.{1,4}/g)!.join('-').toLowerCase())).toBe(first)
    expect(() => normalizeRoomSecret('ABCDEF')).toThrow(/128-bit/)
  })

  it('T-05: 固定 transcript 会导出稳定且方向分离的 HKDF 金钥', () => {
    const first = deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 's'.repeat(64))
    const second = deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 's'.repeat(64))
    expect(first.clientToServerKey).toEqual(second.clientToServerKey)
    expect(first.serverToClientKey).toEqual(second.serverToClientKey)
    expect(first.clientToServerKey).not.toEqual(first.serverToClientKey)
    expect(first.clientToServerNoncePrefix).not.toEqual(first.serverToClientNoncePrefix)
    expect(deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 't'.repeat(64)).clientToServerKey)
      .not.toEqual(first.clientToServerKey)
  })

  it('T-05: AES-GCM frame 绑定方向、序号与 transcript，修改内容或 tag 会失败', () => {
    const keys = deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 's'.repeat(64))
    const frame = encryptTransportMessage(keys, 'client-to-server', 0n, { type: 'have', hash: 'TOP_SECRET_TEST_PAYLOAD_123' })
    expect(decryptTransportMessage(keys, 'client-to-server', frame)).toEqual({ type: 'have', hash: 'TOP_SECRET_TEST_PAYLOAD_123' })
    expect(() => decryptTransportMessage(keys, 'server-to-client', frame)).toThrow(/验证失败/)
    const otherConnection = deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 't'.repeat(64))
    expect(() => decryptTransportMessage(otherConnection, 'client-to-server', frame)).toThrow(/验证失败/)
    expect(() => decryptTransportMessage(keys, 'client-to-server', { ...frame, ciphertext: `${frame.ciphertext[0] === 'A' ? 'B' : 'A'}${frame.ciphertext.slice(1)}` })).toThrow(/验证失败/)
    expect(() => decryptTransportMessage(keys, 'client-to-server', { ...frame, tag: `${frame.tag[0] === 'A' ? 'B' : 'A'}${frame.tag.slice(1)}` })).toThrow(/验证失败/)
  })

  it('T-05: 加密 envelope 预留 base64 与 tag 开销，近上限应用消息仍不超过 frame 上限', () => {
    const payload = { type: 'have' as const, hash: 'a'.repeat(MAX_APPLICATION_MESSAGE_BYTES - 128) }
    expect(isSyncMessageWithinLimit(payload)).toBe(true)
    const keys = deriveTransportSessionKeys('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'room-hash', 'c'.repeat(64), 's'.repeat(64))
    expect(encodedMessageByteLength(encryptTransportMessage(keys, 'client-to-server', 0n, payload))).toBeLessThanOrEqual(MAX_SYNC_MESSAGE_BYTES)
  })
})

describe('binary blob sync', () => {
  it('連線後宣告本地 blob，缺少 blob 的 peer 會請求下載', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const content = Buffer.from([1, 2, 3])
    const hash = await store.put(content)
    const transport = new MockTransport()
    const sync = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
    )

    await sync.start()
    transport.emit('connect', 'peer-a')
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith('peer-a', { type: 'have-blob', hash, size: content.length })
    })

    transport.send.mockClear()
    const missingHash = createHash('sha256').update('missing').digest('hex')
    transport.emit('message', 'peer-a', { type: 'have-blob', hash: missingHash, size: 7 })
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith('peer-a', { type: 'want-blob', hash: missingHash })
    })
    await sync.stop()
  })

  it('驗證 data-blob 雜湊後才存入 BlobStore，雜湊錯誤會被拒絕', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const transport = new MockTransport()
    const sync = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
    )
    const content = Buffer.from([9, 8, 7])
    const hash = createHash('sha256').update(content).digest('hex')

    await sync.start()
    transport.emit('message', 'peer-a', { type: 'data-blob', hash, data: content.toString('base64') })
    await vi.waitFor(async () => expect(await store.get(hash)).toEqual(content))

    const error = waitForEvent<[Error]>(sync, 'error')
    transport.emit('message', 'peer-a', { type: 'data-blob', hash, data: Buffer.from([0]).toString('base64') })
    await expect(error).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('blob hash mismatch') })])
    await sync.stop()
  })

  it('缺 blob 的 binary op 進入 pending，blob 到達後自動落盤', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const transport = new MockTransport()
    const content = Buffer.from([137, 80, 78, 71, 0, 42])
    const blobHash = createHash('sha256').update(content).digest('hex')
    const input: NewOp = {
      author: 'alice',
      baseHash: undefined,
      blobHash,
      diff: '',
      filePath: 'assets/logo.png',
      hashVersion: CURRENT_OP_HASH_VERSION,
      id: 'binary-pending',
      kind: 'created',
      parentHashes: [],
      size: content.length,
      timestamp: 1,
    }
    const remote: Op = { ...input, hash: computeHash(input) }
    const writeBinaryFile = vi.fn(async () => undefined)
    const applyRemoteChange = vi.fn(async () => undefined)
    const sync = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        readFile: async () => '',
        writeFile: vi.fn(async () => undefined),
        writeBinaryFile,
      },
    )

    await sync.start()
    transport.emit('message', 'peer-a', { op: remote, type: 'data' })
    await vi.waitFor(() => {
      expect(transport.broadcast).toHaveBeenCalledWith({ type: 'want-blob', hash: blobHash })
    })
    expect(writeBinaryFile).not.toHaveBeenCalled()
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('received')

    transport.emit('message', 'peer-a', { type: 'data-blob', hash: blobHash, data: content.toString('base64') })
    await vi.waitFor(() => {
      expect(writeBinaryFile).toHaveBeenCalledWith('assets/logo.png', content)
      expect(applyRemoteChange).toHaveBeenCalledWith('assets/logo.png', '', false, blobHash)
    })
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied')
    await sync.stop()
  })

  it('T-04 regression: a blob-dependent received op survives restart until its blob is available', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const content = Buffer.from([1, 2, 3, 4])
    const blobHash = createHash('sha256').update(content).digest('hex')
    const input: NewOp = {
      author: 'alice', blobHash, diff: '', filePath: 'assets/recovered.png', id: 'binary-restart',
      hashVersion: CURRENT_OP_HASH_VERSION, kind: 'created', parentHashes: [], size: content.length, timestamp: 1,
    }
    const remote: Op = { ...input, hash: computeHash(input) }
    target.oplog.putReceivedRemoteOp(remote)
    const first = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'first', transport: new MockTransport() as never },
      {
        applyRemoteChange: vi.fn(async () => undefined), readFile: async () => '', writeFile: vi.fn(async () => undefined),
        writeBinaryFile: vi.fn(async () => undefined),
      },
    )
    await first.start()
    await vi.waitFor(() => expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('received'))
    await first.stop()
    target.oplog.close()

    await store.put(content)
    const reopenedOplog = createOplog(target.root)
    const writeBinaryFile = vi.fn(async () => undefined)
    const second = new Sync(
      { blobStore: store, oplog: reopenedOplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'second', transport: new MockTransport() as never },
      {
        applyRemoteChange: vi.fn(async () => undefined), readFile: async () => '', writeFile: vi.fn(async () => undefined),
        writeBinaryFile,
      },
    )
    await second.start()
    await vi.waitFor(() => expect(reopenedOplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(writeBinaryFile).toHaveBeenCalledWith('assets/recovered.png', content)
    await second.stop()
    reopenedOplog.close()
  })

  it('已有 blob 時不會重複請求', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const hash = await store.put(Buffer.from('already-here'))
    const transport = new MockTransport()
    const sync = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
    )

    await sync.start()
    transport.emit('message', 'peer-a', { type: 'have-blob', hash, size: 12 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.send).not.toHaveBeenCalledWith('peer-a', { type: 'want-blob', hash })
    await sync.stop()
  })

  it('兩個真實 TCP Sync 會傳送 blob 並將 binary op 落盤', async () => {
    const source = await createTestOplog()
    const target = await createTestOplog()
    const sourceStore = new BlobStore(source.root)
    const targetStore = new BlobStore(target.root)
    const sourceTransport = new Transport('source')
    const targetTransport = new Transport('target')
    transports.push(sourceTransport, targetTransport)
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42])
    const blobHash = await sourceStore.put(content)

    const targetSync = new Sync(
      { blobStore: targetStore, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: targetTransport },
      {
        applyRemoteChange: async () => undefined,
        readFile: async () => '',
        writeFile: async () => undefined,
        writeBinaryFile: async (relativePath, data) => {
          const destination = join(target.root, relativePath)
          await mkdir(join(destination, '..'), { recursive: true })
          await writeFile(destination, data)
        },
      },
    )
    const sourceSync = new Sync(
      { blobStore: sourceStore, oplog: source.oplog, projectRoot: source.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'source', transport: sourceTransport },
    )

    await targetSync.start({ discovery: false })
    await sourceSync.start({ discovery: false })
    await sourceSync.connectToAddress('127.0.0.1', targetSync.getLocalPort()!, 'ABCDEF')
    await vi.waitFor(async () => expect(await targetStore.has(blobHash)).toBe(true))

    const input: NewOp = {
      author: 'alice', blobHash, diff: '', filePath: 'assets/logo.png', id: 'tcp-binary',
      hashVersion: CURRENT_OP_HASH_VERSION, kind: 'created', parentHashes: [], size: content.length, timestamp: 1,
    }
    const op = source.oplog.putOp(input)
    sourceSync.announceLocalOp(op)

    await vi.waitFor(async () => {
      await expect(readFile(join(target.root, 'assets', 'logo.png'))).resolves.toEqual(content)
    })
    await sourceSync.stop()
    await targetSync.stop()
  })
})

describe('transport', () => {
  it('hello 會攜帶可選的工作區 identity', async () => {
    const first = new Transport('first')
    const second = new Transport('second')
    first.setRoomCode('ABCDEF')
    second.setRoomCode('ABCDEF')
    first.setIdentity({ fingerprint: 'workspace', projectName: 'TownPass' })
    transports.push(first, second)
    const port = await second.listen()
    const hello = waitForEvent<[string, { fingerprint: string; projectName: string } | undefined]>(second, 'hello')

    await first.connect('127.0.0.1', port)

    await expect(hello).resolves.toEqual(['first', { fingerprint: 'workspace', projectName: 'TownPass' }])
  })

  it('让两个实例互连并互发消息', async () => {
    const first = new Transport('first')
    const second = new Transport('second')
    transports.push(first, second)
    const port = await second.listen()
    const connectedFirst = waitForEvent<[string]>(first, 'connect')
    const connectedSecond = waitForEvent<[string]>(second, 'connect')

    await first.connect('127.0.0.1', port)
    await expect(connectedFirst).resolves.toEqual(['second', { host: '127.0.0.1', port }, undefined])
    await expect(connectedSecond).resolves.toEqual(['first', undefined, undefined])

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
    const authenticated = await authenticateRawClient(receiver, client)
    const received = waitForEvent<[string, SyncMessage]>(receiver, 'message')
    const message = authenticated.encode({
      type: 'seeder-available',
      projectName: '中文 😀',
      size: 1,
      snapshotId: 'snapshot',
    })
    const bytes = Buffer.from(message)
    const splitAt = Math.floor(bytes.length / 2)
    // 使用认证后的同一方向加密帧验证 StringDecoder 仍可处理 UTF-8 分片。
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
    client.write(`{"type":"secure","encryptionVersion":1,"sequence":"1","ciphertext":"${'a'.repeat(MAX_SYNC_MESSAGE_BYTES + 1)}","tag":"${'a'.repeat(24)}"}\n`)

    await expect(failure).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('超过') })])
    client.destroy()
  })

  it('收到 ping 时回复 pong', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = new Socket()
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    const authenticated = await authenticateRawClient(receiver, client)
    const pong = new Promise<void>((resolve) => authenticated.onMessage((message) => {
      if (message.type === 'pong') resolve()
    }))
    authenticated.send({ type: 'ping' })

    await expect(pong).resolves.toBeUndefined()
    client.destroy()
  })

  it('T-05: 认证后应用数据在 wire 上不泄露明文', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const authenticated = await authenticateRawClient(receiver, client)
    const marker = 'TOP_SECRET_TEST_PAYLOAD_123'
    const wire = new Promise<string>((resolve) => client.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))
    const delivered = new Promise<void>((resolve) => authenticated.onMessage((message) => {
      if (message.type === 'have' && message.hash === marker) resolve()
    }))

    receiver.send('sender', { type: 'have', hash: marker })

    expect(await wire).not.toContain(marker)
    await delivered
  })

  it('T-05: 重播或跳过加密 frame 会终止连接且不重复派发', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const authenticated = await authenticateRawClient(receiver, client)
    const received = vi.fn()
    receiver.on('message', received)
    const replay = authenticated.encode({ type: 'have', hash: 'once' })
    const first = waitForEvent<[string, SyncMessage]>(receiver, 'message')
    client.write(replay)
    await expect(first).resolves.toEqual(['sender', { type: 'have', hash: 'once' }])
    const failure = waitForEvent<[Error]>(receiver, 'error')
    client.write(replay)
    expect((await failure)[0].message).toContain('序号不连续')
    expect(received).toHaveBeenCalledOnce()

    const secondReceiver = new Transport('receiver-two')
    transports.push(secondReceiver)
    const secondPort = await secondReceiver.listen()
    const secondClient = await connectRawSocket(secondPort)
    const secondAuthenticated = await authenticateRawClient(secondReceiver, secondClient)
    void secondAuthenticated.encode({ type: 'have', hash: 'skipped-1' })
    const skipped = secondAuthenticated.encode({ type: 'have', hash: 'skipped-2' })
    const skipFailure = waitForEvent<[Error]>(secondReceiver, 'error')
    secondClient.write(skipped)
    expect((await skipFailure)[0].message).toContain('序号不连续')
  })

  it('T-05: 被篡改的 ciphertext 或 tag 不会进入应用层', async () => {
    const receiver = new Transport('receiver')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const authenticated = await authenticateRawClient(receiver, client)
    const encoded = authenticated.encode({ type: 'have', hash: 'tamper' })
    const frame = JSON.parse(encoded) as Extract<SyncMessage, { type: 'secure' }>
    frame.tag = `${frame.tag[0] === 'A' ? 'B' : 'A'}${frame.tag.slice(1)}`
    const failure = waitForEvent<[Error]>(receiver, 'error')
    client.write(encodeMessage(frame))
    expect((await failure)[0].message).toContain('验证失败')
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
    client.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('GHIJKL'), clientNonce: 'a'.repeat(64) }))

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
        client.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: '0'.repeat(64) }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
      client.connect(port, '127.0.0.1')
    })
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')
    client.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('ABCDEF'), clientNonce: 'a'.repeat(64) }))

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
    client.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('ABCDEF'), clientNonce: 'a'.repeat(64) }))

    expect((await failed)[0].message).toBe('认证超时')
    client.destroy()
  })

  it('regression: client 不信任伪造服务器直接发送的 auth-ok', async () => {
    const port = await listenRawServer((socket) => {
      onRawMessages(socket, (message) => {
        if (message.type === 'auth-request') {
          socket.write(encodeMessage({ type: 'auth-ok' }))
        }
      })
    })
    const client = new Transport('client')
    client.setRoomCode('ABCDEF')
    transports.push(client)
    const connected = vi.fn()
    client.on('connect', connected)
    const failed = waitForEvent<[Error]>(client, 'authFailed')

    await client.connect('127.0.0.1', port)

    expect((await failed)[0].message).toBe('无效认证确认')
    expect(connected).not.toHaveBeenCalled()
  })

  it('regression: 被修改的有效长度 server proof 不会得到 client proof', async () => {
    let clientProofs = 0
    const port = await listenRawServer((socket) => {
      onRawMessages(socket, (message) => {
        if (message.type === 'auth-request') {
          const serverNonce = 'b'.repeat(64)
          const valid = createServerProof('ABCDEF', message.roomHash, message.clientNonce, serverNonce)
          const altered = `${valid[0] === '0' ? '1' : '0'}${valid.slice(1)}`
          socket.write(encodeMessage({ type: 'auth-challenge', authVersion: AUTH_PROTOCOL_VERSION, serverNonce, serverProof: altered }))
        }
        if (message.type === 'auth-response') clientProofs += 1
      })
    })
    const client = new Transport('client')
    client.setRoomCode('ABCDEF')
    transports.push(client)
    const failed = waitForEvent<[Error]>(client, 'authFailed')

    await client.connect('127.0.0.1', port)

    expect((await failed)[0].message).toBe('Invalid server proof')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(clientProofs).toBe(0)
  })

  it('regression: 舊 server proof 不可在新 client nonce 上重播', async () => {
    let recordedChallenge: Extract<SyncMessage, { type: 'auth-challenge' }> | undefined
    let resolveFirstProof: (() => void) | undefined
    const firstProofReceived = new Promise<void>((resolve) => { resolveFirstProof = resolve })
    const port = await listenRawServer((socket) => {
      onRawMessages(socket, (message) => {
        if (message.type === 'auth-response') {
          socket.write(encodeMessage({ type: 'auth-ok' }))
          resolveFirstProof?.()
          return
        }
        if (message.type !== 'auth-request') return
        if (!recordedChallenge) {
          const serverNonce = 'c'.repeat(64)
          recordedChallenge = {
            type: 'auth-challenge',
            authVersion: AUTH_PROTOCOL_VERSION,
            serverNonce,
            serverProof: createServerProof('ABCDEF', message.roomHash, message.clientNonce, serverNonce),
          }
          socket.write(encodeMessage(recordedChallenge))
          return
        }
        socket.write(encodeMessage(recordedChallenge))
      })
    })
    const first = new Transport('first')
    first.setRoomCode('ABCDEF')
    transports.push(first)
    await first.connect('127.0.0.1', port)
    await firstProofReceived

    const second = new Transport('second')
    second.setRoomCode('ABCDEF')
    transports.push(second)
    const failed = waitForEvent<[Error]>(second, 'authFailed')
    await second.connect('127.0.0.1', port)

    expect((await failed)[0].message).toBe('Invalid server proof')
  })

  it('regression: 舊 client proof 不可在新 server challenge 上重播', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const first = await connectRawSocket(port)
    const firstNonce = 'd'.repeat(64)
    let oldProof: string | undefined
    let firstServerNonce = ''
    onRawMessages(first, (message) => {
      if (message.type === 'auth-challenge') {
        firstServerNonce = message.serverNonce
        oldProof = createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), firstNonce, message.serverNonce)
        first.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: oldProof }))
      }
      if (message.type === 'auth-ok') first.write(encodeMessage(encryptTransportMessage(
        deriveTransportSessionKeys('ABCDEF', deriveRoomHash('ABCDEF'), firstNonce, firstServerNonce),
        'client-to-server', 0n, { type: 'hello', peerId: 'first', version: SYNC_PROTOCOL_VERSION },
      )))
    })
    const firstConnected = waitForEvent(receiver, 'connect')
    first.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'first', roomHash: deriveRoomHash('ABCDEF'), clientNonce: firstNonce }))
    await firstConnected
    expect(oldProof).toBeDefined()

    const second = await connectRawSocket(port)
    onRawMessages(second, (message) => {
      if (message.type === 'auth-challenge') {
        second.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: oldProof! }))
      }
    })
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')
    second.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'second', roomHash: deriveRoomHash('ABCDEF'), clientNonce: 'e'.repeat(64) }))

    expect((await failed)[0].message).toBe('认证失败')
  })

  it('regression: 握手状态机拒绝越序与重复认证消息', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')

    client.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: '0'.repeat(64) }))

    expect((await failed)[0].message).toBe('无效或已使用的认证挑战')
  })

  it('regression: client 拒绝重复 server challenge', async () => {
    const port = await listenRawServer((socket) => {
      onRawMessages(socket, (message) => {
        if (message.type !== 'auth-request') return
        const serverNonce = 'f'.repeat(64)
        const challenge = {
          type: 'auth-challenge' as const,
          authVersion: AUTH_PROTOCOL_VERSION as 2,
          serverNonce,
          serverProof: createServerProof('ABCDEF', message.roomHash, message.clientNonce, serverNonce),
        }
        socket.write(`${encodeMessage(challenge)}${encodeMessage(challenge)}`)
      })
    })
    const client = new Transport('client')
    client.setRoomCode('ABCDEF')
    transports.push(client)
    const failed = waitForEvent<[Error]>(client, 'authFailed')

    await client.connect('127.0.0.1', port)

    expect((await failed)[0].message).toBe('无效认证挑战')
  })

  it('regression: server 拒绝重复 client response', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const clientNonce = '1'.repeat(64)
    onRawMessages(client, (message) => {
      if (message.type !== 'auth-challenge') return
      const proof = createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), clientNonce, message.serverNonce)
      const response = { type: 'auth-response' as const, authVersion: AUTH_PROTOCOL_VERSION as 2, clientProof: proof }
      client.write(`${encodeMessage(response)}${encodeMessage(response)}`)
    })
    const failed = waitForEvent<[Error]>(receiver, 'error')

    client.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('ABCDEF'), clientNonce }))

    expect((await failed)[0].message).toBe('认证完成后不接受明文认证消息')
  })

  it('regression: 认证失败后会清理 peer 状态并允许重试', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const rejected = await connectRawSocket(port)
    const firstFailed = waitForEvent<[Error]>(receiver, 'authFailed')
    onRawMessages(rejected, (message) => {
      if (message.type === 'auth-challenge') {
        rejected.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: '0'.repeat(64) }))
      }
    })
    rejected.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('ABCDEF'), clientNonce: '2'.repeat(64) }))
    await firstFailed

    const retry = await connectRawSocket(port)
    const clientNonce = '3'.repeat(64)
    let retryServerNonce = ''
    onRawMessages(retry, (message) => {
      if (message.type === 'auth-challenge') {
        retryServerNonce = message.serverNonce
        retry.write(encodeMessage({ type: 'auth-response', authVersion: AUTH_PROTOCOL_VERSION, clientProof: createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), clientNonce, message.serverNonce) }))
      }
      if (message.type === 'auth-ok') retry.write(encodeMessage(encryptTransportMessage(
        deriveTransportSessionKeys('ABCDEF', deriveRoomHash('ABCDEF'), clientNonce, retryServerNonce),
        'client-to-server', 0n, { type: 'hello', peerId: 'sender', version: SYNC_PROTOCOL_VERSION },
      )))
    })
    const connected = waitForEvent(receiver, 'connect')
    retry.write(encodeMessage({ type: 'auth-request', authVersion: AUTH_PROTOCOL_VERSION, peerId: 'sender', roomHash: deriveRoomHash('ABCDEF'), clientNonce }))

    await expect(connected).resolves.toEqual(['sender', undefined, undefined])
  })

  it('regression: 认证完成后拒绝明文 sync hello，避免降级为未加密传输', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const client = await connectRawSocket(port)
    const connected = vi.fn()
    receiver.on('connect', connected)
    const error = waitForEvent<[Error]>(receiver, 'error')
    const clientNonce = '4'.repeat(64)
    onRawMessages(client, (message) => {
      if (message.type === 'auth-challenge') {
        client.write(encodeMessage({
          type: 'auth-response',
          authVersion: AUTH_PROTOCOL_VERSION,
          clientProof: createClientProof('ABCDEF', deriveRoomHash('ABCDEF'), clientNonce, message.serverNonce),
        }))
      }
      if (message.type === 'auth-ok') client.write(encodeMessage({ type: 'hello', peerId: 'legacy-peer', version: 4 }))
    })

    client.write(encodeMessage({
      type: 'auth-request',
      authVersion: AUTH_PROTOCOL_VERSION,
      peerId: 'legacy-peer',
      roomHash: deriveRoomHash('ABCDEF'),
      clientNonce,
    }))

    expect((await error)[0].message).toContain('认证完成后不接受明文同步消息')
    expect(connected).not.toHaveBeenCalled()
  })

  it('regression: 认证前 hello 与同步数据不会进入应用层', async () => {
    const receiver = new Transport('receiver')
    receiver.setRoomCode('ABCDEF')
    transports.push(receiver)
    const port = await receiver.listen()
    const helloClient = await connectRawSocket(port)
    const hello = vi.fn()
    const message = vi.fn()
    receiver.on('hello', hello)
    receiver.on('message', message)
    const failed = waitForEvent<[Error]>(receiver, 'authFailed')

    helloClient.write(encodeMessage({ type: 'hello', peerId: 'attacker', version: SYNC_PROTOCOL_VERSION }))

    expect((await failed)[0].message).toBe('认证尚未完成')
    expect(hello).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()

    const dataClient = await connectRawSocket(port)
    const error = waitForEvent<[Error]>(receiver, 'error')
    dataClient.write(encodeMessage({ type: 'have', hash: 'pre-auth' }))
    expect((await error)[0].message).toBe('收到握手前的同步消息')
    expect(message).not.toHaveBeenCalled()
  })
})

describe('large text blob fallback', () => {
  it('reconstructs an oversized-text fallback byte-for-byte through the normal text baseline path', async () => {
    const target = await createTestOplog()
    const store = new BlobStore(target.root)
    const text = 'ASCII\n繁體中文\nemoji 🧭\n'.repeat(64)
    const content = Buffer.from(text, 'utf8')
    const blobHash = await store.put(content)
    const transport = new MockTransport()
    const input: NewOp = {
      ...createOp('large-text'),
      blobHash,
      contentEncoding: 'full-text-blob',
      diff: '',
      filePath: 'src/large.ts',
      kind: 'created',
      size: content.length,
    }
    const remote = { ...input, hash: computeHash(input) }
    let written = ''
    const applyRemoteChange = vi.fn(async () => undefined)
    const sync = new Sync(
      { blobStore: store, oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        fileExists: async () => false,
        readFile: async () => '',
        writeFile: async (_path, value) => { written = value },
      },
    )
    const remoteOp = waitForEvent<[Op]>(sync, 'remoteOp')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await remoteOp

    expect(Buffer.from(written, 'utf8')).toEqual(content)
    expect(applyRemoteChange).toHaveBeenCalledWith('src/large.ts', text)
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied')
    await sync.stop()
  })

  it('chunks a blob whose base64 data frame would exceed the transport limit', async () => {
    const sourceFixture = await createTestOplog()
    const targetFixture = await createTestOplog()
    const sourceStore = new BlobStore(sourceFixture.root)
    const targetStore = new BlobStore(targetFixture.root)
    const content = Buffer.alloc(MAX_SYNC_MESSAGE_BYTES + 1_024, 0x61)
    const hash = await sourceStore.put(content)
    const sourceTransport = new MockTransport()
    const targetTransport = new MockTransport()
    const source = new Sync(
      { blobStore: sourceStore, oplog: sourceFixture.oplog, projectRoot: sourceFixture.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'source', transport: sourceTransport as never },
    )
    const target = new Sync(
      { blobStore: targetStore, oplog: targetFixture.oplog, projectRoot: targetFixture.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: targetTransport as never },
    )
    await Promise.all([source.start(), target.start()])

    await (source as unknown as { handleWantBlob(peerId: string, requestedHash: string): Promise<void> }).handleWantBlob('target', hash)
    const sent = sourceTransport.send.mock.calls.map(([, message]) => message as SyncMessage)
    expect(sent[0]).toMatchObject({ type: 'blob-meta', hash, size: content.length })
    expect(sent.filter((message) => message.type === 'blob-chunk')).not.toHaveLength(0)
    expect(sent.every((message) => isSyncMessageWithinLimit(message))).toBe(true)

    for (const message of sent) targetTransport.emit('message', 'source', message)
    await vi.waitFor(async () => expect(await targetStore.get(hash)).toEqual(content), { timeout: 20_000 })

    await Promise.all([source.stop(), target.stop()])
  }, 30_000)
})

describe('Sync', () => {
  it('断线后会重连，并在重连完成后重新交换 have', async () => {
    vi.useFakeTimers()
    const { oplog } = await createTestOplog()
    const localOp = oplog.putOp(createOp('reconnect'))
    const transport = new MockTransport()
    transport.connect.mockImplementation(async (host: string, port: number, attemptId?: string) => {
      transport.emit('connect', 'peer-a', { host, port }, attemptId)
    })
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    await sync.start({ discovery: false })
    transport.emit('connect', 'peer-a', { host: '192.168.1.5', port: 49500 })
    transport.send.mockClear()
    const reconnecting = waitForEvent<[{
      peerId: string
      status: string
      attempt: number
    }]>(sync, 'peerStatusChanged')
    transport.emit('disconnect', 'peer-a')
    expect((await reconnecting)[0]).toMatchObject({ attempt: 1, peerId: 'peer-a', status: 'reconnecting' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.connect).toHaveBeenCalledWith('192.168.1.5', 49500, expect.any(String))
    expect(transport.send).toHaveBeenCalledWith('peer-a', { hash: localOp.hash, type: 'have' })
    await sync.stop()
    vi.useRealTimers()
  })

  it('相同工作區指紋會回覆 identity-ok', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const identity = { fingerprint: 'same', projectName: 'TownPass' }
    const sync = new Sync(
      { identity, oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )

    await sync.start({ discovery: false })
    transport.emit('hello', 'peer-a', identity)

    expect(transport.send).toHaveBeenCalledWith('peer-a', { type: 'identity-ok' })
    await sync.stop()
  })

  it('不同工作區指紋會發出 mismatch 事件並通知對端', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const localIdentity = { baseCommit: 'a'.repeat(40), fingerprint: 'local', projectName: 'TownPass' }
    const remoteIdentity = { baseCommit: 'b'.repeat(40), fingerprint: 'remote', projectName: 'OldTownPass' }
    const sync = new Sync(
      { identity: localIdentity, oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    const mismatch = waitForEvent<[{
      peerId: string
      hostIdentity: typeof localIdentity
      guestIdentity: typeof remoteIdentity
    }]>(sync, 'identityMismatch')

    await sync.start({ discovery: false })
    transport.emit('hello', 'peer-a', remoteIdentity)

    expect((await mismatch)[0]).toEqual({
      guestIdentity: remoteIdentity,
      hostIdentity: localIdentity,
      peerId: 'peer-a',
    })
    expect(transport.send).toHaveBeenCalledWith('peer-a', {
      hostIdentity: localIdentity,
      reason: 'workspace-fingerprint-differs',
      type: 'identity-mismatch',
      yourIdentity: remoteIdentity,
    })
    await sync.stop()
  })

  it('未帶 identity 的舊版 hello 會略過檢查', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    const sync = new Sync(
      { identity: { fingerprint: 'local', projectName: 'TownPass' }, oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )

    await sync.start({ discovery: false })
    transport.emit('hello', 'peer-a', undefined)

    expect(transport.send).not.toHaveBeenCalled()
    await sync.stop()
  })

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

    expect(transport.connect).toHaveBeenCalledWith('192.168.1.10', 49500, expect.any(String))
    expect(sync.listPeers()).toEqual([
      { host: '192.168.1.10', lastSeen: expect.any(Number), peerId: 'direct-peer', port: 49500 },
    ])
    expect(seeder.announceToPeer).toHaveBeenCalledWith('direct-peer')
    await sync.stop()
  })

  it('regression: overlapping direct attempts only settle their own authenticated connection', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    transport.connect.mockImplementation(async () => undefined)
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    sync.on('error', () => undefined)
    await sync.start({ discovery: false })

    let firstSettled = false
    const first = sync.connectToAddress('10.0.0.1', 41001).finally(() => { firstSettled = true })
    const second = sync.connectToAddress('10.0.0.2', 41002)
    const firstAttempt = transport.connect.mock.calls[0]?.[2] as string
    const secondAttempt = transport.connect.mock.calls[1]?.[2] as string

    transport.emit('connect', 'peer-b', { host: '10.0.0.2', port: 41002 }, secondAttempt)
    await expect(second).resolves.toBeUndefined()
    await Promise.resolve()
    expect(firstSettled).toBe(false)

    transport.emit('authFailed', new Error('first failed'), undefined, { host: '10.0.0.1', port: 41001 }, firstAttempt)
    await expect(first).rejects.toThrow('first failed')
    expect((sync as unknown as { connectionAttempts: Map<string, unknown> }).connectionAttempts.size).toBe(0)
    await sync.stop()
  })

  it('regression: reconnect completion cannot resolve a manual direct attempt', async () => {
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    transport.connect.mockImplementation(async () => undefined)
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    sync.on('error', () => undefined)
    await sync.start({ discovery: false })

    const reconnect = (sync as unknown as { reconnectPeer(peerId: string, host: string, port: number): Promise<void> })
      .reconnectPeer('known-peer', '10.0.0.3', 41003)
    const manual = sync.connectToAddress('10.0.0.4', 41004)
    const reconnectAttempt = transport.connect.mock.calls[0]?.[2] as string
    const manualAttempt = transport.connect.mock.calls[1]?.[2] as string

    transport.emit('connect', 'known-peer', { host: '10.0.0.3', port: 41003 }, reconnectAttempt)
    await expect(reconnect).resolves.toBeUndefined()
    transport.emit('authFailed', new Error('manual failed'), undefined, { host: '10.0.0.4', port: 41004 }, manualAttempt)
    await expect(manual).rejects.toThrow('manual failed')
    expect((sync as unknown as { connectionAttempts: Map<string, unknown> }).connectionAttempts.size).toBe(0)
    await sync.stop()
  })

  it('regression: a timed-out or stale attempt cannot affect a newer direct connection', async () => {
    vi.useFakeTimers()
    const { oplog } = await createTestOplog()
    const transport = new MockTransport()
    transport.connect.mockImplementation(async () => undefined)
    const sync = new Sync(
      { oplog, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'local', transport: transport as never },
    )
    await sync.start({ discovery: false })

    const first = sync.connectToAddress('10.0.0.5', 41005).then(
      () => undefined,
      (error: Error) => error,
    )
    const firstAttempt = transport.connect.mock.calls[0]?.[2] as string
    await vi.advanceTimersByTimeAsync(9_999)
    const second = sync.connectToAddress('10.0.0.6', 41006)
    const secondAttempt = transport.connect.mock.calls[1]?.[2] as string
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toEqual(expect.objectContaining({ message: '连接 10.0.0.5:41005 超时' }))
    expect((sync as unknown as { connectionAttempts: Map<string, unknown> }).connectionAttempts.size).toBe(1)

    // 已完成 attempt 的迟到成功事件不能完成新的 promise。
    transport.emit('connect', 'stale-peer', { host: '10.0.0.5', port: 41005 }, firstAttempt)
    expect((sync as unknown as { connectionAttempts: Map<string, unknown> }).connectionAttempts.size).toBe(1)
    transport.emit('connect', 'fresh-peer', { host: '10.0.0.6', port: 41006 }, secondAttempt)
    await expect(second).resolves.toBeUndefined()
    expect((sync as unknown as { connectionAttempts: Map<string, unknown> }).connectionAttempts.size).toBe(0)
    await sync.stop()
    vi.useRealTimers()
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
    expect(second.oplog.getOp(sourceOp.hash)).toMatchObject({
      author: sourceOp.author,
      diff: sourceOp.diff,
      filePath: sourceOp.filePath,
      hash: sourceOp.hash,
      id: sourceOp.id,
      source: 'remote',
    })
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
    // wire payload 即使自稱 local，接收端仍必須依接收路徑標記為 remote。
    const validOp: Op = { ...input, hash: computeHash(input), source: 'local' }
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
      source: 'remote',
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
        fileExists: async () => true,
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

  it('regression: 拒绝通过符号链接写入项目外文件', async () => {
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

    await expect(failure).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('symbolic link') })])
    expect(readFile).not.toHaveBeenCalled()
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('rejected')
    await sync.stop()
  })

  it('regression: destination volume 不分大小寫時拒絕 remote op 的 case collision', async () => {
    const target = await createTestOplog()
    await writeFile(join(target.root, 'foo.ts'), 'local\n', 'utf8')
    const transport = new MockTransport()
    const input = {
      ...createOp('case-collision'),
      diff: createTwoFilesPatch('Foo.ts', 'Foo.ts', '', 'remote\n'),
      filePath: 'Foo.ts',
      kind: 'created' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const writeRemoteFile = vi.fn(async () => undefined)
    const sync = new Sync(
      {
        caseInsensitiveFilesystem: true,
        oplog: target.oplog,
        projectRoot: target.root,
        roomCode: 'ABCDEF',
      },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        readFile: vi.fn(async () => ''),
        writeFile: writeRemoteFile,
      },
    )
    const failure = waitForEvent<[Error]>(sync, 'error')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })

    await expect(failure).resolves.toEqual([expect.objectContaining({ message: expect.stringContaining('Case-colliding') })])
    expect(writeRemoteFile).not.toHaveBeenCalled()
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('rejected')
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
        fileExists: async () => content !== '',
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
        fileExists: async () => true,
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

  it('regression: 远端删除会移除实际存在的空文件并更新基线', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    const filePath = 'empty.ts'
    const absolutePath = join(target.root, filePath)
    await writeFile(absolutePath, '')
    const input = {
      ...createOp('empty-delete'),
      diff: createTwoFilesPatch(filePath, filePath, '', ''),
      filePath,
      kind: 'deleted' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const applyRemoteChange = vi.fn(async () => undefined)
    const moveRemoteDeletionToTrash = vi.fn(async (relativePath: string) => {
      await unlink(join(target.root, relativePath))
    })
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        fileExists: async (relativePath) => {
          try {
            await readFile(join(target.root, relativePath))
            return true
          } catch {
            return false
          }
        },
        moveRemoteDeletionToTrash,
        readFile: async (relativePath) => readFile(join(target.root, relativePath), 'utf8'),
        writeFile: vi.fn(async () => undefined),
      },
    )

    const applied = waitForEvent<[Op]>(sync, 'remoteOp')
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await applied

    await expect(readFile(absolutePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(moveRemoteDeletionToTrash).toHaveBeenCalledWith(filePath, 'alice', remote.hash)
    expect(applyRemoteChange).toHaveBeenCalledWith(filePath, '', true)
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied')
    await sync.stop()
  })

  it('T-04: only marks a received remote op applied after its filesystem mutation and baseline succeed', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'before\n'
    const input = {
      ...createOp('durable-normal'),
      diff: createTwoFilesPatch('durable.ts', 'durable.ts', 'before\n', 'after\n'),
      filePath: 'durable.ts',
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

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await vi.waitFor(() => expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(content).toBe('after\n')
    await sync.stop()
  })

  it('T-04 regression: a failed write remains received and a duplicate delivery retries it', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'before\n'
    let failWrite = true
    const input = {
      ...createOp('durable-retry'),
      diff: createTwoFilesPatch('retry.ts', 'retry.ts', 'before\n', 'after\n'),
      filePath: 'retry.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const applyRemoteChange = vi.fn(async () => undefined)
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange,
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => {
          if (failWrite) throw new Error('ENOSPC')
          content = next
        },
      },
    )
    const firstFailure = waitForEvent<[Error]>(sync, 'error')

    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await expect(firstFailure).resolves.toEqual([expect.objectContaining({ message: 'ENOSPC' })])
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('received')
    expect(applyRemoteChange).not.toHaveBeenCalled()

    failWrite = false
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await vi.waitFor(() => expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(content).toBe('after\n')
    await sync.stop()
  })

  it('T-04 regression: startup recovers a durable remote op stored before filesystem apply', async () => {
    const target = await createTestOplog()
    let content = 'before\n'
    const input = {
      ...createOp('crash-before-write'),
      diff: createTwoFilesPatch('recover.ts', 'recover.ts', 'before\n', 'after\n'),
      filePath: 'recover.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    target.oplog.putReceivedRemoteOp(remote)
    target.oplog.close()
    const reopenedOplog = createOplog(target.root)
    const sync = new Sync(
      { oplog: reopenedOplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: new MockTransport() as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )

    await sync.start()
    await vi.waitFor(() => expect(reopenedOplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(content).toBe('after\n')
    await sync.stop()
    reopenedOplog.close()
  })

  it('T-04 regression: recovery reconciles a write that completed before the applied marker', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'before\n'
    const input = {
      ...createOp('crash-after-write'),
      diff: createTwoFilesPatch('reconcile.ts', 'reconcile.ts', 'before\n', 'after\n'),
      filePath: 'reconcile.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const first = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      {
        afterFilesystemApplyBeforeMarkApplied: async () => { throw new Error('simulated crash') },
        discovery: new MockDiscovery() as unknown as never,
        peerId: 'target-first',
        transport: transport as never,
      },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: async (_path, next) => { content = next },
      },
    )
    const crash = waitForEvent<[Error]>(first, 'error')
    await first.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await expect(crash).resolves.toEqual([expect.objectContaining({ message: 'simulated crash' })])
    expect(content).toBe('after\n')
    expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('received')
    await first.stop()
    target.oplog.close()

    const rewrite = vi.fn(async (_path: string, next: string) => { content = next })
    const reopenedOplog = createOplog(target.root)
    const second = new Sync(
      { oplog: reopenedOplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target-second', transport: new MockTransport() as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile: rewrite,
      },
    )
    await second.start()
    await vi.waitFor(() => expect(reopenedOplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(rewrite).not.toHaveBeenCalled()
    expect(content).toBe('after\n')
    await second.stop()
    reopenedOplog.close()
  })

  it('T-04 regression: an already applied duplicate has no additional filesystem side effect', async () => {
    const target = await createTestOplog()
    const transport = new MockTransport()
    let content = 'before\n'
    const input = {
      ...createOp('duplicate-applied'),
      diff: createTwoFilesPatch('duplicate.ts', 'duplicate.ts', 'before\n', 'after\n'),
      filePath: 'duplicate.ts',
    }
    const remote = { ...input, hash: computeHash(input) }
    const writeFile = vi.fn(async (_path: string, next: string) => { content = next })
    const sync = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target', transport: transport as never },
      {
        applyRemoteChange: vi.fn(async () => undefined),
        fileExists: async () => true,
        readFile: async () => content,
        writeFile,
      },
    )
    await sync.start()
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await vi.waitFor(() => expect(target.oplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    transport.emit('message', 'source', { op: remote, type: 'data' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writeFile).toHaveBeenCalledOnce()
    await sync.stop()
  })

  it('T-04 regression: a delete is idempotent after a crash before its applied marker', async () => {
    const target = await createTestOplog()
    let exists = true
    let content = 'before\n'
    const input = {
      ...createOp('delete-recovery'),
      diff: createTwoFilesPatch('delete.ts', 'delete.ts', 'before\n', ''),
      filePath: 'delete.ts',
      kind: 'deleted' as const,
    }
    const remote = { ...input, hash: computeHash(input) }
    const moveToTrash = vi.fn(async () => { exists = false; content = '' })
    const firstTransport = new MockTransport()
    const first = new Sync(
      { oplog: target.oplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      {
        afterFilesystemApplyBeforeMarkApplied: async () => { throw new Error('simulated crash') },
        discovery: new MockDiscovery() as unknown as never,
        peerId: 'target-first',
        transport: firstTransport as never,
      },
      {
        applyRemoteChange: vi.fn(async () => undefined), fileExists: async () => exists,
        moveRemoteDeletionToTrash: moveToTrash, readFile: async () => content, writeFile: vi.fn(async () => undefined),
      },
    )
    const crash = waitForEvent<[Error]>(first, 'error')
    await first.start()
    firstTransport.emit('message', 'source', { op: remote, type: 'data' })
    await crash
    expect(exists).toBe(false)
    await first.stop()
    target.oplog.close()

    const reopenedOplog = createOplog(target.root)
    const second = new Sync(
      { oplog: reopenedOplog, projectRoot: target.root, roomCode: 'ABCDEF' },
      { discovery: new MockDiscovery() as unknown as never, peerId: 'target-second', transport: new MockTransport() as never },
      {
        applyRemoteChange: vi.fn(async () => undefined), fileExists: async () => exists,
        moveRemoteDeletionToTrash: moveToTrash, readFile: async () => content, writeFile: vi.fn(async () => undefined),
      },
    )
    await second.start()
    await vi.waitFor(() => expect(reopenedOplog.getRemoteOpApplyState(remote.hash)).toBe('applied'))
    expect(moveToTrash).toHaveBeenCalledOnce()
    await second.stop()
    reopenedOplog.close()
  })
})
