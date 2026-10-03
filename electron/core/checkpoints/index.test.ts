import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CheckpointManager } from './index'

const roots: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-checkpoint-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('CheckpointManager', () => {
  it('空專案沒有 checkpoint，建立後可列出 manifest 與 ZIP', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'app.ts'), 'export const value = 1\n')

    expect(await manager.list()).toEqual([])
    const checkpoint = await manager.create('Demo safe')

    expect((await manager.list()).map((item) => item.id)).toEqual([checkpoint.id])
    await expect(stat(join(root, '.cairn', 'checkpoints', checkpoint.id, 'snapshot.zip'))).resolves.toBeDefined()
    expect(JSON.parse(await readFile(join(root, '.cairn', 'checkpoints', checkpoint.id, 'manifest.json'), 'utf8'))).toMatchObject(checkpoint)
  })

  it('恢復時還原檔案並保留 .cairn 與 .git', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, '.cairn'), { recursive: true })
    await writeFile(join(root, '.git', 'config'), 'history')
    await writeFile(join(root, '.cairn', 'oplog-marker'), 'oplog')
    await writeFile(join(root, 'app.ts'), 'safe\n')
    const checkpoint = await manager.create('Safe')

    await writeFile(join(root, 'app.ts'), 'broken\n')
    await writeFile(join(root, 'new.ts'), 'remove me\n')
    const restored = await manager.restore(checkpoint.id)

    expect(restored.restored).toBe(1)
    await expect(readFile(join(root, 'app.ts'), 'utf8')).resolves.toBe('safe\n')
    await expect(stat(join(root, '.cairn', 'oplog-marker'))).resolves.toBeDefined()
    await expect(stat(join(root, '.git', 'config'))).resolves.toBeDefined()
    await expect(stat(join(root, 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('刪除 checkpoint 並拒絕無效名稱', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'app.ts'), 'value')
    await expect(manager.create('')).rejects.toThrow('Checkpoint name is required')
    await expect(manager.create('x'.repeat(101))).rejects.toThrow('Checkpoint name too long')

    const checkpoint = await manager.create('Delete me')
    await manager.delete(checkpoint.id)
    expect(await manager.has(checkpoint.id)).toBe(false)
    expect(await manager.list()).toEqual([])
  })
})
