import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Op } from '../oplog'
import { PendingOps } from './pending-ops'

const roots: string[] = []

function pendingOp(hash: string): Op {
  return {
    author: 'alice',
    diff: 'diff',
    filePath: 'src/example.ts',
    hash,
    id: hash,
    parentHashes: [],
    timestamp: Date.now(),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('PendingOps', () => {
  it('持久化待重试操作，并在成功后移除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-pending-'))
    roots.push(root)
    const pending = new PendingOps(root)
    const first = pendingOp('a'.repeat(64))
    const second = pendingOp('b'.repeat(64))

    await pending.add(first)
    await pending.add(second)
    await pending.add(first)

    expect(await pending.list()).toEqual([
      expect.objectContaining({ attempts: 2, op: first }),
      expect.objectContaining({ attempts: 1, op: second }),
    ])

    const applied: string[] = []
    await pending.retryAll(async (op) => {
      applied.push(op.hash)
      return op.hash === first.hash
    })

    expect(applied).toEqual([first.hash, second.hash])
    expect((await pending.list()).map((entry) => entry.op.hash)).toEqual([second.hash])
  })

  it('regression: 首筆重試拋錯時仍會套用並移除後續成功項目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-pending-'))
    roots.push(root)
    const pending = new PendingOps(root)
    const first = pendingOp('a'.repeat(64))
    const second = pendingOp('b'.repeat(64))
    await pending.add(first)
    await pending.add(second)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(pending.retryAll(async (op) => {
      if (op.hash === first.hash) throw new Error('temporary base missing')
      return true
    })).resolves.toBeUndefined()

    expect((await pending.list()).map((entry) => entry.op.hash)).toEqual([first.hash])
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(first.hash.slice(0, 12)),
    )
  })

  it('隔離中間失敗：成功項目移除，失敗項目保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-pending-'))
    roots.push(root)
    const pending = new PendingOps(root)
    const first = pendingOp('a'.repeat(64))
    const middle = pendingOp('b'.repeat(64))
    const last = pendingOp('c'.repeat(64))
    await Promise.all([pending.add(first), pending.add(middle), pending.add(last)])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await pending.retryAll(async (op) => {
      if (op.hash === middle.hash) throw new Error('transient')
      return true
    })

    expect((await pending.list()).map((entry) => entry.op.hash)).toEqual([middle.hash])
  })

  it('全部失敗時保留完整隊列且不產生未處理 rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-pending-'))
    roots.push(root)
    const pending = new PendingOps(root)
    const first = pendingOp('a'.repeat(64))
    const second = pendingOp('b'.repeat(64))
    await Promise.all([pending.add(first), pending.add(second)])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(pending.retryAll(async () => {
      throw new Error('still unavailable')
    })).resolves.toBeUndefined()

    expect((await pending.list()).map((entry) => entry.op.hash).sort()).toEqual([
      first.hash,
      second.hash,
    ])
  })

  it('空隊列是正常 no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-pending-'))
    roots.push(root)
    const pending = new PendingOps(root)
    const apply = vi.fn(async () => true)

    await pending.retryAll(apply)

    expect(apply).not.toHaveBeenCalled()
  })
})
