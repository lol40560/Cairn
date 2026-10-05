import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { packageProjectAsZip } from './export'
import { extractZipBuffer } from './extract'

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
})
