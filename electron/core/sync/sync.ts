import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path'

import { applyPatch } from 'diff'
import { merge } from 'node-diff3'

import { ConflictsManager, type ConflictRecord } from '../conflicts'
import type { Oplog } from '../oplog'
import { readSnapshot } from '../watcher/snapshot'
import { isSensitiveFile } from '../watcher/watcher'
import { Discovery } from './discovery'
import { PendingOps } from './pending-ops'
import type { PeerInfo, SeederInfo, SyncMessage } from './protocol'
import { Transport } from './transport'

export interface SyncOptions {
  roomCode: string
  oplog: Oplog
  /** 用于持久化等待文件基线的远端操作。 */
  projectRoot?: string
}

export interface SyncStartOptions {
  discovery?: boolean
}

export interface SyncHooks {
  applyRemoteChange(relativePath: string, content: string, deleted?: boolean): Promise<void>
  fileExists?(relativePath: string): Promise<boolean>
  readFile(relativePath: string): Promise<string>
  writeFile(relativePath: string, content: string): Promise<void>
  moveRemoteDeletionToTrash?(relativePath: string, author: string, opHash: string): Promise<void>
}

interface SyncDependencies {
  discovery?: Discovery
  peerId?: string
  transport?: Transport
}

/** 避免 Sync 与快照模块产生循环依赖的最小处理器契约。 */
export interface SnapshotSeederHandler {
  handleWantSnapshot(peerId: string, snapshotId: string): void
  handleWantChunk(peerId: string, snapshotId: string, index: number): void
  announceToPeer?(peerId: string): void
}

export interface SnapshotDownloaderHandler {
  cancel(reason?: Error): void
  handleSnapshotMeta(peerId: string, message: Extract<SyncMessage, { type: 'snapshot-meta' }>): void
  handleChunk(peerId: string, message: Extract<SyncMessage, { type: 'chunk' }>): void
}

export class Sync extends EventEmitter {
  private readonly discovery: Discovery
  private readonly peerId: string
  private readonly peers = new Map<string, PeerInfo>()
  private readonly seeders = new Map<string, SeederInfo>()
  private readonly transport: Transport
  private seeder?: SnapshotSeederHandler
  private downloader?: SnapshotDownloaderHandler
  private localPort: number | undefined
  private pendingDirectEndpoint: { host: string; port: number } | undefined
  private readonly directFallbackTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly pendingOps: PendingOps | undefined
  private readonly conflicts: ConflictsManager | undefined
  private retryingPending = false
  private started = false

  constructor(
    private readonly options: SyncOptions,
    dependencies: SyncDependencies = {},
    private readonly hooks?: SyncHooks,
  ) {
    super()
    this.peerId = dependencies.peerId ?? randomUUID()
    this.discovery = dependencies.discovery ?? new Discovery()
    this.transport = dependencies.transport ?? new Transport(this.peerId)
    this.pendingOps = options.projectRoot ? new PendingOps(options.projectRoot) : undefined
    this.conflicts = options.projectRoot ? new ConflictsManager(options.projectRoot) : undefined
  }

