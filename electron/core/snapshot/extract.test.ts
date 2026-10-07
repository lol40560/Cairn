import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { packageProjectAsZip } from './export'
import { extractZipBuffer, readZipEntries } from './extract'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver') as { ZipArchive: new (options: { zlib: { level: number } }) => {
  append(content: Buffer, options: { name: string }): void
  finalize(): void
  on(event: 'error', listener: (error: Error) => void): void
  pipe(destination: NodeJS.WritableStream): void
} }

const roots: string[] = []
const symlinkIt = process.platform === 'win32' ? it.skip : it

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

async function createZip(entries: Array<{ path: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('finish', () => resolve(Buffer.concat(chunks)))
    output.once('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    entries.forEach((entry) => archive.append(entry.content, { name: entry.path }))
    archive.finalize()
  })
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

  it('regression: restores executable and normal file modes from a snapshot', async () => {
    const source = await createDirectory('cairn-extract-source-')
    const target = await createDirectory('cairn-extract-target-')
    await writeFile(join(source, 'normal.sh'), 'echo normal\n', 'utf8')
    await writeFile(join(source, 'executable.sh'), 'echo executable\n', 'utf8')
    if (process.platform !== 'win32') await chmod(join(source, 'executable.sh'), 0o755)
    const snapshot = await packageProjectAsZip(source)

    await extractZipBuffer(snapshot.buffer, target)

    if (process.platform !== 'win32') {
      expect((await stat(join(target, 'normal.sh'))).mode & 0o111).toBe(0)
      expect((await stat(join(target, 'executable.sh'))).mode & 0o111).not.toBe(0)
    }
  })

  it('regression: rejects case-colliding ZIP entries before writing on a case-insensitive target', async () => {
    const target = await createDirectory('cairn-extract-target-')
    const snapshot = await createZip([
      { path: 'Foo.ts', content: Buffer.from('upper\n') },
      { path: 'foo.ts', content: Buffer.from('lower\n') },
    ])

    await expect(extractZipBuffer(snapshot, target, { caseInsensitive: true })).rejects.toThrow('Case-colliding')
    await expect(access(join(target, 'Foo.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
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
