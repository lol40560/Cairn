import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BlobStore } from './index'

const roots: string[] = []

async function createStore(): Promise<BlobStore> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-blobs-'))
  roots.push(root)
  return new BlobStore(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('BlobStore', () => {
  it('以內容 SHA-256 去重並讀回 blob', async () => {
    const store = await createStore()
    const content = Buffer.from([0, 1, 2, 3])
    const expectedHash = createHash('sha256').update(content).digest('hex')

    expect(await store.put(content)).toBe(expectedHash)
    expect(await store.put(content)).toBe(expectedHash)
    expect(await store.get(expectedHash)).toEqual(content)
  })

  it('能檢查、列出並刪除 blob', async () => {
    const store = await createStore()
    const first = await store.put(Buffer.from('first'))
    const second = await store.put(Buffer.from('second'))

    expect(await store.has(first)).toBe(true)
    expect(await store.has('f'.repeat(64))).toBe(false)
    expect(await store.listAll()).toEqual([first, second].sort())

    await store.delete(first)
    expect(await store.get(first)).toBeUndefined()
    expect(await store.listAll()).toEqual([second])
  })

  it('可儲存超過 watcher 上限的大型 blob', async () => {
    const store = await createStore()
    const content = Buffer.alloc(5 * 1024 * 1024 + 1, 7)
    const hash = await store.put(content)

    expect(await store.get(hash)).toEqual(content)
  })
})
