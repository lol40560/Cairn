import * as fs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureCairnDataDir } from '../data-dir'
import { computeHash, createOplog, LEGACY_OP_HASH_VERSION } from './index'
import type { NewOp, Op, Oplog } from './types'

const roots: string[] = []
const oplogs: Oplog[] = []

function newOp(overrides: Partial<NewOp> = {}): NewOp {
  return {
    id: 'op-1',
    author: 'alice',
    parentHashes: [],
    timestamp: 1_700_000_000_000,
    filePath: 'src/index.ts',
    diff: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  }
}

async function createFixture(): Promise<{
  projectRoot: string
  oplog: Oplog
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-oplog-'))
  const oplog = createOplog(projectRoot)

  roots.push(projectRoot)
  oplogs.push(oplog)

  return { projectRoot, oplog }
}

async function writeCorruptOp(projectRoot: string, op: Op): Promise<void> {
  const objectPath = join(
    projectRoot,
    '.cairn',
    'objects',
    op.hash.slice(0, 2),
    op.hash,
  )

  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, JSON.stringify(op), 'utf8')

  const database = new Database(join(projectRoot, '.cairn', 'oplog.db'))
  try {
    database
      .prepare(
        `INSERT INTO ops (hash, id, author, timestamp, file_path)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(op.hash, op.id, op.author, op.timestamp, op.filePath)
  } finally {
    database.close()
  }
}

afterEach(async () => {
  for (const oplog of oplogs.splice(0)) {
    oplog.close()
  }

  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('项目数据目录迁移', () => {
  it('仅有 .vibeswarm 时迁移为 .cairn', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-data-dir-'))
    roots.push(projectRoot)
    await mkdir(join(projectRoot, '.vibeswarm'))
    await writeFile(join(projectRoot, '.vibeswarm', 'marker'), 'legacy', 'utf8')

    expect(ensureCairnDataDir(projectRoot)).toBe(join(projectRoot, '.cairn'))
    expect(fs.existsSync(join(projectRoot, '.vibeswarm'))).toBe(false)
    expect(await readFile(join(projectRoot, '.cairn', 'marker'), 'utf8')).toBe('legacy')
  })

  it('仅有 .cairn 时直接保留', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-data-dir-'))
    roots.push(projectRoot)
    await mkdir(join(projectRoot, '.cairn'))
    await writeFile(join(projectRoot, '.cairn', 'marker'), 'current', 'utf8')

    expect(ensureCairnDataDir(projectRoot)).toBe(join(projectRoot, '.cairn'))
    expect(await readFile(join(projectRoot, '.cairn', 'marker'), 'utf8')).toBe('current')
  })

  it('.cairn 与 .vibeswarm 同时存在时不处理旧目录', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-data-dir-'))
    roots.push(projectRoot)
    await mkdir(join(projectRoot, '.cairn'))
    await mkdir(join(projectRoot, '.vibeswarm'))

    expect(ensureCairnDataDir(projectRoot)).toBe(join(projectRoot, '.cairn'))
    expect(fs.existsSync(join(projectRoot, '.vibeswarm'))).toBe(true)
  })

  it('两个目录都不存在时创建 .cairn', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-data-dir-'))
    roots.push(projectRoot)

    expect(ensureCairnDataDir(projectRoot)).toBe(join(projectRoot, '.cairn'))
    expect(fs.existsSync(join(projectRoot, '.cairn'))).toBe(true)
  })

  it('迁移重命名失败时创建新的 .cairn 且不读取旧目录', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-data-dir-'))
    roots.push(projectRoot)
    await mkdir(join(projectRoot, '.vibeswarm'))
    expect(ensureCairnDataDir(projectRoot, {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      renameSync: () => {
        throw new Error('rename failed')
      },
    })).toBe(join(projectRoot, '.cairn'))

    expect(fs.existsSync(join(projectRoot, '.cairn'))).toBe(true)
    expect(fs.existsSync(join(projectRoot, '.vibeswarm'))).toBe(true)
  })
})

describe('oplog', () => {
  it('putOp(NewOp) 后能完整取回 op', async () => {
    const { oplog } = await createFixture()
    const input = newOp()

    const stored = oplog.putOp(input)

    expect(oplog.getOp(stored.hash)).toEqual(stored)
    expect(stored).toMatchObject(input)
  })

  it('putOp 返回 computeHash 计算的 hash', async () => {
    const { oplog } = await createFixture()
    const input = newOp({ parentHashes: ['b', 'a'] })

    const stored = oplog.putOp(input)

    expect(stored.hash).toBe(computeHash(input))
    expect(computeHash(input)).toBe(
      computeHash({ ...input, parentHashes: ['a', 'b'] }),
    )
  })

  it('listAllHashes 按时间升序返回全部 hash', async () => {
    const { oplog } = await createFixture()
    const later = oplog.putOp(newOp({ id: 'later', timestamp: 2 }))
    const earlier = oplog.putOp(newOp({ id: 'earlier', timestamp: 1 }))

    expect(oplog.listAllHashes()).toEqual([earlier.hash, later.hash])
  })

  it('source 不参与 hash 且对象文件不存储 source', async () => {
    const { projectRoot, oplog } = await createFixture()
    const local = oplog.putOp({ ...newOp(), source: 'local' })
    const remote = oplog.putOp({ ...newOp(), source: 'remote' })
    const objectPath = join(
      projectRoot,
      '.cairn',
      'objects',
      local.hash.slice(0, 2),
      local.hash,
    )

    expect(local.hash).toBe(remote.hash)
    expect(local.source).toBe('local')
    expect(remote.source).toBe('remote')
    expect(JSON.parse(await readFile(objectPath, 'utf8'))).not.toHaveProperty('source')
    expect(oplog.getOp(local.hash)?.source).toBeUndefined()
  })

  it('regression: 旧版 v1 对象保持可读，且从 diff 推导类型', async () => {
    const { projectRoot, oplog } = await createFixture()
    const legacyCases = [
      {
        diff: 'new file mode 100644\n--- /dev/null\n+++ created.ts\n+hello\n',
        kind: 'created' as const,
      },
      {
        diff: 'deleted file mode 100644\n--- deleted.ts\n+++ /dev/null\n-old\n',
        kind: 'deleted' as const,
      },
      {
        diff: '@@ -1 +1 @@\n-old\n+new\n',
        kind: 'modified' as const,
      },
    ]

    for (const [index, legacyCase] of legacyCases.entries()) {
      const input = newOp({
        diff: legacyCase.diff,
        filePath: `legacy-${index}.ts`,
        hashVersion: LEGACY_OP_HASH_VERSION,
        id: `legacy-${index}`,
      })
      const hash = computeHash(input)

      // 歷史物件沒有 hashVersion 與 kind；它們仍依 v1 格式驗證與讀取。
      const legacyObject = { ...input }
      delete legacyObject.hashVersion
      await writeCorruptOp(projectRoot, { ...legacyObject, hash })
      expect(oplog.getOp(hash)?.kind).toBe(legacyCase.kind)
    }
  })

  it('v2 hash 对相同语义稳定，且不依赖调用方字段插入顺序', () => {
    const input = newOp()
    const reordered: NewOp = {
      diff: input.diff,
      filePath: input.filePath,
      id: input.id,
      parentHashes: [...input.parentHashes].reverse(),
      timestamp: input.timestamp,
      author: input.author,
    }

    expect(computeHash(reordered)).toBe(computeHash(input))
  })

  it('v2 hash 绑定 kind、baseHash、blobHash 与 size', async () => {
    const { oplog } = await createFixture()
    const input = newOp({ diff: '', filePath: 'assets/logo.png', kind: 'created' })
    const baseHash = 'f'.repeat(64)
    const blobHash = 'a'.repeat(64)

    expect(computeHash({ ...input, kind: 'deleted' })).not.toBe(computeHash(input))
    expect(computeHash({ ...input, baseHash })).not.toBe(computeHash(input))
    expect(computeHash({ ...input, blobHash })).not.toBe(computeHash(input))
    expect(computeHash({ ...input, size: 12 })).not.toBe(computeHash(input))

    const stored = oplog.putOp({ ...input, baseHash, blobHash, size: 12 })

    expect(oplog.getOp(stored.hash)).toMatchObject({ baseHash, blobHash, size: 12 })
    expect(oplog.listBlobs()).toMatchObject([{ hash: stored.hash, blobHash }])
  })

  it('将对象写入正确的内容寻址路径', async () => {
    const { projectRoot, oplog } = await createFixture()
    const stored = oplog.putOp(newOp())
    const objectPath = join(
      projectRoot,
      '.cairn',
      'objects',
      stored.hash.slice(0, 2),
      stored.hash,
    )

    expect(JSON.parse(await readFile(objectPath, 'utf8'))).toEqual(stored)
  })

  it('重复 putOp 时幂等且不改写对象文件', async () => {
    const { projectRoot, oplog } = await createFixture()
    const input = newOp()
    const first = oplog.putOp(input)
    const objectPath = join(
      projectRoot,
      '.cairn',
      'objects',
      first.hash.slice(0, 2),
      first.hash,
    )
    const before = await stat(objectPath, { bigint: true })
    const beforeContent = await readFile(objectPath, 'utf8')

    const second = oplog.putOp(input)
    const after = await stat(objectPath, { bigint: true })

    expect(second).toEqual(first)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(await readFile(objectPath, 'utf8')).toBe(beforeContent)
  })

  it('putOp(Op) 在 hash 与内容不符时拒绝写入', async () => {
    const { oplog } = await createFixture()
    const invalid: Op = {
      ...newOp(),
      hash: '0'.repeat(64),
    }

    expect(() => oplog.putOp(invalid)).toThrow(/hash 校验失败/)
  })

  it('hasOp 只对已存在的 hash 返回 true', async () => {
    const { oplog } = await createFixture()
    const stored = oplog.putOp(newOp())

    expect(oplog.hasOp(stored.hash)).toBe(true)
    expect(oplog.hasOp('f'.repeat(64))).toBe(false)
  })

  it('durably tracks a received remote op until it is explicitly marked applied', async () => {
    const { projectRoot, oplog } = await createFixture()
    const received = oplog.putReceivedRemoteOp(newOp({ id: 'remote-durable' }))
    const targetHash = 'a'.repeat(64)

    expect(oplog.hasReceivedOp(received.hash)).toBe(true)
    expect(oplog.getRemoteOpApplyState(received.hash)).toBe('received')
    expect(oplog.listUnappliedRemoteOps()).toEqual([{ ...received, source: 'remote' }])
    oplog.setRemoteOpTargetContentHash(received.hash, targetHash)
    oplog.close()

    const reopened = createOplog(projectRoot)
    oplogs.push(reopened)
    expect(reopened.getRemoteOpApplyState(received.hash)).toBe('received')
    expect(reopened.getRemoteOpTargetContentHash(received.hash)).toBe(targetHash)
    reopened.markRemoteOpApplied(received.hash)
    expect(reopened.getRemoteOpApplyState(received.hash)).toBe('applied')
    expect(reopened.listUnappliedRemoteOps()).toEqual([])
  })

  it('regression: v2 remote apply state remains attached to its v2 object after restart', async () => {
    const { projectRoot, oplog } = await createFixture()
    const received = oplog.putReceivedRemoteOp(newOp({
      baseHash: 'a'.repeat(64),
      kind: 'modified',
    }))

    expect(received.hashVersion).toBe(2)
    expect(oplog.getRemoteOpApplyState(received.hash)).toBe('received')
    oplog.close()

    const reopened = createOplog(projectRoot)
    oplogs.push(reopened)
    expect(reopened.getOp(received.hash)).toMatchObject({ hashVersion: 2 })
    expect(reopened.getRemoteOpApplyState(received.hash)).toBe('received')
  })

  it('migration: treats pre-apply-state historical operations as legacy complete', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-oplog-legacy-'))
    roots.push(projectRoot)
    const input = newOp({ id: 'legacy-complete', hashVersion: LEGACY_OP_HASH_VERSION })
    const hash = computeHash(input)
    const objectPath = join(projectRoot, '.cairn', 'objects', hash.slice(0, 2), hash)
    await mkdir(dirname(objectPath), { recursive: true })
    const legacyObject = { ...input }
    delete legacyObject.hashVersion
    await writeFile(objectPath, JSON.stringify({ ...legacyObject, hash }), 'utf8')
    const legacy = new Database(join(projectRoot, '.cairn', 'oplog.db'))
    try {
      legacy.exec(`CREATE TABLE ops (
        hash TEXT PRIMARY KEY, id TEXT NOT NULL, author TEXT NOT NULL,
        timestamp INTEGER NOT NULL, file_path TEXT NOT NULL
      )`)
      legacy.prepare('INSERT INTO ops (hash, id, author, timestamp, file_path) VALUES (?, ?, ?, ?, ?)')
        .run(hash, input.id, input.author, input.timestamp, input.filePath)
    } finally {
      legacy.close()
    }

    const migrated = createOplog(projectRoot)
    oplogs.push(migrated)
    expect(migrated.getOp(hash)).toMatchObject({ id: input.id })
    expect(migrated.getRemoteOpApplyState(hash)).toBeUndefined()
    expect(migrated.listUnappliedRemoteOps()).toEqual([])
  })

  it('按父先子后顺序遍历三节点 DAG', async () => {
    const { oplog } = await createFixture()
    const a = oplog.putOp(newOp({ id: 'A', timestamp: 1 }))
    const b = oplog.putOp(
      newOp({ id: 'B', parentHashes: [a.hash], timestamp: 2 }),
    )
    const c = oplog.putOp(
      newOp({ id: 'C', parentHashes: [b.hash], timestamp: 3 }),
    )

    expect(oplog.walkDag([c.hash]).map((op) => op.id)).toEqual(['A', 'B', 'C'])
  })

  it('多个 head 共享父节点时只返回一次', async () => {
    const { oplog } = await createFixture()
    const parent = oplog.putOp(newOp({ id: 'parent', timestamp: 1 }))
    const left = oplog.putOp(
      newOp({ id: 'left', parentHashes: [parent.hash], timestamp: 2 }),
    )
    const right = oplog.putOp(
      newOp({ id: 'right', parentHashes: [parent.hash], timestamp: 3 }),
    )

    const ids = oplog.walkDag([left.hash, right.hash]).map((op) => op.id)

    expect(ids.filter((id) => id === 'parent')).toHaveLength(1)
    expect(new Set(ids)).toEqual(new Set(['parent', 'left', 'right']))
  })

  it('遍历缺失父节点时错误包含 hash 和路径', async () => {
    const { projectRoot, oplog } = await createFixture()
    const headHash = 'c'.repeat(64)
    const missingHash = 'f'.repeat(64)

    await writeCorruptOp(projectRoot, {
      ...newOp({ id: 'corrupt', parentHashes: [missingHash] }),
      hash: headHash,
    })

    expect(() => oplog.walkDag([headHash])).toThrow(
      new RegExp(`${missingHash}.*${headHash} -> ${missingHash}`),
    )
  })

  it('人为环会报告环上的 hash', async () => {
    const { projectRoot, oplog } = await createFixture()
    const aHash = 'a'.repeat(64)
    const bHash = 'b'.repeat(64)

    await writeCorruptOp(projectRoot, {
      ...newOp({ id: 'A', parentHashes: [bHash] }),
      hash: aHash,
    })
    await writeCorruptOp(projectRoot, {
      ...newOp({ id: 'B', parentHashes: [aHash] }),
      hash: bHash,
    })

    expect(() => oplog.walkDag([aHash])).toThrow(
      new RegExp(`${aHash} -> ${bHash} -> ${aHash}`),
    )
  })

  it('listRecent 只返回最近的指定数量并按时间降序', async () => {
    const { oplog } = await createFixture()

    for (let index = 1; index <= 5; index += 1) {
      oplog.putOp(newOp({ id: `op-${index}`, timestamp: index }))
    }

    expect(oplog.listRecent(3).map((op) => op.id)).toEqual([
      'op-5',
      'op-4',
      'op-3',
    ])
  })

  it('listRecent 拒绝超出 1..200 的 limit', async () => {
    const { oplog } = await createFixture()

    expect(() => oplog.listRecent(0)).toThrow(/1\.\.200/)
    expect(() => oplog.listRecent(201)).toThrow(/1\.\.200/)
  })

  it('close 可重入，且关闭后 putOp 抛错', async () => {
    const { oplog } = await createFixture()

    oplog.close()
    expect(() => oplog.close()).not.toThrow()
    expect(() => oplog.putOp(newOp())).toThrow(/oplog 已关闭/)
  })
})
