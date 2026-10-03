import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

import { ensureCairnDataDir } from '../data-dir'
import { computeHash } from './hash'
import type { NewOp, Op, OpKind, Oplog } from './types'

interface HashRow {
  hash: string
}

type StoredOp = Omit<Op, 'source'>

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (
    hash TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    blob_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON ops(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_ops_blob_hash ON ops(blob_hash);
`

function canonicalize(input: NewOp): NewOp {
  return {
    id: input.id,
    author: input.author,
    parentHashes: [...input.parentHashes].sort(),
    timestamp: input.timestamp,
    filePath: input.filePath,
    diff: input.diff,
    kind: input.kind,
    baseHash: input.baseHash,
    blobHash: input.blobHash,
    size: input.size,
    source: input.source,
  }
}

/** 为旧版对象补齐仅用于显示的变更类型。 */
function inferKind(diff: string): OpKind {
  if (diff.includes('--- /dev/null') || diff.includes('new file mode')) {
    return 'created'
  }
  if (diff.includes('+++ /dev/null') || diff.includes('deleted file mode')) {
    return 'deleted'
  }
  return 'modified'
}

function isStoredOp(input: NewOp | Op): input is Op {
  return 'hash' in input
}

class SqliteOplog implements Oplog {
  private readonly database: Database.Database
  private readonly objectsRoot: string
  private closed = false

  constructor(projectRoot: string) {
    const dataRoot = ensureCairnDataDir(projectRoot)
    this.objectsRoot = join(dataRoot, 'objects')

    mkdirSync(this.objectsRoot, { recursive: true })
    this.database = new Database(join(dataRoot, 'oplog.db'))
    this.database.exec(CREATE_SCHEMA)
    this.migrateBlobHashColumn()
  }

  putOp(input: NewOp | Op): Op {
    this.assertOpen('putOp')

    const canonicalInput = canonicalize(input)
    const computedHash = computeHash(canonicalInput)

    if (isStoredOp(input) && input.hash !== computedHash) {
      throw new Error(
        `op hash 校验失败：传入 ${input.hash}，计算得到 ${computedHash}`,
      )
    }

    const op: Op = {
      ...canonicalInput,
      hash: computedHash,
      // 旧调用方没有显式提供时，也为新对象持久化可展示的类型。
      kind: canonicalInput.kind ?? inferKind(canonicalInput.diff),
    }
    const objectPath = this.objectPath(op.hash)

    if (!existsSync(objectPath)) {
      this.writeObjectAtomically(objectPath, op)
    }

    this.database
      .prepare(
        `INSERT OR IGNORE INTO ops (hash, id, author, timestamp, file_path, blob_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(op.hash, op.id, op.author, op.timestamp, op.filePath, op.blobHash ?? null)

    return op
  }

  getOp(hash: string): Op | undefined {
    this.assertOpen('getOp')

    const indexed = this.database
      .prepare('SELECT hash FROM ops WHERE hash = ?')
      .get(hash) as HashRow | undefined

    if (!indexed) {
      return undefined
    }

    return this.readObject(hash)
  }

  hasOp(hash: string): boolean {
    this.assertOpen('hasOp')

    return Boolean(
      this.database.prepare('SELECT 1 FROM ops WHERE hash = ?').get(hash),
    )
  }

  walkDag(headHashes: string[]): Op[] {
    this.assertOpen('walkDag')

    const visitState = new Map<string, 'visiting' | 'visited'>()
    const result: Op[] = []
    const path: string[] = []

    const visit = (hash: string): void => {
      const state = visitState.get(hash)

      if (state === 'visited') {
        return
      }

      if (state === 'visiting') {
        const cycleStart = path.indexOf(hash)
        const cycle = [...path.slice(cycleStart), hash]
        throw new Error(`op DAG 检测到环：${cycle.join(' -> ')}`)
      }

      const op = this.getOp(hash)
      if (!op) {
        const traversalPath = [...path, hash]
        throw new Error(
          `op DAG 缺失 hash ${hash}，遍历路径：${traversalPath.join(' -> ')}`,
        )
      }

      visitState.set(hash, 'visiting')
      path.push(hash)

      for (const parentHash of [...op.parentHashes].sort()) {
        visit(parentHash)
      }

      path.pop()
      visitState.set(hash, 'visited')
      result.push(op)
    }

    for (const headHash of [...new Set(headHashes)].sort()) {
      visit(headHash)
    }

    return result
  }

  listRecent(limit: number): Op[] {
    this.assertOpen('listRecent')

    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error(`listRecent limit 必须是 1..200 的整数，收到 ${limit}`)
    }

    const rows = this.database
      .prepare(
        `SELECT hash FROM ops
         ORDER BY timestamp DESC, hash ASC
         LIMIT ?`,
      )
      .all(limit) as HashRow[]

    return rows.map(({ hash }) => this.readObject(hash))
  }

  listAllHashes(): string[] {
    this.assertOpen('listAllHashes')

    const rows = this.database
      .prepare('SELECT hash FROM ops ORDER BY timestamp ASC, hash ASC')
      .all() as HashRow[]

    return rows.map(({ hash }) => hash)
  }

  listBlobs(): Op[] {
    this.assertOpen('listBlobs')

    const rows = this.database
      .prepare('SELECT hash FROM ops WHERE blob_hash IS NOT NULL ORDER BY timestamp ASC, hash ASC')
      .all() as HashRow[]

    return rows.map(({ hash }) => this.readObject(hash))
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.database.close()
    this.closed = true
  }

  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new Error(`oplog 已关闭，无法执行 ${operation}`)
    }
  }

  private objectPath(hash: string): string {
    return join(this.objectsRoot, hash.slice(0, 2), hash)
  }

  private migrateBlobHashColumn(): void {
    try {
      this.database.exec('ALTER TABLE ops ADD COLUMN blob_hash TEXT')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('duplicate column name')) throw error
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_ops_blob_hash ON ops(blob_hash)')
  }

  private readObject(hash: string): Op {
    const objectPath = this.objectPath(hash)

    try {
      const op = JSON.parse(readFileSync(objectPath, 'utf8')) as Op
      return op.kind ? op : { ...op, kind: inferKind(op.diff) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `无法读取 op 对象 ${hash}（${objectPath}）：${reason}`,
        { cause: error },
      )
    }
  }

  private writeObjectAtomically(objectPath: string, op: Op): void {
    mkdirSync(dirname(objectPath), { recursive: true })

    const temporaryPath = `${objectPath}.tmp`
    const descriptor = openSync(temporaryPath, 'w')

    try {
      const storedOp: StoredOp = {
        author: op.author,
        baseHash: op.baseHash,
        blobHash: op.blobHash,
        diff: op.diff,
        filePath: op.filePath,
        hash: op.hash,
        id: op.id,
        kind: op.kind,
        parentHashes: op.parentHashes,
        size: op.size,
        timestamp: op.timestamp,
      }
      writeFileSync(descriptor, JSON.stringify(storedOp), 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }

    renameSync(temporaryPath, objectPath)
  }
}

export function createOplog(projectRoot: string): Oplog {
  return new SqliteOplog(projectRoot)
}
