import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'

import { packageProjectAsZip } from '../snapshot/export'
import type { Sync } from './sync'

export const SNAPSHOT_CHUNK_SIZE = 64 * 1024

export interface SeederState {
  snapshotId: string
  projectName: string
  totalBytes: number
  chunkCount: number
  active: boolean
}

interface SeededSnapshot extends SeederState {
  buffer: Buffer
  chunks: Buffer[]
}

/**
 * 在内存中保存一次项目快照，并按需向房间中的对等端逐块发送。
 * v3.1 不持久化快照；停止共享后需要重新打包。
 */
export class SnapshotSeeder extends EventEmitter {
  private readonly snapshots = new Map<string, SeededSnapshot>()
  private activeSnapshotId: string | undefined

  constructor(
    private readonly projectRoot: string,
    private readonly sync: Sync,
  ) {
    super()
  }

  async start(): Promise<SeederState> {
    this.stop()

    const packaged = await packageProjectAsZip(this.projectRoot)
    const snapshotId = createHash('sha256').update(packaged.buffer).digest('hex')
    const chunks = Array.from(
      { length: Math.ceil(packaged.buffer.length / SNAPSHOT_CHUNK_SIZE) },
      (_, index) => packaged.buffer.subarray(index * SNAPSHOT_CHUNK_SIZE, (index + 1) * SNAPSHOT_CHUNK_SIZE),
    )
    const state: SeededSnapshot = {
      snapshotId,
      projectName: basename(this.projectRoot),
      totalBytes: packaged.buffer.length,
      chunkCount: chunks.length,
      active: true,
      buffer: packaged.buffer,
      chunks,
    }

    this.snapshots.set(snapshotId, state)
    this.activeSnapshotId = snapshotId
    this.announce()
    this.emit('stateChange', this.toPublicState(state))
    return this.toPublicState(state)
  }

  stop(): void {
    const state = this.currentSnapshot()
    if (state) {
      this.sync.broadcast({ type: 'seeder-gone', snapshotId: state.snapshotId })
    }
    this.snapshots.clear()
    this.activeSnapshotId = undefined
    this.emit('stateChange', undefined)
  }

  state(): SeederState | undefined {
    const state = this.currentSnapshot()
    return state ? this.toPublicState(state) : undefined
  }

  /** 新 peer 完成连接时由 Sync 调用，避免其错过最初的广播。 */
  announceToPeer(peerId: string): void {
    const state = this.currentSnapshot()
    if (!state) {
      return
    }
    this.sync.send(peerId, {
      type: 'seeder-available',
      snapshotId: state.snapshotId,
      projectName: state.projectName,
      size: state.totalBytes,
    })
  }

  handleWantSnapshot(peerId: string, snapshotId: string): void {
    const snapshot = this.requireSnapshot(snapshotId)
    this.sync.send(peerId, {
      type: 'snapshot-meta',
      snapshotId: snapshot.snapshotId,
      projectName: snapshot.projectName,
      size: snapshot.totalBytes,
      chunkCount: snapshot.chunkCount,
    })
  }

  handleWantChunk(peerId: string, snapshotId: string, index: number): void {
    const snapshot = this.requireSnapshot(snapshotId)
    if (!Number.isInteger(index) || index < 0 || index >= snapshot.chunkCount) {
      throw new Error(`快照分块索引越界：${index}（共 ${snapshot.chunkCount} 块）`)
    }

    this.sync.send(peerId, {
      type: 'chunk',
      snapshotId,
      index,
      data: snapshot.chunks[index]!.toString('base64'),
    })
  }

  on(event: 'stateChange', listener: (state: SeederState | undefined) => void): this
  on(event: 'stateChange', listener: (state: SeederState | undefined) => void): this {
    return super.on(event, listener)
  }

  private announce(): void {
    const state = this.currentSnapshot()
    if (!state) {
      return
    }
    this.sync.broadcast({
      type: 'seeder-available',
      snapshotId: state.snapshotId,
      projectName: state.projectName,
      size: state.totalBytes,
    })
  }

  private currentSnapshot(): SeededSnapshot | undefined {
    return this.activeSnapshotId ? this.snapshots.get(this.activeSnapshotId) : undefined
  }

  private requireSnapshot(snapshotId: string): SeededSnapshot {
    const snapshot = this.snapshots.get(snapshotId)
    if (!snapshot || snapshotId !== this.activeSnapshotId) {
      throw new Error(`找不到可共享快照：${snapshotId}`)
    }
    return snapshot
  }

  private toPublicState(snapshot: SeededSnapshot): SeederState {
    return {
      snapshotId: snapshot.snapshotId,
      projectName: snapshot.projectName,
      totalBytes: snapshot.totalBytes,
      chunkCount: snapshot.chunkCount,
      active: snapshot.active,
    }
  }
}
