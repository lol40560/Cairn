import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createShadowGit } from './shadow'

const roots: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-shadow-'))
  roots.push(root)
  await writeFile(join(root, 'sample.ts'), 'export const value = 1\n', 'utf8')
  return root
}

function createOp(hash: string, author = 'alice') {
  return {
    author,
    diff: '',
    filePath: 'sample.ts',
    hash,
    id: hash,
    parentHashes: [],
    timestamp: 1,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('ShadowGit', () => {
  it('初始化 bare 仓库成功', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)

    await shadow.init()

    await expect(shadow.listCommits()).resolves.toEqual([])
  })

  it('commitOp 后可读取提交和正确的 message', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    const op = createOp('a'.repeat(64))

    await shadow.commitOp(op, root)

    await expect(shadow.listCommits()).resolves.toMatchObject([
      { message: '[cairn] alice: sample.ts (aaaaaaaa)' },
    ])
  })

  it('连续提交和 squash 后只保留一个可达提交', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    await shadow.commitOp(createOp('a'.repeat(64)), root)
    await writeFile(join(root, 'sample.ts'), 'export const value = 2\n', 'utf8')
    await shadow.commitOp(createOp('b'.repeat(64), 'bob'), root)

    expect(await shadow.listCommits()).toHaveLength(2)
    await shadow.squashCommits(2)

    expect(await shadow.listCommits()).toMatchObject([
      { message: '[cairn] Squash 2 commits' },
    ])
    await expect(shadow.listFiles()).resolves.toEqual([
      { content: 'export const value = 2\n', path: 'sample.ts' },
    ])
  })

  it('远端配置可往返读取', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    const info = { branch: 'main', url: 'https://github.com/acme/repo.git' }

    await shadow.setRemoteInfo(info)

    await expect(shadow.getRemoteInfo()).resolves.toEqual(info)
  })
})