  async start(startOptions: SyncStartOptions = {}): Promise<void> {
    if (this.started) {
      return
    }

    const discoveryEnabled = startOptions.discovery ?? true
    this.bindEvents()
    this.transport.setRoomCode(this.options.roomCode)
    try {
      const port = await this.transport.listen()
      this.localPort = port
      this.started = true
      void this.retryPendingOps().catch((error: unknown) => this.emitError(error))
      if (discoveryEnabled) {
        this.discovery.publish({ peerId: this.peerId, port, roomCode: this.options.roomCode })
        this.discovery.startBrowse(this.options.roomCode, this.peerId)
      }
    } catch (error) {
      this.started = false
      this.localPort = undefined
      this.unbindEvents()
      this.discovery.stopPublish()
      this.discovery.stopBrowse()
      this.discovery.destroy()
      this.peers.clear()
      await this.transport.close().catch((closeError: unknown) => this.emitError(closeError))
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false
    this.localPort = undefined
    this.pendingDirectEndpoint = undefined
    for (const timer of this.directFallbackTimers) {
      clearTimeout(timer)
    }
    this.directFallbackTimers.clear()
    this.unbindEvents()
    this.discovery.stopPublish()
    this.discovery.stopBrowse()
    this.discovery.destroy()
    this.peers.clear()
    this.seeders.clear()
    try {
      await this.transport.close()
    } catch (error) {
      this.emitError(error)
    }
  }

  listPeers(): PeerInfo[] {
    return [...this.peers.values()].sort((left, right) => left.peerId.localeCompare(right.peerId))
  }

  getPeerId(): string {
    return this.peerId
  }

  getLocalPort(): number | undefined {
    return this.localPort
  }

  /** 绕过 mDNS 直接连到已知的 TCP 端点，并等待 hello 握手完成。 */
  async connectToAddress(host: string, port: number, roomCode = this.options.roomCode): Promise<void> {
    const normalizedHost = host.trim()
    if (!normalizedHost) {
      throw new Error('直连地址不能为空')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`直连端口必须在 1 到 65535 之间：${port}`)
    }
    if (!this.started) {
      throw new Error('同步服务尚未启动')
    }
    if (roomCode !== this.options.roomCode) {
      throw new Error('直连邀请码与当前房间不一致')
    }

    this.pendingDirectEndpoint = { host: normalizedHost, port }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`连接 ${normalizedHost}:${port} 超时`))
      }, 10_000)
      const onConnected = (): void => {
        cleanup()
        resolve()
      }
      const onAuthFailed = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        this.off('connected', onConnected)
        this.off('authFailed', onAuthFailed)
      }

      this.once('connected', onConnected)
      this.once('authFailed', onAuthFailed)
      void this.transport.connect(normalizedHost, port).catch((error: unknown) => {
        cleanup()
        reject(error)
      })
    })
  }

  listSeeders(): SeederInfo[] {
    return [...this.seeders.values()].sort((left, right) => {
      return left.projectName.localeCompare(right.projectName) || left.peerId.localeCompare(right.peerId)
    })
  }

  registerSeeder(seeder: SnapshotSeederHandler | undefined): void {
    this.seeder = seeder
  }

  registerDownloader(downloader: SnapshotDownloaderHandler | undefined): void {
    this.downloader = downloader
  }

  /** 向指定对等端发送快照控制消息。 */
  send(peerId: string, message: SyncMessage): void {
    if (this.started) {
      this.transport.send(peerId, message)
    }
  }

  /** 向当前房间的所有已连接对等端广播快照控制消息。 */
  broadcast(message: SyncMessage): void {
    if (this.started) {
      this.transport.broadcast(message)
    }
  }

  announceLocalOp(op: import('../oplog').Op): void {
    if (this.started) {
      this.broadcast({ hash: op.hash, type: 'have' })
    }
  }

  private bindEvents(): void {
    this.discovery.on('peer', this.handlePeer)
    this.discovery.on('peerLeft', this.handlePeerLeft)
    this.discovery.on('error', this.handleError)
    this.transport.on('connect', this.handleConnect)
    this.transport.on('disconnect', this.handleDisconnect)
    this.transport.on('authFailed', this.handleAuthFailed)
    this.transport.on('message', this.handleMessage)
    this.transport.on('error', this.handleError)
  }

  private unbindEvents(): void {
    this.discovery.off('peer', this.handlePeer)
    this.discovery.off('peerLeft', this.handlePeerLeft)
    this.discovery.off('error', this.handleError)
    this.transport.off('connect', this.handleConnect)
    this.transport.off('disconnect', this.handleDisconnect)
    this.transport.off('authFailed', this.handleAuthFailed)
    this.transport.off('message', this.handleMessage)
    this.transport.off('error', this.handleError)
  }

  private readonly handlePeer = (info: PeerInfo): void => {
    if (!this.started) {
      return
    }
    const wasKnown = this.peers.has(info.peerId)
    this.peers.set(info.peerId, info)
    if (!wasKnown) {
      this.emit('peerJoined', info)
      void this.transport.connect(info.host, info.port).catch((error: unknown) => this.emitError(error))
    }
  }

  private readonly handlePeerLeft = (peerId: string): void => {
    if (!this.peers.delete(peerId)) {
      return
    }
    for (const [seederKey, seeder] of this.seeders) {
      if (seeder.peerId === peerId) {
        this.seeders.delete(seederKey)
        this.emit('seederGone', { peerId, snapshotId: seeder.snapshotId })
      }
    }
    this.emit('peerLeft', peerId)
  }

  private readonly handleConnect = (peerId: string): void => {
    const endpoint = this.pendingDirectEndpoint
    this.pendingDirectEndpoint = undefined
    if (!this.peers.has(peerId) && endpoint) {
      this.peers.set(peerId, {
        host: endpoint.host,
        lastSeen: Date.now(),
        peerId,
        port: endpoint.port,
      })
      this.emit('peerJoined', this.peers.get(peerId))
    } else if (!this.peers.has(peerId)) {
      // mDNS 的 peer 事件可能稍晚于 hello；稍候再为纯直连的入站连接补占位信息。
      const timer = setTimeout(() => {
        this.directFallbackTimers.delete(timer)
        if (this.started && !this.peers.has(peerId)) {
          const info: PeerInfo = { host: 'direct', lastSeen: Date.now(), peerId, port: 0 }
          this.peers.set(peerId, info)
          this.emit('peerJoined', info)
        }
      }, 300)
      this.directFallbackTimers.add(timer)
    }
    this.emit('connected', peerId)
    for (const hash of this.options.oplog.listAllHashes()) {
      this.send(peerId, { hash, type: 'have' })
    }
    this.seeder?.announceToPeer?.(peerId)
  }

  /** 连接意外断开时，停止当前下载，避免界面无限等待分块。 */
  private readonly handleDisconnect = (peerId: string): void => {
    this.handlePeerLeft(peerId)
    this.downloader?.cancel(new Error('连接中断，请重试。'))
  }

  private readonly handleAuthFailed = (error: Error): void => {
    this.emit('authFailed', error)
    this.emitError(error)
  }

  private readonly handleMessage = (peerId: string, message: SyncMessage): void => {
    if (message.type === 'have') {
      if (!this.options.oplog.hasOp(message.hash)) {
        this.send(peerId, { hash: message.hash, type: 'want' })
      }
      return
    }

    if (message.type === 'want') {
      const op = this.options.oplog.getOp(message.hash)
      if (op) {
        this.send(peerId, { op, type: 'data' })
      }
      return
    }

    if (message.type === 'data') {
      void this.receiveRemoteOp(message.op)
      return
    }

    try {
      if (message.type === 'seeder-available') {
        const info: SeederInfo = {
          peerId,
          snapshotId: message.snapshotId,
          projectName: message.projectName,
          size: message.size,
        }
        this.seeders.set(this.seederKey(peerId, message.snapshotId), info)
        this.emit('seederAvailable', info)
        return
      }

      if (message.type === 'seeder-gone') {
        this.seeders.delete(this.seederKey(peerId, message.snapshotId))
        this.emit('seederGone', { peerId, snapshotId: message.snapshotId })
        return
      }

      if (message.type === 'want-snapshot') {
        this.seeder?.handleWantSnapshot(peerId, message.snapshotId)
        return
      }

      if (message.type === 'want-chunk') {
        this.seeder?.handleWantChunk(peerId, message.snapshotId, message.index)
        return
      }

      if (message.type === 'snapshot-meta') {
        this.downloader?.handleSnapshotMeta(peerId, message)
        return
      }

      if (message.type === 'chunk') {
        this.downloader?.handleChunk(peerId, message)
      }
    } catch (error) {
      this.emitError(error)
    }
  }

  private async receiveRemoteOp(op: import('../oplog').Op): Promise<void> {
    if (this.options.oplog.hasOp(op.hash)) {
      return
    }

    try {
      const remoteOp = this.options.oplog.putOp({ ...op, source: 'remote' })
      if (this.hooks) {
        await this.applyRemoteOp(remoteOp)
      }
      this.emit('remoteOp', remoteOp)
    } catch (error) {
      this.emitError(error)
    }
  }

  /** 快照解压完成后由下载器调用，重试此前缺少基线的操作。 */
  async retryPendingOps(): Promise<void> {
    if (!this.pendingOps || this.retryingPending) {
      return
    }

    this.retryingPending = true
    try {
      await this.pendingOps.retryAll((op) => this.applyRemoteOp(op, false))
    } finally {
      this.retryingPending = false
    }
  }

  private async applyRemoteOp(op: import('../oplog').Op, retryPending = true): Promise<boolean> {
    if (op.source !== 'remote' || !this.hooks) {
      return false
    }

    await this.assertSafeProjectPath(op.filePath)
    if (isSensitiveFile(op.filePath)) {
      throw new Error(`拒绝同步敏感文件：${op.filePath}`)
    }

    const localContent = await this.hooks.readFile(op.filePath)
    const exists = this.hooks.fileExists
      ? await this.hooks.fileExists(op.filePath)
      : localContent !== ''
    if (op.kind === 'deleted' && localContent === '') {
      // 文件已不存在时，删除操作保持幂等，不留下永远无法重试的 pending。
      await this.hooks.applyRemoteChange(op.filePath, '', true)
      await this.completeRemoteOp(op, retryPending)
      return true
    }
    // 新建操作基于空内容，允许完整重建空文件或普通文本文件。
    if (!exists && op.kind === 'created') {
      const created = applyPatch('', op.diff)
      if (created !== false) return this.writeAndCompleteRemoteOp(op, created, retryPending)
    }

    if (!exists) {
      await this.pendingOps?.add(op)
      return false
    }

    if (!op.baseHash || contentHash(localContent) === op.baseHash) {
      const nextContent = applyPatch(localContent, op.diff)
      if (nextContent !== false) return this.writeAndCompleteRemoteOp(op, nextContent, retryPending)
      await this.handleConflict(op, localContent)
      return false
    }

    const projectRoot = this.options.projectRoot
    const baseContent = projectRoot ? readSnapshot(projectRoot, op.baseHash, op.filePath) : undefined
    if (baseContent === undefined) {
      const fallback = applyPatch(localContent, op.diff)
      if (fallback !== false) return this.writeAndCompleteRemoteOp(op, fallback, retryPending)
      await this.handleConflict(op, localContent)
      return false
    }

    const remoteContent = applyPatch(baseContent, op.diff)
    if (remoteContent === false) {
      await this.handleConflict(op, localContent, { baseContent })
      return false
    }
    // node-diff3 以数组元素为最小合并单位；按保留换行符的行拆分，避免逐字符合并丢失换行。
    const merged = merge(splitLines(localContent), splitLines(baseContent), splitLines(remoteContent), {
      label: { a: 'LOCAL', b: 'REMOTE' },
    })
    const mergedContent = merged.result.join('')
    if (!merged.conflict) {
      return this.writeAndCompleteRemoteOp(op, mergedContent, retryPending)
    }

    await this.handleConflict(op, localContent, { baseContent, remoteContent, mergedWithMarkers: mergedContent })
    return false
  }

  private async writeAndCompleteRemoteOp(
    op: import('../oplog').Op,
    content: string,
    retryPending: boolean,
  ): Promise<boolean> {
    if (op.kind === 'deleted') {
      await this.hooks!.moveRemoteDeletionToTrash?.(op.filePath, op.author, op.hash)
      await this.hooks!.applyRemoteChange(op.filePath, '', true)
    } else {
      await this.hooks!.applyRemoteChange(op.filePath, content)
      await this.hooks!.writeFile(op.filePath, content)
    }
    await this.completeRemoteOp(op, retryPending)
    return true
  }

  /** 保存冲突双方，永远保留用户正在编辑的主文件。 */
  private async handleConflict(
    op: import('../oplog').Op,
    localContent: string,
    threeWay: Partial<Pick<ConflictRecord, 'baseContent' | 'remoteContent' | 'mergedWithMarkers'>> = {},
  ): Promise<void> {
    const record: ConflictRecord = {
      author: op.author,
      filePath: op.filePath,
      localContent,
      opHash: op.hash,
      timestamp: Date.now(),
      ...threeWay,
    }
    if (record.remoteContent !== undefined && this.options.projectRoot) {
      const remotePath = resolve(this.options.projectRoot, `${op.filePath}.cairn-remote`)
      await mkdir(dirname(remotePath), { recursive: true })
      await writeFile(remotePath, record.remoteContent, 'utf8')
    }
    await this.conflicts?.save(record)
    this.emit('conflictRecord', record)
    // 兼容现有 renderer 事件；C2 会改为从持久化记录读取详情。
    this.emit('conflict', op, localContent)
  }

  private async completeRemoteOp(op: import('../oplog').Op, retryPending: boolean): Promise<void> {
    await this.pendingOps?.remove(op.hash)
    if (retryPending) {
      await this.retryPendingOps()
    }
  }

  /** 阻止通过项目内符号链接访问项目根目录以外的内容。 */
  private async assertSafeProjectPath(relativePath: string): Promise<void> {
    const projectRoot = this.options.projectRoot
    if (!projectRoot) {
      return
    }

    const normalized = relativePath.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (
      normalized.length === 0
      || isAbsolute(normalized)
      || win32.isAbsolute(normalized)
      || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new Error(`远端文件路径非法：${relativePath}`)
    }

    const root = await realpath(projectRoot)
    const target = resolve(root, ...segments)
    if (!target.startsWith(`${root}${sep}`)) {
      throw new Error(`远端文件路径越界：${relativePath}`)
    }

    let currentPath = root
    for (const segment of segments) {
      currentPath = join(currentPath, segment)
      try {
        const resolvedPath = await realpath(currentPath)
        if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
          throw new Error(`远端文件路径通过符号链接越界：${relativePath}`)
        }
      } catch (error) {
        if (isMissingPath(error)) {
          break
        }
        throw error
      }
    }
  }

  private readonly handleError = (error: Error): void => {
    this.emit('error', error)
  }

  private emitError(error: unknown): void {
    this.emit('error', error instanceof Error ? error : new Error(String(error)))
  }

  private seederKey(peerId: string, snapshotId: string): string {
    return `${peerId}:${snapshotId}`
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function splitLines(content: string): string[] {
  return content.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
}
