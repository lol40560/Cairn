import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConflictsManager, type ConflictRecord } from './index'

const roots: string[] = []
const firstHash = 'a'.repeat(64)
const secondHash = 'b'.repeat(64)

async function createFixture(): Promise<{ root: string; manager: ConflictsManager }> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-conflicts-'))
  roots.push(root)
  return { root, manager: new ConflictsManager(root) }
}

function createRecord(opHash = firstHash): ConflictRecord {
  return {
    author: 'alice',
    filePath: 'src/auth.ts',
    localContent: 'local\n',
    opHash,
    remoteContent: 'remote\n',
    timestamp: opHash === firstHash ? 100 : 200,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('ConflictsManager', () => {
  it('保存、读取并按最新时间列出冲突记录', async () => {
    const { manager } = await createFixture()
    await manager.save(createRecord(firstHash))
    await manager.save(createRecord(secondHash))

    await expect(manager.get(firstHash)).resolves.toMatchObject({ opHash: firstHash })
    await expect(manager.list()).resolves.toMatchObject([
      { opHash: secondHash },
      { opHash: firstHash },
    ])
  })

  it('保留本地版本时只删除冲突记录和远端副本', async () => {
    const { root, manager } = await createFixture()
    const target = join(root, 'src', 'auth.ts')
    await writeFile(target, 'local\n', 'utf8').catch(async () => {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'src'), { recursive: true }))
      await writeFile(target, 'local\n', 'utf8')
    })
    await writeFile(`${target}.cairn-remote`, 'remote\n', 'utf8')
    await manager.save(createRecord())

    await manager.resolve(firstHash, 'local')

    await expect(readFile(target, 'utf8')).resolves.toBe('local\n')
    await expect(manager.get(firstHash)).resolves.toBeUndefined()
  })

  it('选择远端或手动合并版本会写入主文件', async () => {
    const { root, manager } = await createFixture()
    await manager.save(createRecord(firstHash))
    await manager.resolve(firstHash, 'remote')
    await expect(readFile(join(root, 'src', 'auth.ts'), 'utf8')).resolves.toBe('remote\n')

    await manager.save(createRecord(secondHash))
    await manager.resolve(secondHash, 'merged', 'merged\n')
    await expect(readFile(join(root, 'src', 'auth.ts'), 'utf8')).resolves.toBe('merged\n')
  })
})
