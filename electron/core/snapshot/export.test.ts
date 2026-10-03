import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { exportProjectSnapshot } from './export'

const roots: string[] = []
const archives: string[] = []

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-export-'))
  roots.push(projectRoot)
  return projectRoot
}

afterEach(async () => {
  await Promise.all(archives.splice(0).map((filePath) => rm(filePath, { force: true })))
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('exportProjectSnapshot', () => {
  it('打包三个文本文件并返回文件计数', async () => {
    const root = await createProject()
    await writeFile(join(root, 'one.ts'), 'export const one = 1\n')
    await writeFile(join(root, 'two.md'), '# Two\n')
    await writeFile(join(root, 'three.txt'), 'three\n')

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)

    expect(result.fileCount).toBe(3)
    expect(result.fileSize).toBeGreaterThan(0)
  })

  it('跳过内部目录与依赖目录', async () => {
    const root = await createProject()
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'package'), { recursive: true })
    await writeFile(join(root, 'keep.ts'), 'export {}\n')
    await writeFile(join(root, '.git', 'config'), 'ignored')
    await writeFile(join(root, 'node_modules', 'package', 'index.js'), 'ignored')

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)
    const archiveContents = (await readFile(result.filePath)).toString('utf8')

    expect(result.fileCount).toBe(1)
    expect(archiveContents).toContain('keep.ts')
    expect(archiveContents).not.toContain('.git/config')
    expect(archiveContents).not.toContain('node_modules/package/index.js')
  })

  it('遵守项目的 .gitignore 规则', async () => {
    const root = await createProject()
    await writeFile(join(root, '.gitignore'), '*.log\n')
    await writeFile(join(root, 'keep.md'), '# Keep\n')
    await writeFile(join(root, 'ignored.log'), 'do not export\n')

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)
    const archiveContents = (await readFile(result.filePath)).toString('utf8')

    expect(result.fileCount).toBe(2)
    expect(archiveContents).toContain('keep.md')
    expect(archiveContents).not.toContain('ignored.log')
  })

  it('打包白名单 binary 文件', async () => {
    const root = await createProject()
    await writeFile(join(root, 'notes.txt'), 'text')
    await writeFile(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 0]))

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)

    expect(result.fileCount).toBe(2)
    expect(result.skippedCount).toBe(0)
  })

  it('跳过超过 5 MB 的白名单 binary 文件', async () => {
    const root = await createProject()
    await writeFile(join(root, 'notes.txt'), 'text')
    await writeFile(join(root, 'large.png'), Buffer.alloc(5 * 1024 * 1024 + 1, 1))

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)

    expect(result.fileCount).toBe(1)
    expect(result.skippedCount).toBe(1)
  })

  it('跳过敏感文件，但保留 .env.example', async () => {
    const root = await createProject()
    await writeFile(join(root, '.env'), 'TOKEN=secret\n')
    await writeFile(join(root, '.env.production'), 'TOKEN=secret\n')
    await writeFile(join(root, 'deploy.key'), 'private key')
    await writeFile(join(root, '.env.example'), 'TOKEN=replace-me\n')

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)
    const archiveContents = (await readFile(result.filePath)).toString('utf8')

    expect(result.fileCount).toBe(1)
    expect(archiveContents).toContain('.env.example')
    expect(archiveContents).not.toContain('.env.production')
    expect(archiveContents).not.toContain('deploy.key')
  })

  it('拒绝项目外符号链接，但允许项目内文件链接', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-export-outside-'))
    roots.push(outside)
    await writeFile(join(root, 'inside.ts'), 'export const inside = true\n')
    await writeFile(join(outside, 'secret.txt'), 'do not share\n')
    await symlink(join(root, 'inside.ts'), join(root, 'inside-link.ts'))
    await symlink(join(outside, 'secret.txt'), join(root, 'outside-link.txt'))

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)
    const archiveContents = (await readFile(result.filePath)).toString('utf8')

    expect(result.fileCount).toBe(2)
    expect(archiveContents).toContain('inside-link.ts')
    expect(archiveContents).not.toContain('outside-link.txt')
  })

  it('超过大小上限时拒绝打包', async () => {
    const root = await createProject()
    await writeFile(join(root, 'large.txt'), '123456')

    await expect(exportProjectSnapshot(root, { maxSizeBytes: 5 })).rejects.toThrow('项目过大')
  })

  it('空项目也会生成空 zip', async () => {
    const root = await createProject()

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)

    expect(result.fileCount).toBe(0)
    expect(result.fileSize).toBeGreaterThan(0)
  })

  it('保留嵌套文件的相对路径', async () => {
    const root = await createProject()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'src', 'nested', 'file.ts'), 'export const nested = true\n')

    const result = await exportProjectSnapshot(root)
    archives.push(result.filePath)
    const archiveContents = (await readFile(result.filePath)).toString('utf8')

    expect(archiveContents).toContain('src/nested/file.ts')
  })
})
