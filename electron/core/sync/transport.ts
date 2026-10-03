import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

import { createAuthHmac, decodeMessages, deriveRoomHash, encodeMessage, type SyncMessage } from './protocol'
import type { ProjectIdentity } from '../identity'

export const MAX_SYNC_MESSAGE_BYTES = 10 * 1024 * 1024
export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 60_000
export const AUTH_TIMEOUT_MS = 10_000

export interface TransportOptions {
  /** 仅用于受控环境下的测试。 */
  heartbeatIntervalMs?: number
  /** 仅用于受控环境下的测试。 */
  heartbeatTimeoutMs?: number
  /** 认证等待时长；仅用于受控环境下的测试。 */
  authTimeoutMs?: number
}

export interface PeerEndpoint {
  host: string
  port: number
}

interface AuthState {
  peerId?: string
  nonce?: string
  timeout: NodeJS.Timeout
  role: 'client' | 'server'
}

export class Transport extends EventEmitter {
  private readonly connections = new Map<string, Socket>()
  private readonly socketPeerIds = new Map<Socket, string>()
  private readonly socketEndpoints = new Map<Socket, PeerEndpoint>()
  private readonly socketHeartbeats = new Map<Socket, NodeJS.Timeout>()
  private readonly socketLastSeen = new Map<Socket, number>()
  private readonly authStates = new Map<Socket, AuthState>()
  private readonly pendingAuthPeers = new Map<string, Socket>()
  private readonly authenticatedSockets = new Set<Socket>()
  private readonly usedNonces = new Set<string>()
  private readonly sockets = new Set<Socket>()
  private identity: ProjectIdentity | undefined
  private roomCode = ''
  private server: Server | undefined

  constructor(
    private readonly peerId: string,
    private readonly options: TransportOptions = {},
  ) {
    super()
  }

  setRoomCode(roomCode: string): void {
    this.roomCode = roomCode
  }

  setIdentity(identity: ProjectIdentity | undefined): void {
    this.identity = identity
  }

