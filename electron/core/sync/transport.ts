import { EventEmitter } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'

import { decodeMessages, encodeMessage, type SyncMessage } from './protocol'

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
    this.sockets.add(socket)

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const decoded = decodeMessages(buffer, (error) => this.emit('error', error))
      buffer = decoded.rest
      for (const message of decoded.messages) {
        this.handleMessage(socket, message)
      }
    })
    socket.on('error', (error) => this.emit('error', error))
    socket.on('close', () => this.removeSocket(socket))
    if (shouldSendHello) {
      this.sendHello(socket)
    }
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
