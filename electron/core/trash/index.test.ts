import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TrashManager } from './index'

const roots: string[] = []
const symlinkIt = process.platform === 'win32' ? it.skip : it

async function createFixture(): Promise<{ root: string; trash: TrashManager }> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-trash-'))
  roots.push(root)
  return { root, trash: new TrashManager(root) }
}

async function addFile(root: string, path: string, content: string): Promise<string> {
  const absolutePath = join(root, path)
  await mkdir(join(absolutePath, '..'), { recursive: true })
  await writeFile(absolutePath, content, 'utf8')
  return absolutePath
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('TrashManager', () => {
  it('移动文件后原路径消失，废纸篓包含内容和元数据', async () => {
    const { root, trash } = await createFixture()
    const source = await addFile(root, 'src/file.ts', 'export const value = 1\n')

    const id = await trash.moveToTrash('src/file.ts', source, 'tester', 'a'.repeat(64))

    await expect(import('node:fs/promises').then(({ readFile }) => readFile(source, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' })
    const entries = await trash.list()
    expect(entries).toEqual([expect.objectContaining({ trashId: id, originalPath: 'src/file.ts', author: 'tester', sizeBytes: 23 })])
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(root, '.cairn', 'trash', id, 'content'), 'utf8'))).resolves.toBe('export const value = 1\n')
  })

  it('list 按 deletedAt 倒序返回', async () => {
    const { root, trash } = await createFixture()
    const first = await trash.moveToTrash('first.ts', await addFile(root, 'first.ts', 'first'), 'a', 'a'.repeat(64))
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await trash.moveToTrash('second.ts', await addFile(root, 'second.ts', 'second'), 'b', 'b'.repeat(64))

    expect((await trash.list()).map((entry) => entry.trashId)).toEqual([second, first])
  })

  it('restore 会恢复原始文件', async () => {
    const { root, trash } = await createFixture()
    const source = await addFile(root, 'nested/file.ts', 'restore me')
    const id = await trash.moveToTrash('nested/file.ts', source, 'tester', 'a'.repeat(64))

    await trash.restore(id)

    await expect(import('node:fs/promises').then(({ readFile }) => readFile(source, 'utf8'))).resolves.toBe('restore me')
    expect(await trash.list()).toEqual([])
  })

  it('restore 不覆盖已被占用的原始路径', async () => {
    const { root, trash } = await createFixture()
    const source = await addFile(root, 'file.ts', 'old')
    const id = await trash.moveToTrash('file.ts', source, 'tester', 'a'.repeat(64))
    await writeFile(source, 'new', 'utf8')

    await expect(trash.restore(id)).rejects.toThrow('file.ts 已存在')
  })

  it('purge 会永久删除条目', async () => {
    const { root, trash } = await createFixture()
    const id = await trash.moveToTrash('file.ts', await addFile(root, 'file.ts', 'content'), 'tester', 'a'.repeat(64))

    await trash.purge(id)

    expect(await trash.list()).toEqual([])
  })

  it('cleanup 只清理超过保留期的条目', async () => {
    const { root, trash } = await createFixture()
    const oldId = await trash.moveToTrash('old.ts', await addFile(root, 'old.ts', 'old'), 'tester', 'a'.repeat(64))
    const freshId = await trash.moveToTrash('fresh.ts', await addFile(root, 'fresh.ts', 'fresh'), 'tester', 'b'.repeat(64))
    const metaPath = join(root, '.cairn', 'trash', oldId, 'meta.json')
    const oldMeta = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(metaPath, 'utf8'))) as { deletedAt: number }
    oldMeta.deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000
    await writeFile(metaPath, JSON.stringify(oldMeta), 'utf8')

    await expect(trash.cleanup(30)).resolves.toBe(1)
    expect((await trash.list()).map((entry) => entry.trashId)).toEqual([freshId])
  })

  symlinkIt('regression: restore rejects a symlink parent escaping the project', async () => {
    const { root, trash } = await createFixture()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-trash-outside-'))
    roots.push(outside)
    const id = await trash.moveToTrash('restored/file.ts', await addFile(root, 'restored/file.ts', 'content'), 'tester', 'a'.repeat(64))
    await rm(join(root, 'restored'), { force: true, recursive: true })
    await symlink(outside, join(root, 'restored'), 'dir')

    await expect(trash.restore(id)).rejects.toThrow('symbolic link')
    await expect(access(join(outside, 'file.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
