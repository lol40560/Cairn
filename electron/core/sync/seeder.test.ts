import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SyncMessage } from './protocol'
import { SNAPSHOT_CHUNK_SIZE, SnapshotSeeder } from './seeder'
import type { Sync } from './sync'

const roots: string[] = []

class FakeSync {
  readonly broadcasts: SyncMessage[] = []
  readonly sent: Array<{ peerId: string; message: SyncMessage }> = []

  broadcast(message: SyncMessage): void {
    this.broadcasts.push(message)
  }

  send(peerId: string, message: SyncMessage): void {
    this.sent.push({ peerId, message })
  }
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-seeder-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SnapshotSeeder', () => {
  it('启动后生成 SHA-256 快照 ID 并广播可用状态', async () => {
    const root = await createProject()
    await writeFile(join(root, 'sample.ts'), `export const value = '${randomBytes(SNAPSHOT_CHUNK_SIZE).toString('base64')}'\n`)
    const sync = new FakeSync()
    const seeder = new SnapshotSeeder(root, sync as unknown as Sync)

    const state = await seeder.start()

    expect(state.snapshotId).toMatch(/^[a-f0-9]{64}$/)
    expect(state.chunkCount).toBeGreaterThan(1)
    expect(sync.broadcasts).toContainEqual({
      type: 'seeder-available',
      snapshotId: state.snapshotId,
      projectName: basename(root),
      size: state.totalBytes,
    })
    expect(seeder.state()).toEqual(state)
  })

  it('按请求发送元数据和 base64 分块', async () => {
    const root = await createProject()
    await writeFile(join(root, 'sample.ts'), 'export const value = 2\n')
    const sync = new FakeSync()
    const seeder = new SnapshotSeeder(root, sync as unknown as Sync)
    const state = await seeder.start()

    seeder.handleWantSnapshot('peer-a', state.snapshotId)
    seeder.handleWantChunk('peer-a', state.snapshotId, 0)

    expect(sync.sent[0]).toEqual({
      peerId: 'peer-a',
      message: {
        type: 'snapshot-meta',
        snapshotId: state.snapshotId,
        projectName: state.projectName,
        size: state.totalBytes,
        chunkCount: state.chunkCount,
      },
    })
    const chunk = sync.sent[1]
    expect(chunk?.message.type).toBe('chunk')
    if (chunk?.message.type === 'chunk') {
      const content = Buffer.from(chunk.message.data, 'base64')
      expect(createHash('sha256').update(content).digest('hex')).toHaveLength(64)
      expect(content.length).toBeLessThanOrEqual(SNAPSHOT_CHUNK_SIZE)
    }
  })

  it('拒绝越界的分块索引', async () => {
    const root = await createProject()
    await writeFile(join(root, 'sample.ts'), 'export {}\n')
    const seeder = new SnapshotSeeder(root, new FakeSync() as unknown as Sync)
    const state = await seeder.start()

    expect(() => seeder.handleWantChunk('peer-a', state.snapshotId, state.chunkCount)).toThrow('索引越界')
    expect(() => seeder.handleWantChunk('peer-a', 'missing', 0)).toThrow('找不到可共享快照')
  })

  it('停止共享后清空内存并广播 gone', async () => {
    const root = await createProject()
    await writeFile(join(root, 'sample.ts'), 'export {}\n')
    const sync = new FakeSync()
    const seeder = new SnapshotSeeder(root, sync as unknown as Sync)
    const state = await seeder.start()

    seeder.stop()

    expect(seeder.state()).toBeUndefined()
    expect(sync.broadcasts).toContainEqual({ type: 'seeder-gone', snapshotId: state.snapshotId })
  })
})
