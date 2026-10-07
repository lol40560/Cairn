import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
      { content: Buffer.from('export const value = 2\n'), mode: '100644', path: 'sample.ts' },
    ])
  })

  it('删除 op 会从 shadow worktree 删除文件并创建删除提交', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    await shadow.commitOp(createOp('a'.repeat(64)), root)
    await rm(join(root, 'sample.ts'))

    await shadow.commitOp(createOp('b'.repeat(64), 'bob'), root)

    await expect(shadow.listFiles()).resolves.toEqual([])
    expect((await shadow.listCommits())[0]).toMatchObject({
      message: '[cairn] bob: deleted sample.ts (bbbbbbbb)',
    })
  })

  it('重复删除在 shadow 中已不存在时幂等跳过', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    await shadow.commitOp(createOp('a'.repeat(64)), root)
    await rm(join(root, 'sample.ts'))
    await shadow.commitOp(createOp('b'.repeat(64)), root)

    await expect(shadow.commitOp(createOp('c'.repeat(64)), root)).resolves.toBe('')
    await expect(shadow.listCommits()).resolves.toHaveLength(2)
  })

  it('拒绝项目外符号链接，并允许项目内符号链接', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-shadow-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true\n', 'utf8')
    await symlink(join(outside, 'secret.ts'), join(root, 'external-link.ts'))
    await symlink(join(root, 'sample.ts'), join(root, 'internal-link.ts'))
    const shadow = createShadowGit(root)

    await expect(shadow.commitOp({ ...createOp('d'.repeat(64)), filePath: 'external-link.ts' }, root)).rejects.toThrow('符号链接越界')
    await expect(shadow.commitOp({ ...createOp('e'.repeat(64)), filePath: 'internal-link.ts' }, root)).resolves.toMatch(/[a-f0-9]{40}/)
  })

  it('远端配置可往返读取', async () => {
    const root = await createProject()
    const shadow = createShadowGit(root)
    const info = { branch: 'main', url: 'https://github.com/acme/repo.git' }

    await shadow.setRemoteInfo(info)

    await expect(shadow.getRemoteInfo()).resolves.toEqual(info)
  })

  it('regression: preserves invalid UTF-8 bytes and executable mode through Shadow Git', async () => {
    const root = await createProject()
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc0, 0xf5, 0x41])
    await writeFile(join(root, 'tool.bin'), binary)
    if (process.platform !== 'win32') await chmod(join(root, 'tool.bin'), 0o755)
    const shadow = createShadowGit(root)

    await shadow.commitOp({ ...createOp('f'.repeat(64)), filePath: 'tool.bin' }, root)

    await expect(shadow.listFiles()).resolves.toEqual([
      { content: binary, mode: process.platform === 'win32' ? '100644' : '100755', path: 'tool.bin' },
    ])
  })
})