  async listen(): Promise<number> {
    if (this.server?.listening) {
      const address = this.server.address()
      if (address && typeof address !== 'string') {
        return address.port
      }
    }

    const server = createServer((socket) => this.attachSocket(socket))
    this.server = server
    server.on('error', (error) => this.emit('error', error))

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '0.0.0.0')
    })

    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('无法获取同步服务监听端口')
    }
    return address.port
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      this.stopHeartbeat(socket)
      this.clearAuthState(socket)
      socket.destroy()
    }
    this.connections.clear()
    this.socketPeerIds.clear()
    this.socketEndpoints.clear()
    this.sockets.clear()
    this.usedNonces.clear()

    const server = this.server
    this.server = undefined
    if (!server?.listening) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  async connect(host: string, port: number): Promise<void> {
    const socket = new Socket()
    this.attachSocket(socket, { host, port })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off('connect', onConnect)
        reject(error)
      }
      const onConnect = (): void => {
        socket.off('error', onError)
        this.beginClientAuthentication(socket)
        resolve()
      }
      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.connect(port, host)
    })
  }

  send(peerId: string, message: SyncMessage): void {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) {
      return
    }
    socket.write(encodeMessage(message), (error) => {
      if (error) {
        this.emit('error', error)
      }
    })
  }

  broadcast(message: SyncMessage, excludePeerId?: string): void {
    for (const remotePeerId of this.connections.keys()) {
      if (remotePeerId !== excludePeerId) {
        this.send(remotePeerId, message)
      }
    }
  }

  private attachSocket(socket: Socket, endpoint?: PeerEndpoint): void {
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    this.sockets.add(socket)
    if (endpoint) this.socketEndpoints.set(socket, endpoint)
    this.socketLastSeen.set(socket, Date.now())

    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      this.processBuffer(socket, () => buffer, (next) => { buffer = next })
    })
    socket.on('error', (error) => this.emit('error', error))
    socket.on('close', () => {
      buffer += decoder.end()
      this.processBuffer(socket, () => buffer, (next) => { buffer = next }, true)
      this.removeSocket(socket)
    })
    // 入站连接必须先由对端发起认证；出站连接会在 TCP connect 后发起认证。
  }

  private processBuffer(
    socket: Socket,
    getBuffer: () => string,
    setBuffer: (value: string) => void,
    flush = false,
  ): void {
    const current = getBuffer()
    const lines = current.split('\n')
    const rest = lines.pop() ?? ''
    if (Buffer.byteLength(rest, 'utf8') > MAX_SYNC_MESSAGE_BYTES) {
      setBuffer('')
      this.rejectOversizedMessage(socket)
      return
    }
    if (flush && rest.length > 0) {
      lines.push(rest)
      setBuffer('')
    } else {
      setBuffer(rest)
    }

    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_SYNC_MESSAGE_BYTES) {
        setBuffer('')
        this.rejectOversizedMessage(socket)
        return
      }
      const decoded = decodeMessages(`${line}\n`, (error) => this.emit('error', error))
      for (const message of decoded.messages) {
        this.handleMessage(socket, message)
      }
    }
  }

  private rejectOversizedMessage(socket: Socket): void {
    this.emit('error', new Error(`同步消息超过 ${MAX_SYNC_MESSAGE_BYTES} 字节上限`))
    socket.destroy()
  }

  private sendHello(socket: Socket): void {
    if (!socket.destroyed) {
      socket.write(
        encodeMessage({ identity: this.identity, type: 'hello', peerId: this.peerId, version: 1 }),
      )
    }
  }

  private handleMessage(socket: Socket, message: SyncMessage): void {
    if (message.type.startsWith('auth-')) {
      this.handleAuthenticationMessage(socket, message)
      return
    }

    if (message.type === 'hello') {
      if (!this.authenticatedSockets.has(socket)) {
        this.failAuthentication(socket, '认证尚未完成')
        return
      }
      this.registerPeer(socket, message.peerId)
      this.emit('hello', message.peerId, message.identity)
      return
    }

    const remotePeerId = this.socketPeerIds.get(socket)
    if (!remotePeerId) {
      this.emit('error', new Error('收到握手前的同步消息'))
      socket.destroy()
      return
    }

    this.socketLastSeen.set(socket, Date.now())
    if (message.type === 'ping') {
      this.send(remotePeerId, { type: 'pong' })
      return
    }
    if (message.type === 'pong') {
      return
    }

    this.emit('message', remotePeerId, message)
  }

  /** 执行一次性 nonce 挑战响应；成功前绝不接受同步消息。 */
  private handleAuthenticationMessage(socket: Socket, message: SyncMessage): void {
    if (message.type === 'auth-request') {
      if (this.authStates.has(socket) || this.authenticatedSockets.has(socket)) {
        this.failAuthentication(socket, '重复认证请求')
        return
      }
      if (!message.peerId || message.peerId === this.peerId || message.roomHash !== deriveRoomHash(this.roomCode)) {
        this.failAuthentication(socket, 'wrong-room')
        return
      }
      if (this.pendingAuthPeers.has(message.peerId)) {
        this.failAuthentication(socket, '认证已在进行')
        return
      }
      const nonce = randomBytes(32).toString('hex')
      const timeout = setTimeout(() => this.failAuthentication(socket, '认证超时'), this.options.authTimeoutMs ?? AUTH_TIMEOUT_MS)
      this.authStates.set(socket, { peerId: message.peerId, nonce, role: 'server', timeout })
      this.pendingAuthPeers.set(message.peerId, socket)
      this.write(socket, { type: 'auth-challenge', nonce })
      return
    }

    if (message.type === 'auth-challenge') {
      const state = this.authStates.get(socket)
      if (!state || state.role !== 'client' || !message.nonce) {
        this.failAuthentication(socket, '无效认证挑战')
        return
      }
      this.write(socket, { type: 'auth-response', hmac: createAuthHmac(this.roomCode, message.nonce) })
      return
    }

    if (message.type === 'auth-response') {
      const state = this.authStates.get(socket)
      if (!state || state.role !== 'server' || !state.nonce || this.usedNonces.has(state.nonce)) {
        this.failAuthentication(socket, '无效或已使用的认证挑战')
        return
      }
      const expected = createAuthHmac(this.roomCode, state.nonce)
      if (!isMatchingHmac(expected, message.hmac)) {
        this.failAuthentication(socket, '认证失败')
        return
      }
      this.usedNonces.add(state.nonce)
      setTimeout(() => this.usedNonces.delete(state.nonce!), this.options.authTimeoutMs ?? AUTH_TIMEOUT_MS)
      this.clearAuthState(socket)
      this.authenticatedSockets.add(socket)
      this.write(socket, { type: 'auth-ok' })
      this.sendHello(socket)
      return
    }

    if (message.type === 'auth-ok') {
      const state = this.authStates.get(socket)
      if (!state || state.role !== 'client') {
        this.failAuthentication(socket, '无效认证确认')
        return
      }
      this.clearAuthState(socket)
      this.authenticatedSockets.add(socket)
      this.sendHello(socket)
      return
    }

    // auth-fail 仅由远端发送；本地不再继续任何握手或同步流程。
    if (message.type === 'auth-fail') {
      this.failAuthentication(socket, message.reason, true)
    }
  }

  private beginClientAuthentication(socket: Socket): void {
    const timeout = setTimeout(() => this.failAuthentication(socket, '认证超时'), this.options.authTimeoutMs ?? AUTH_TIMEOUT_MS)
    this.authStates.set(socket, { role: 'client', timeout })
    this.write(socket, { type: 'auth-request', peerId: this.peerId, roomHash: deriveRoomHash(this.roomCode) })
  }

  private write(socket: Socket, message: SyncMessage): void {
    if (!socket.destroyed) {
      socket.write(encodeMessage(message), (error) => {
        if (error) this.emit('error', error)
      })
    }
  }

  private failAuthentication(socket: Socket, reason: string, received = false): void {
    const state = this.authStates.get(socket)
    this.clearAuthState(socket)
    if (!received) {
      if (!socket.destroyed) {
        socket.end(encodeMessage({ type: 'auth-fail', reason }))
      }
    }
    this.emit('authFailed', new Error(reason), state?.peerId)
    if (received) {
      socket.destroy()
    }
  }

  private clearAuthState(socket: Socket): void {
    const state = this.authStates.get(socket)
    if (!state) return
    clearTimeout(state.timeout)
    this.authStates.delete(socket)
    if (state.peerId && this.pendingAuthPeers.get(state.peerId) === socket) {
      this.pendingAuthPeers.delete(state.peerId)
    }
  }

  private registerPeer(socket: Socket, remotePeerId: string): void {
    if (!remotePeerId || remotePeerId === this.peerId) {
      socket.destroy()
      return
    }

    const existingSocket = this.connections.get(remotePeerId)
    if (existingSocket && existingSocket !== socket) {
      socket.destroy()
      return
    }

    if (this.socketPeerIds.get(socket) === remotePeerId) {
      return
    }

    this.socketPeerIds.set(socket, remotePeerId)
    this.connections.set(remotePeerId, socket)
    this.startHeartbeat(socket)
    this.emit('connect', remotePeerId, this.socketEndpoints.get(socket))
  }

  /** 通过轻量 ping/pong 识别静默失效的 TCP 长连接。 */
  private startHeartbeat(socket: Socket): void {
    this.stopHeartbeat(socket)
    const interval = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    const timeout = this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    const timer = setInterval(() => {
      if (socket.destroyed) {
        this.stopHeartbeat(socket)
        return
      }
      const lastSeen = this.socketLastSeen.get(socket) ?? 0
      if (Date.now() - lastSeen > timeout) {
        socket.destroy()
        return
      }
      const peerId = this.socketPeerIds.get(socket)
      if (peerId) {
        this.send(peerId, { type: 'ping' })
      }
    }, interval)
    this.socketHeartbeats.set(socket, timer)
  }

  private stopHeartbeat(socket: Socket): void {
    const timer = this.socketHeartbeats.get(socket)
    if (timer) {
      clearInterval(timer)
      this.socketHeartbeats.delete(socket)
    }
  }

  private removeSocket(socket: Socket): void {
    this.stopHeartbeat(socket)
    this.clearAuthState(socket)
    this.authenticatedSockets.delete(socket)
    this.sockets.delete(socket)
    this.socketLastSeen.delete(socket)
    const remotePeerId = this.socketPeerIds.get(socket)
    this.socketPeerIds.delete(socket)
    this.socketEndpoints.delete(socket)
    if (!remotePeerId || this.connections.get(remotePeerId) !== socket) {
      return
    }

    this.connections.delete(remotePeerId)
    this.emit('disconnect', remotePeerId)
  }
}

function isMatchingHmac(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) {
    return false
  }
  const expectedBuffer = Buffer.from(expected, 'hex')
  const receivedBuffer = Buffer.from(received, 'hex')
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}
