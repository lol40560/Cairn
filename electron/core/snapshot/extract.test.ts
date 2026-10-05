import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { packageProjectAsZip } from './export'
import { extractZipBuffer, readZipEntries } from './extract'

const roots: string[] = []
const symlinkIt = process.platform === 'win32' ? it.skip : it

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('extractZipBuffer', () => {
  symlinkIt('regression: rejects extraction through a symlink parent outside the project', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    const outside = await createDirectory('cairn-extract-outside-')
    await mkdir(join(source, 'src'))
    await writeFile(join(source, 'src', 'file.ts'), 'export const safe = true\n', 'utf8')
    const snapshot = await packageProjectAsZip(source)
    await symlink(outside, join(target, 'src'), 'dir')

    await expect(extractZipBuffer(snapshot.buffer, target)).rejects.toThrow('symbolic link')
    await expect(access(join(outside, 'file.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('extracts a normal ZIP within the default resource limits', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    await mkdir(join(source, 'src'))
    await writeFile(join(source, 'src', 'file.ts'), 'export const value = 1\n', 'utf8')
    const snapshot = await packageProjectAsZip(source)

    await extractZipBuffer(snapshot.buffer, target)

    await expect(readFile(join(target, 'src', 'file.ts'), 'utf8')).resolves.toBe('export const value = 1\n')
  })

  it('regression: rejects ZIP archives with too many file entries before extraction continues', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    await writeFile(join(source, 'one.ts'), 'one\n', 'utf8')
    await writeFile(join(source, 'two.ts'), 'two\n', 'utf8')
    await writeFile(join(source, 'three.ts'), 'three\n', 'utf8')
    const snapshot = await packageProjectAsZip(source)

    await expect(extractZipBuffer(snapshot.buffer, target, {
      limits: { maxEntries: 2 },
    })).rejects.toThrow('条目数量超过 2')
  })

  it('regression: rejects a highly compressed entry once its uncompressed limit is exceeded', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    await writeFile(join(source, 'bomb.txt'), 'A'.repeat(16 * 1024), 'utf8')
    const snapshot = await packageProjectAsZip(source)

    await expect(extractZipBuffer(snapshot.buffer, target, {
      limits: { maxEntryBytes: 1024, maxTotalUncompressedBytes: 1024 },
    })).rejects.toThrow('条目大小超过 1024')
  })

  it('regression: rejects archives whose total uncompressed content exceeds the session limit', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    await writeFile(join(source, 'one.txt'), 'A'.repeat(800), 'utf8')
    await writeFile(join(source, 'two.txt'), 'B'.repeat(800), 'utf8')
    const snapshot = await packageProjectAsZip(source)

    await expect(extractZipBuffer(snapshot.buffer, target, {
      limits: { maxEntryBytes: 1024, maxTotalUncompressedBytes: 1200 },
    })).rejects.toThrow('解压总大小超过 1200')
  })

  it('applies the same resource limits while reading checkpoint ZIP entries', async () => {
    const source = await createDirectory('cairn-extract-source-')
    await writeFile(join(source, 'checkpoint.txt'), 'A'.repeat(4096), 'utf8')
    const snapshot = await packageProjectAsZip(source)

    await expect(readZipEntries(snapshot.buffer, {
      maxEntryBytes: 1024,
      maxTotalUncompressedBytes: 1024,
    })).rejects.toThrow('条目大小超过 1024')
  })
})
