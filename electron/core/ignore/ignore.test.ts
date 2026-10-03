import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { IgnoreMatcher } from './index'

const roots: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-ignore-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('IgnoreMatcher', () => {
  it('忽略預設內部與依賴目錄', async () => {
    const matcher = new IgnoreMatcher(await createProject())

    expect(matcher.isIgnored('.git/config')).toBe(true)
    expect(matcher.isIgnored('.cairn/objects/op')).toBe(true)
    expect(matcher.isIgnored('node_modules/pkg/index.js')).toBe(true)
    expect(matcher.isIgnored('src/auth.ts')).toBe(false)
  })

  it('讀取 .gitignore 規則', async () => {
    const root = await createProject()
    await writeFile(join(root, '.gitignore'), '*.log\n')
    const matcher = new IgnoreMatcher(root)

    expect(matcher.isIgnored('debug.log')).toBe(true)
    expect(matcher.isIgnored('src/debug.log')).toBe(true)
  })

  it('.cairnignore 的否定規則可覆蓋 .gitignore', async () => {
    const root = await createProject()
    await writeFile(join(root, '.gitignore'), '*.log\n')
    await writeFile(join(root, '.cairnignore'), '!important.log\n')
    const matcher = new IgnoreMatcher(root)

    expect(matcher.isIgnored('ordinary.log')).toBe(true)
    expect(matcher.isIgnored('important.log')).toBe(false)
  })

  it('敏感檔案永遠被忽略，但允許 .env.example', async () => {
    const matcher = new IgnoreMatcher(await createProject())

    expect(matcher.isIgnored('.env')).toBe(true)
    expect(matcher.isIgnored('config/.env.production')).toBe(true)
    expect(matcher.isIgnored('.env.example')).toBe(false)
  })

  it('支援 .gitignore 的負向規則', async () => {
    const root = await createProject()
    await writeFile(join(root, '.gitignore'), '*.md\n!README.md\n')
    const matcher = new IgnoreMatcher(root)

    expect(matcher.isIgnored('notes.md')).toBe(true)
    expect(matcher.isIgnored('README.md')).toBe(false)
  })
})
