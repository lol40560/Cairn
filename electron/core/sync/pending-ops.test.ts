import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
})
