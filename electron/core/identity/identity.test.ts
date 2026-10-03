import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { computeProjectIdentity } from './index'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function createProject(name = 'project'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-identity-'))
  roots.push(root)
  const project = join(root, name)
  await mkdir(project)
  return project
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('computeProjectIdentity', () => {
  it('Git 專案包含 HEAD commit', async () => {
    const project = await createProject()
    await writeFile(join(project, 'package.json'), '{"name":"cairn"}')
    await execFileAsync('git', ['-C', project, 'init'])
    await execFileAsync('git', ['-C', project, 'config', 'user.email', 'test@cairn.local'])
    await execFileAsync('git', ['-C', project, 'config', 'user.name', 'Cairn Test'])
    await execFileAsync('git', ['-C', project, 'add', 'package.json'])
    await execFileAsync('git', ['-C', project, 'commit', '-m', 'initial'])

    const identity = await computeProjectIdentity(project)

    expect(identity.baseCommit).toMatch(/^[a-f0-9]{40}$/)
  })

  it('非 Git 專案不帶 baseCommit', async () => {
    const identity = await computeProjectIdentity(await createProject())

    expect(identity.baseCommit).toBeUndefined()
  })

  it('相同專案內容會得到穩定 fingerprint', async () => {
    const project = await createProject()
    await writeFile(join(project, 'package.json'), '{"name":"cairn"}')

    const first = await computeProjectIdentity(project)
    const second = await computeProjectIdentity(project)

    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('manifest 改變時 fingerprint 也會改變', async () => {
    const project = await createProject()
    await writeFile(join(project, 'package.json'), '{"name":"first"}')
    const first = await computeProjectIdentity(project)
    await writeFile(join(project, 'package.json'), '{"name":"second"}')
    const second = await computeProjectIdentity(project)

    expect(second.fingerprint).not.toBe(first.fingerprint)
  })
})
