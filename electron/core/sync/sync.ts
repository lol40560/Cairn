import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, writeFile } from 'node:fs/promises'

import { applyPatch } from 'diff'
import { merge } from 'node-diff3'

import { BlobStore } from '../blobs'
import { ConflictsManager, type ConflictRecord } from '../conflicts'
import { prepareSafeProjectWritePath, resolveSafeProjectPath, UnsafeProjectPathError } from '../fs/project-path'
import type { ProjectIdentity } from '../identity'
import type { Oplog } from '../oplog'
import { readSnapshot } from '../watcher/snapshot'
import { isSensitiveFile } from '../watcher/watcher'
import { Discovery } from './discovery'
import { PendingOps } from './pending-ops'
import type { PeerInfo, SeederInfo, SyncMessage } from './protocol'
import { ReconnectManager, type PeerState } from './reconnect'
import { Transport, type PeerEndpoint } from './transport'

export interface SyncOptions {
  roomCode: string
  oplog: Oplog
  /** 二進制內容的內容定址儲存；未提供時仍可維持純文字同步。 */
  blobStore?: BlobStore
  /** 本機工作區基準，用於在握手後提示不同專案或版本。 */
  identity?: ProjectIdentity
  /** 用于持久化等待文件基线的远端操作。 */
  projectRoot?: string
}

export interface SyncStartOptions {
  discovery?: boolean
}

export interface SyncHooks {
  applyRemoteChange(relativePath: string, content: string, deleted?: boolean, blobHash?: string): Promise<void>
  fileExists?(relativePath: string): Promise<boolean>
  readFile(relativePath: string): Promise<string>
  writeFile(relativePath: string, content: string): Promise<void>
  writeBinaryFile?(relativePath: string, content: Buffer): Promise<void>
  moveRemoteDeletionToTrash?(relativePath: string, author: string, opHash: string): Promise<void>
}

interface SyncDependencies {
  discovery?: Discovery
  /** 仅供崩溃边界回归测试使用；生产环境不传入。 */
  afterFilesystemApplyBeforeMarkApplied?: (op: import('../oplog').Op) => Promise<void>
  peerId?: string
  transport?: Transport
}

