import { EventEmitter } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

import { decodeMessages, encodeMessage, type SyncMessage } from './protocol'

export const MAX_SYNC_MESSAGE_BYTES = 10 * 1024 * 1024

export class Transport extends EventEmitter {
  private readonly connections = new Map<string, Socket>()
  private readonly socketPeerIds = new Map<Socket, string>()
  private readonly sockets = new Set<Socket>()
  private roomCode = ''
  private server: Server | undefined

  constructor(private readonly peerId: string) {
    super()
  }

  setRoomCode(roomCode: string): void {
    this.roomCode = roomCode
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
      socket.destroy()
    }
    this.connections.clear()
    this.socketPeerIds.clear()
    this.sockets.clear()

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
    this.attachSocket(socket, false)

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off('connect', onConnect)
        reject(error)
      }
      const onConnect = (): void => {
        socket.off('error', onError)
        this.sendHello(socket)
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

  private attachSocket(socket: Socket, shouldSendHello = true): void {
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    this.sockets.add(socket)

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
    if (shouldSendHello) {
      this.sendHello(socket)
    }
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
        encodeMessage({ type: 'hello', peerId: this.peerId, roomCode: this.roomCode, version: 1 }),
      )
    }
  }

  private handleMessage(socket: Socket, message: SyncMessage): void {
    if (message.type === 'hello') {
      this.registerPeer(socket, message.peerId)
      return
    }

    const remotePeerId = this.socketPeerIds.get(socket)
    if (!remotePeerId) {
      this.emit('error', new Error('收到握手前的同步消息'))
      socket.destroy()
      return
    }

    this.emit('message', remotePeerId, message)
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
    this.emit('connect', remotePeerId)
  }

  private removeSocket(socket: Socket): void {
    this.sockets.delete(socket)
    const remotePeerId = this.socketPeerIds.get(socket)
    this.socketPeerIds.delete(socket)
    if (!remotePeerId || this.connections.get(remotePeerId) !== socket) {
      return
    }

    this.connections.delete(remotePeerId)
    this.emit('disconnect', remotePeerId)
  }
}
