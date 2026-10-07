import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CaseCollisionError,
  assertNoCaseCollisionForWrite,
  assertNoCaseCollisions,
  isCaseInsensitiveFilesystem,
  UnsafeProjectPathError,
  prepareSafeProjectWritePath,
  resolveSafeProjectPath,
} from './project-path'

const roots: string[] = []
const symlinkIt = process.platform === 'win32' ? it.skip : it

async function createFixture(): Promise<{ project: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-safe-path-'))
  roots.push(root)
  const project = join(root, 'project')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(project), mkdir(outside)])
  return { project, outside }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('project-bound write paths', () => {
  it('detects case-only logical collisions through the injectable filesystem capability seam', async () => {
    expect(() => assertNoCaseCollisions(['Foo.ts', 'foo.ts'], true)).toThrow(CaseCollisionError)
    expect(() => assertNoCaseCollisions(['Foo.ts', 'foo.ts'], false)).not.toThrow()
    const { project } = await createFixture()
    await writeFile(join(project, 'foo.ts'), 'existing', 'utf8')
    await expect(assertNoCaseCollisionForWrite(project, 'Foo.ts', { caseInsensitive: true })).rejects.toBeInstanceOf(CaseCollisionError)
  })

  it('probes the real project volume without leaving an artifact', async () => {
    const { project } = await createFixture()
    await expect(isCaseInsensitiveFilesystem(project)).resolves.toEqual(expect.any(Boolean))
    expect((await readdir(join(project, '.cairn'))).some((entry) => entry.startsWith('case-probe-'))).toBe(false)
  })
  it('regression: permits a normal nested write', async () => {
    const { project } = await createFixture()
    const destination = await prepareSafeProjectWritePath(project, 'a/b/file.txt')
    await writeFile(destination, 'safe', 'utf8')

    await expect(readFile(join(project, 'a', 'b', 'file.txt'), 'utf8')).resolves.toBe('safe')
  })

  it('regression: rejects lexical traversal', async () => {
    const { outside, project } = await createFixture()

    await expect(prepareSafeProjectWritePath(project, '../outside/pwned.txt')).rejects.toBeInstanceOf(UnsafeProjectPathError)
    await expect(access(join(outside, 'pwned.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('regression: rejects absolute paths', async () => {
    const { project } = await createFixture()

    await expect(resolveSafeProjectPath(project, join(tmpdir(), 'outside.txt'))).rejects.toBeInstanceOf(UnsafeProjectPathError)
  })

  symlinkIt('regression: rejects a parent symlink escaping the project', async () => {
    const { outside, project } = await createFixture()
    await symlink(outside, join(project, 'link'), 'dir')

    await expect(prepareSafeProjectWritePath(project, 'link/pwned.txt')).rejects.toThrow('symbolic link')
    await expect(access(join(outside, 'pwned.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  symlinkIt('regression: rejects a nested symlink escaping the project', async () => {
    const { outside, project } = await createFixture()
    await mkdir(join(project, 'a'))
    await symlink(outside, join(project, 'a', 'b'), 'dir')

    await expect(prepareSafeProjectWritePath(project, 'a/b/pwned.txt')).rejects.toThrow('symbolic link')
    await expect(access(join(outside, 'pwned.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  symlinkIt('regression: rejects a symlink target before overwrite', async () => {
    const { outside, project } = await createFixture()
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'unchanged', 'utf8')
    await symlink(outsideFile, join(project, 'file.txt'), 'file')

    await expect(prepareSafeProjectWritePath(project, 'file.txt')).rejects.toThrow('symbolic link')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('unchanged')
    expect((await lstat(join(project, 'file.txt'))).isSymbolicLink()).toBe(true)
  })
})