interface ConnectionAttempt {
  endpoint: PeerEndpoint
  expectedPeerId?: string
  reject(error: Error): void
  resolve(): void
  timer: ReturnType<typeof setTimeout>
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
  private readonly afterFilesystemApplyBeforeMarkApplied: ((op: import('../oplog').Op) => Promise<void>) | undefined
  private seeder?: SnapshotSeederHandler
  private downloader?: SnapshotDownloaderHandler
  private localPort: number | undefined
  /** 每次連線有自己的承諾與計時器，不能由任何全域 connected/authFailed 事件完成。 */
  private readonly connectionAttempts = new Map<string, ConnectionAttempt>()
  private readonly directFallbackTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly pendingOps: PendingOps | undefined
  private readonly conflicts: ConflictsManager | undefined
  private readonly reconnectManager: ReconnectManager
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
    this.afterFilesystemApplyBeforeMarkApplied = dependencies.afterFilesystemApplyBeforeMarkApplied
    this.pendingOps = options.projectRoot ? new PendingOps(options.projectRoot) : undefined
    this.conflicts = options.projectRoot ? new ConflictsManager(options.projectRoot) : undefined
    this.reconnectManager = new ReconnectManager({
      baseDelayMs: 1_000,
      connect: (peerId, host, port) => this.reconnectPeer(peerId, host, port),
      maxAttempts: 20,
      maxDelayMs: 30_000,
    })
    this.reconnectManager.on('peerStatusChanged', (state: PeerState) => this.emit('peerStatusChanged', state))
  }

  async start(startOptions: SyncStartOptions = {}): Promise<void> {
    if (this.started) {
      return
    }

    const discoveryEnabled = startOptions.discovery ?? true
    this.bindEvents()
    this.transport.setRoomCode(this.options.roomCode)
    this.transport.setIdentity?.(this.options.identity)
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
    this.reconnectManager.stop()
    this.rejectConnectionAttempts(new Error('同步服务已停止'))
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

  retryPeer(peerId: string): void {
    this.reconnectManager.retryNow(peerId)
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

    await this.createConnectionAttempt({ host: normalizedHost, port })
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
    this.transport.on('connectionFailed', this.handleConnectionFailed)
    this.transport.on('disconnect', this.handleDisconnect)
    this.transport.on('authFailed', this.handleAuthFailed)
    this.transport.on('hello', this.handleHello)
    this.transport.on('message', this.handleMessage)
    this.transport.on('error', this.handleError)
  }

  private unbindEvents(): void {
    this.discovery.off('peer', this.handlePeer)
    this.discovery.off('peerLeft', this.handlePeerLeft)
    this.discovery.off('error', this.handleError)
    this.transport.off('connect', this.handleConnect)
    this.transport.off('connectionFailed', this.handleConnectionFailed)
    this.transport.off('disconnect', this.handleDisconnect)
    this.transport.off('authFailed', this.handleAuthFailed)
    this.transport.off('hello', this.handleHello)
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
    }
    if (!wasKnown || this.reconnectManager.get(info.peerId)?.status !== 'connected') {
      void this.transport.connect(info.host, info.port).catch((error: unknown) => this.emitError(error))
    }
  }

  private readonly handlePeerLeft = (peerId: string): void => {
    if (!this.peers.has(peerId)) {
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

  private readonly handleConnect = (peerId: string, endpoint?: PeerEndpoint, attemptId?: string): void => {
    this.completeConnectionAttempt(attemptId, peerId)
    const knownPeer = this.peers.get(peerId)
    const reconnectEndpoint = endpoint ?? (knownPeer ? { host: knownPeer.host, port: knownPeer.port } : undefined)
    if (!knownPeer && reconnectEndpoint) {
      this.peers.set(peerId, {
        host: reconnectEndpoint.host,
        lastSeen: Date.now(),
        peerId,
        port: reconnectEndpoint.port,
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
    this.reconnectManager.markConnected(peerId, reconnectEndpoint?.host, reconnectEndpoint?.port)
    this.emit('connected', peerId)
    for (const hash of this.options.oplog.listAllHashes()) {
      this.send(peerId, { hash, type: 'have' })
    }
    void this.announceBlobs(peerId).catch((error: unknown) => this.emitError(error))
    void this.retryPendingOps().catch((error: unknown) => this.emitError(error))
    void this.retryPendingBinaryOps().catch((error: unknown) => this.emitError(error))
    this.seeder?.announceToPeer?.(peerId)
  }

  /** 连接意外断开时，停止当前下载，避免界面无限等待分块。 */
  private readonly handleDisconnect = (peerId: string): void => {
    this.handlePeerLeft(peerId)
    const peer = this.peers.get(peerId)
    this.reconnectManager.markDisconnected(peerId, peer?.host, peer?.port)
    this.downloader?.cancel(new Error('连接中断，请重试。'))
  }

  /** 等待完成 hello 握手，避免 TCP 已建立但认证失败时被误判为重连成功。 */
  private async reconnectPeer(peerId: string, host: string, port: number): Promise<void> {
    await this.createConnectionAttempt({ host, port }, peerId)
  }

  private readonly handleAuthFailed = (error: Error, _peerId?: string, _endpoint?: PeerEndpoint, attemptId?: string): void => {
    this.failConnectionAttempt(attemptId, error)
    this.emit('authFailed', error)
    this.emitError(error)
  }

  private readonly handleConnectionFailed = (error: Error, _endpoint?: PeerEndpoint, attemptId?: string): void => {
    this.failConnectionAttempt(attemptId, error)
  }

  private createConnectionAttempt(endpoint: PeerEndpoint, expectedPeerId?: string): Promise<void> {
    const attemptId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failConnectionAttempt(attemptId, new Error(`连接 ${endpoint.host}:${endpoint.port} 超时`))
      }, 10_000)
      this.connectionAttempts.set(attemptId, { endpoint, expectedPeerId, reject, resolve, timer })
      void this.transport.connect(endpoint.host, endpoint.port, attemptId).catch((error: unknown) => {
        this.failConnectionAttempt(attemptId, toError(error))
      })
    })
  }

  private completeConnectionAttempt(attemptId: string | undefined, peerId: string): void {
    if (!attemptId) return
    const attempt = this.connectionAttempts.get(attemptId)
    if (!attempt) return
    if (attempt.expectedPeerId && attempt.expectedPeerId !== peerId) {
      this.failConnectionAttempt(attemptId, new Error(`重连连接到了意外 peer：${peerId}`))
      return
    }
    this.connectionAttempts.delete(attemptId)
    clearTimeout(attempt.timer)
    attempt.resolve()
  }

  private failConnectionAttempt(attemptId: string | undefined, error: Error): void {
    if (!attemptId) return
    const attempt = this.connectionAttempts.get(attemptId)
    if (!attempt) return
    this.connectionAttempts.delete(attemptId)
    clearTimeout(attempt.timer)
    attempt.reject(error)
  }

  private rejectConnectionAttempts(error: Error): void {
    for (const attemptId of [...this.connectionAttempts.keys()]) {
      this.failConnectionAttempt(attemptId, error)
    }
  }

  /** 认证完成后交换工作区指纹；不匹配只告警，绝不阻断既有同步。 */
  private readonly handleHello = (peerId: string, remoteIdentity: ProjectIdentity | undefined): void => {
    const localIdentity = this.options.identity
    if (!localIdentity || !remoteIdentity) return

    if (localIdentity.fingerprint === remoteIdentity.fingerprint) {
      this.send(peerId, { type: 'identity-ok' })
      return
    }

    const mismatch = {
      guestIdentity: remoteIdentity,
      hostIdentity: localIdentity,
      peerId,
    }
    this.emit('identityMismatch', mismatch)
    this.send(peerId, {
      hostIdentity: localIdentity,
      reason: 'workspace-fingerprint-differs',
      type: 'identity-mismatch',
      yourIdentity: remoteIdentity,
    })
  }

  private readonly handleMessage = (peerId: string, message: SyncMessage): void => {
    if (message.type === 'have') {
      if (!this.options.oplog.hasReceivedOp(message.hash)) {
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

    if (message.type === 'have-blob') {
      void this.handleHaveBlob(peerId, message.hash).catch((error: unknown) => this.emitError(error))
      return
    }

    if (message.type === 'want-blob') {
      void this.handleWantBlob(peerId, message.hash).catch((error: unknown) => this.emitError(error))
      return
    }

    if (message.type === 'data-blob') {
      void this.handleDataBlob(message.hash, message.data).catch((error: unknown) => this.emitError(error))
      return
    }

    if (message.type === 'identity-mismatch') {
      const localIdentity = this.options.identity
      this.emit('identityMismatch', {
        // 对端带回的 yourIdentity 是当前机器在握手时发送的身份。
        guestIdentity: message.hostIdentity,
        hostIdentity: localIdentity ?? message.yourIdentity,
        peerId,
      })
      return
    }

    if (message.type === 'identity-ok') {
      console.info(`[cairn:sync] identity 验证通过：${peerId}`)
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
    const previousState = this.options.oplog.getRemoteOpApplyState(op.hash)
    if (previousState === 'applied') {
      return
    }

    let remoteOp: import('../oplog').Op | undefined
    let newlyReceived = false
    try {
      if (previousState === 'received') {
        const stored = this.options.oplog.getOp(op.hash)
        if (!stored) {
          throw new Error(`未找到已接收的远端操作：${op.hash}`)
        }
        remoteOp = { ...stored, source: 'remote' }
      } else if (this.options.oplog.hasReceivedOp(op.hash)) {
        // 没有 apply 记录的旧对象来自升级前，按 legacy-complete 处理以免重放历史。
        return
      } else {
        remoteOp = this.options.oplog.putReceivedRemoteOp(op)
        newlyReceived = true
      }
      if (this.hooks) {
        await this.applyRemoteOp(remoteOp)
      }
    } catch (error) {
      this.markTerminalRemoteFailure(remoteOp, error)
      this.emitError(error)
      return
    }
    if (newlyReceived) {
      this.emit('remoteOp', remoteOp)
    }
  }

  /** 快照解压完成后由下载器调用，重试此前缺少基线的操作。 */
  async retryPendingOps(): Promise<void> {
    if (!this.pendingOps || this.retryingPending) {
      return
    }

    this.retryingPending = true
    try {
      for (const op of this.options.oplog.listUnappliedRemoteOps()) {
        try {
          await this.applyRemoteOp(op, false)
        } catch (error) {
          this.markTerminalRemoteFailure(op, error)
          console.warn(`[cairn:sync] 重试未完成远端操作失败：${op.hash.slice(0, 12)}`, error)
        }
      }
      await this.pendingOps.retryAll(async (op) => {
        try {
          return await this.applyRemoteOp(op, false)
        } catch (error) {
          this.markTerminalRemoteFailure(op, error)
          this.emitError(error)
          return isTerminalRemoteApplyError(error)
        }
      })
    } finally {
      this.retryingPending = false
    }
  }

  private async applyRemoteOp(op: import('../oplog').Op, retryPending = true): Promise<boolean> {
    if (!this.started || op.source !== 'remote' || !this.hooks) {
      return false
    }
    // 升级前写入 pending/ 的远端操作没有 apply marker；只有实际进入待重试队列时才补建 intent，
    // 不会把全部旧历史操作重新标记为待应用。
    if (!this.options.oplog.getRemoteOpApplyState(op.hash)) {
      this.options.oplog.putReceivedRemoteOp(op)
    }
    if (this.options.oplog.getRemoteOpApplyState(op.hash) === 'applied') {
      return true
    }

    await this.assertSafeProjectPath(op.filePath)
    if (isSensitiveFile(op.filePath)) {
      throw new Error(`拒绝同步敏感文件：${op.filePath}`)
    }

    if (op.blobHash) {
      return this.applyRemoteBinaryOp(op, retryPending)
    }

    const localContent = await this.hooks.readFile(op.filePath)
    const exists = await this.fileExists(op.filePath)
    if (op.kind === 'deleted') {
      // 刪除以存在性而非內容判斷：0-byte 檔案同樣必須移入本機廢紙簍。
      if (exists) {
        await this.hooks.moveRemoteDeletionToTrash?.(op.filePath, op.author, op.hash)
      }
      await this.hooks.applyRemoteChange(op.filePath, '', true)
      await this.afterFilesystemApply(op)
      await this.completeRemoteOp(op, retryPending)
      return true
    }
    const targetContentHash = this.options.oplog.getRemoteOpTargetContentHash(op.hash)
    if (exists && targetContentHash === contentHash(localContent)) {
      // 上次已写盘但在更新基线或 completion marker 前中断；只补齐后续步骤。
      await this.hooks.applyRemoteChange(op.filePath, localContent)
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
      await this.completeRemoteOp(op, retryPending)
      return true
    }

    const projectRoot = this.options.projectRoot
    const baseContent = projectRoot ? readSnapshot(projectRoot, op.baseHash, op.filePath) : undefined
    if (baseContent === undefined) {
      const fallback = applyPatch(localContent, op.diff)
      if (fallback !== false) return this.writeAndCompleteRemoteOp(op, fallback, retryPending)
      await this.handleConflict(op, localContent)
      await this.completeRemoteOp(op, retryPending)
      return true
    }

    const remoteContent = applyPatch(baseContent, op.diff)
    if (remoteContent === false) {
      await this.handleConflict(op, localContent, { baseContent })
      await this.completeRemoteOp(op, retryPending)
      return true
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
    await this.completeRemoteOp(op, retryPending)
    return true
  }

  /** blob 尚未到達時先保留 op，取得且驗證內容後才寫入專案。 */
  private async applyRemoteBinaryOp(
    op: import('../oplog').Op,
    retryPending: boolean,
  ): Promise<boolean> {
    const blobStore = this.options.blobStore
    if (!blobStore) {
      throw new Error(`无法应用 binary op：未配置 BlobStore（${op.filePath}）`)
    }
    const blobHash = op.blobHash
    if (!blobHash) {
      throw new Error(`无法应用 binary op：缺少 blob hash（${op.filePath}）`)
    }
    if (!await blobStore.has(blobHash)) {
      await this.pendingOps?.add(op)
      this.broadcast({ type: 'want-blob', hash: blobHash })
      return false
    }

    if (op.kind === 'deleted') {
      const exists = this.hooks!.fileExists ? await this.hooks!.fileExists(op.filePath) : true
      if (exists) {
        await this.hooks!.moveRemoteDeletionToTrash?.(op.filePath, op.author, op.hash)
      }
      await this.hooks!.applyRemoteChange(op.filePath, '', true, blobHash)
      await this.afterFilesystemApply(op)
      await this.completeRemoteOp(op, retryPending)
      return true
    }

    const content = await blobStore.get(blobHash)
    if (!content) {
      throw new Error(`blob 在存在检查后丢失：${blobHash}`)
    }
    if (!this.hooks!.writeBinaryFile) {
      throw new Error(`无法应用 binary op：缺少二进制写入器（${op.filePath}）`)
    }

    await this.hooks!.writeBinaryFile(op.filePath, content)
    await this.hooks!.applyRemoteChange(op.filePath, '', false, blobHash)
    await this.afterFilesystemApply(op)
    await this.completeRemoteOp(op, retryPending)
    return true
  }

  private async announceBlobs(peerId: string): Promise<void> {
    const blobStore = this.options.blobStore
    if (!blobStore) return

    const hashes = await blobStore.listAll()
    console.info(`[cairn:sync] 向 ${peerId} 广播 ${hashes.length} 个 blob`)
    for (const hash of hashes) {
      const blob = await blobStore.get(hash)
      if (blob) this.send(peerId, { type: 'have-blob', hash, size: blob.length })
    }
  }

  private async handleHaveBlob(peerId: string, hash: string): Promise<void> {
    const blobStore = this.options.blobStore
    if (!blobStore || await blobStore.has(hash)) return
    this.send(peerId, { type: 'want-blob', hash })
  }

  private async handleWantBlob(peerId: string, hash: string): Promise<void> {
    const blob = await this.options.blobStore?.get(hash)
    if (blob) this.send(peerId, { type: 'data-blob', hash, data: blob.toString('base64') })
  }

  private async handleDataBlob(hash: string, data: string): Promise<void> {
    const blobStore = this.options.blobStore
    if (!blobStore) return

    const content = Buffer.from(data, 'base64')
    const actualHash = createHash('sha256').update(content).digest('hex')
    if (actualHash !== hash) {
      this.emitError(new Error(`blob hash mismatch: expected ${hash}, got ${actualHash}`))
      return
    }
    await blobStore.put(content)
    await this.retryPendingBinaryOps()
  }

  private async retryPendingBinaryOps(): Promise<void> {
    if (!this.pendingOps || !this.options.blobStore || this.retryingPending) return

    for (const entry of await this.pendingOps.list()) {
      if (entry.op.blobHash && await this.options.blobStore.has(entry.op.blobHash)) {
        await this.applyRemoteOp(entry.op, false)
      }
    }
  }

  private async writeAndCompleteRemoteOp(
    op: import('../oplog').Op,
    content: string,
    retryPending: boolean,
  ): Promise<boolean> {
    this.options.oplog.setRemoteOpTargetContentHash(op.hash, contentHash(content))
    await this.hooks!.writeFile(op.filePath, content)
    await this.hooks!.applyRemoteChange(op.filePath, content)
    await this.afterFilesystemApply(op)
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
      const remotePath = await prepareSafeProjectWritePath(this.options.projectRoot, `${op.filePath}.cairn-remote`)
      await writeFile(remotePath, record.remoteContent, 'utf8')
    }
    await this.conflicts?.save(record)
    this.emit('conflictRecord', record)
    // 兼容现有 renderer 事件；C2 会改为从持久化记录读取详情。
    this.emit('conflict', op, localContent)
  }

  private async completeRemoteOp(op: import('../oplog').Op, retryPending: boolean): Promise<void> {
    this.options.oplog.markRemoteOpApplied(op.hash)
    await this.pendingOps?.remove(op.hash)
    if (retryPending) {
      await this.retryPendingOps()
    }
  }

  private async afterFilesystemApply(op: import('../oplog').Op): Promise<void> {
    await this.afterFilesystemApplyBeforeMarkApplied?.(op)
  }

  private markTerminalRemoteFailure(op: import('../oplog').Op | undefined, error: unknown): void {
    if (op && isTerminalRemoteApplyError(error)) {
      this.options.oplog.markRemoteOpRejected(op.hash)
    }
  }

  /** 阻止通过项目内符号链接访问项目根目录以外的内容。 */
  private async assertSafeProjectPath(relativePath: string): Promise<void> {
    const projectRoot = this.options.projectRoot
    if (!projectRoot) {
      return
    }

    await resolveSafeProjectPath(projectRoot, relativePath)
  }

  /** 空內容與不存在必須分開處理；沒有 hook 時也只能查詢真實檔案狀態。 */
  private async fileExists(relativePath: string): Promise<boolean> {
    if (this.hooks?.fileExists) {
      return this.hooks.fileExists(relativePath)
    }
    if (!this.options.projectRoot) {
      // 僅供沒有真實專案根目錄的受控呼叫端使用；安全預設是視為存在，
      // 不能再從空字串推論「缺失」而跳過刪除的 filesystem side effect。
      return true
    }

    const absolutePath = await resolveSafeProjectPath(this.options.projectRoot, relativePath)
    try {
      const metadata = await lstat(absolutePath)
      if (!metadata.isFile()) {
        throw new Error(`遠端操作目標不是一般檔案：${relativePath}`)
      }
      return true
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
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

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function splitLines(content: string): string[] {
  return content.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isTerminalRemoteApplyError(error: unknown): boolean {
  return error instanceof UnsafeProjectPathError
    || (error instanceof Error && error.message.startsWith('拒绝同步敏感文件'))
}
