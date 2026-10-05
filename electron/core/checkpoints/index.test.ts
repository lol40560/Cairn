import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CheckpointManager } from './index'

const roots: string[] = []
const symlinkIt = process.platform === 'win32' ? it.skip : it

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

  it('允許省略手動名稱，並拒絕過長名稱', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'app.ts'), 'value')
    await expect(manager.create('x'.repeat(101))).rejects.toThrow('Checkpoint name too long')

    const unnamed = await manager.create('')
    expect(unnamed.name).toMatch(/^Checkpoint · /)

    const checkpoint = await manager.create('Delete me')
    await manager.delete(checkpoint.id)
    expect(await manager.has(checkpoint.id)).toBe(false)
    expect((await manager.list()).map((item) => item.id)).toEqual([unnamed.id])
  })

  it('比較 checkpoint 與目前狀態，正確列出修改、新增與刪除', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'same.ts'), 'same\n')
    await writeFile(join(root, 'modified.ts'), 'before\n')
    await writeFile(join(root, 'deleted.ts'), 'gone\n')
    const checkpoint = await manager.create('Compare')

    await writeFile(join(root, 'modified.ts'), 'after\n')
    await rm(join(root, 'deleted.ts'))
    await writeFile(join(root, 'added.ts'), 'new\n')
    const comparison = await manager.compare(checkpoint.id)

    expect(comparison.summary).toMatchObject({ added: 1, deleted: 1, modified: 1, unchanged: 1 })
    expect(comparison.files.filter((file) => file.status !== 'unchanged').map((file) => `${file.status}:${file.path}`)).toEqual([
      'added:added.ts', 'deleted:deleted.ts', 'modified:modified.ts',
    ])
    await expect(manager.readComparisonFile(checkpoint.id, 'modified.ts')).resolves.toMatchObject({ checkpointContent: 'before\n', currentContent: 'after\n' })
  })

  it('restore 在 stale 預覽時中止且不寫入，並只恢復受 snapshot 管理的檔案', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'app.ts'), 'safe\n')
    const checkpoint = await manager.create('Safe')
    const preview = await manager.compare(checkpoint.id)
    await writeFile(join(root, 'app.ts'), 'changed since preview\n')
    await expect(manager.restore(checkpoint.id, preview.currentRevision)).rejects.toThrow('Project changed since the restore preview')
    await expect(readFile(join(root, 'app.ts'), 'utf8')).resolves.toBe('changed since preview\n')

    await writeFile(join(root, 'app.ts'), 'broken\n')
    await writeFile(join(root, 'ignored.pdf'), Buffer.from([0, 1, 2]))
    const freshPreview = await manager.compare(checkpoint.id)
    await manager.restore(checkpoint.id, freshPreview.currentRevision)
    await expect(readFile(join(root, 'app.ts'), 'utf8')).resolves.toBe('safe\n')
    await expect(readFile(join(root, 'ignored.pdf'))).resolves.toEqual(Buffer.from([0, 1, 2]))
  })

  it('保存 automatic recovery metadata', async () => {
    const root = await createProject()
    const manager = new CheckpointManager(root)
    await writeFile(join(root, 'app.ts'), 'value\n')
    const checkpoint = await manager.create('Before restoring checkpoint', { source: 'auto-before-restore' })
    expect(checkpoint.source).toBe('auto-before-restore')
    expect((await manager.list())[0]).toMatchObject({ id: checkpoint.id, source: 'auto-before-restore' })
  })

  symlinkIt('regression: restore rejects a symlink parent escaping the project', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-checkpoint-outside-'))
    roots.push(outside)
    const manager = new CheckpointManager(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'app.ts'), 'safe\n', 'utf8')
    const checkpoint = await manager.create('Safe')
    await rm(join(root, 'src'), { force: true, recursive: true })
    await symlink(outside, join(root, 'src'), 'dir')

    await expect(manager.restore(checkpoint.id)).rejects.toThrow('symbolic link')
    await expect(access(join(outside, 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
