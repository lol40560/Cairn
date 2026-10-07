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
import { computeHash, CURRENT_OP_HASH_VERSION, deriveOpKind, LEGACY_OP_HASH_VERSION } from './hash'
import type { NewOp, Op, OpKind, Oplog, OpSource, RemoteOpApplyState } from './types'

interface HashRow {
  hash: string
}

interface OpIndexRow extends HashRow {
  source: OpSource | null
}

interface RemoteApplyRow {
  state: RemoteOpApplyState
  target_content_hash: string | null
}

type StoredOp = Omit<Op, 'source'>

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (
    hash TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    blob_hash TEXT,
    source TEXT CHECK (source IN ('local', 'remote', 'unknown') OR source IS NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON ops(timestamp DESC);
  CREATE TABLE IF NOT EXISTS remote_op_apply (
    hash TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('received', 'applied', 'rejected')),
    target_content_hash TEXT,
    FOREIGN KEY (hash) REFERENCES ops(hash)
  );
  CREATE INDEX IF NOT EXISTS idx_remote_op_apply_state ON remote_op_apply(state);
`

function canonicalize(input: NewOp | Op): NewOp {
  return {
    id: input.id,
    author: input.author,
    parentHashes: [...input.parentHashes].sort(),
    timestamp: input.timestamp,
    filePath: input.filePath,
    diff: input.diff,
    // v2 將 kind 納入 identity；省略時以既有 diff 規則推導成穩定語義。
    kind: input.kind ?? deriveOpKind(input.diff),
    baseHash: input.baseHash,
    blobHash: input.blobHash,
    size: input.size,
    contentEncoding: input.contentEncoding,
    // 已帶 hash 的未標記物件必然是歷史 v1；新的 NewOp 預設寫入 v2。
    hashVersion: isStoredOp(input)
      ? input.hashVersion ?? LEGACY_OP_HASH_VERSION
      : input.hashVersion ?? CURRENT_OP_HASH_VERSION,
    source: input.source === 'unknown' ? undefined : input.source,
  }
}

/** 为旧版对象补齐仅用于显示的变更类型。 */
function inferKind(diff: string): OpKind {
  return deriveOpKind(diff)
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
    this.migrateOpsColumns()
  }

  putOp(input: NewOp | Op): Op {
    this.assertOpen('putOp')
    return this.storeOp(input, false)
  }

  putReceivedRemoteOp(input: NewOp | Op): Op {
    this.assertOpen('putReceivedRemoteOp')
    return this.storeOp({ ...input, source: 'remote' }, true)
  }

  getOp(hash: string): Op | undefined {
    this.assertOpen('getOp')

    const indexed = this.database
      .prepare('SELECT hash, source FROM ops WHERE hash = ?')
      .get(hash) as OpIndexRow | undefined

    if (!indexed) {
      return undefined
    }

    return this.readObject(hash, indexed.source ?? 'unknown')
  }

  hasReceivedOp(hash: string): boolean {
    this.assertOpen('hasReceivedOp')

    return Boolean(
      this.database.prepare('SELECT 1 FROM ops WHERE hash = ?').get(hash),
    )
  }

  hasOp(hash: string): boolean {
    return this.hasReceivedOp(hash)
  }

  getRemoteOpApplyState(hash: string): RemoteOpApplyState | undefined {
    this.assertOpen('getRemoteOpApplyState')
    const row = this.database
      .prepare('SELECT state FROM remote_op_apply WHERE hash = ?')
      .get(hash) as Pick<RemoteApplyRow, 'state'> | undefined
    return row?.state
  }

  listUnappliedRemoteOps(): Op[] {
    this.assertOpen('listUnappliedRemoteOps')
    const rows = this.database
      .prepare(
        `SELECT ops.hash FROM remote_op_apply
         INNER JOIN ops ON ops.hash = remote_op_apply.hash
         WHERE remote_op_apply.state = 'received'
         ORDER BY ops.timestamp ASC, ops.hash ASC`,
      )
      .all() as HashRow[]
    return rows.map(({ hash }) => this.readObject(hash, 'remote'))
  }

  setRemoteOpTargetContentHash(hash: string, targetContentHash: string): void {
    this.assertOpen('setRemoteOpTargetContentHash')
    if (!/^[a-f0-9]{64}$/u.test(targetContentHash)) {
      throw new Error(`远端操作目标内容 hash 无效：${targetContentHash}`)
    }
    const result = this.database
      .prepare(
        `UPDATE remote_op_apply
         SET target_content_hash = ?
         WHERE hash = ? AND state = 'received'`,
      )
      .run(targetContentHash, hash)
    if (result.changes !== 1) {
      throw new Error(`无法为未完成远端操作保存目标内容：${hash}`)
    }
  }

  getRemoteOpTargetContentHash(hash: string): string | undefined {
    this.assertOpen('getRemoteOpTargetContentHash')
    const row = this.database
      .prepare('SELECT target_content_hash FROM remote_op_apply WHERE hash = ?')
      .get(hash) as Pick<RemoteApplyRow, 'target_content_hash'> | undefined
    return row?.target_content_hash ?? undefined
  }

  markRemoteOpApplied(hash: string): void {
    this.assertOpen('markRemoteOpApplied')
    const result = this.database
      .prepare("UPDATE remote_op_apply SET state = 'applied' WHERE hash = ? AND state = 'received'")
      .run(hash)
    if (result.changes === 0 && this.getRemoteOpApplyState(hash) !== 'applied') {
      throw new Error(`无法将远端操作标记为已应用：${hash}`)
    }
  }

  markRemoteOpRejected(hash: string): void {
    this.assertOpen('markRemoteOpRejected')
    const result = this.database
      .prepare("UPDATE remote_op_apply SET state = 'rejected' WHERE hash = ? AND state = 'received'")
      .run(hash)
    if (result.changes === 0 && this.getRemoteOpApplyState(hash) !== 'rejected') {
      throw new Error(`无法将远端操作标记为已拒绝：${hash}`)
    }
  }

  private storeOp(input: NewOp | Op, receivedRemotely: boolean): Op {

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
      kind: canonicalInput.kind,
      source: receivedRemotely ? 'remote' : canonicalInput.source ?? 'local',
    }
    const objectPath = this.objectPath(op.hash)

    if (!existsSync(objectPath)) {
      this.writeObjectAtomically(objectPath, op)
    }

    const persist = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO ops (hash, id, author, timestamp, file_path, blob_hash, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(op.hash, op.id, op.author, op.timestamp, op.filePath, op.blobHash ?? null, receivedRemotely ? 'remote' : op.source ?? 'local')
      if (receivedRemotely) {
        this.database
          .prepare("INSERT OR IGNORE INTO remote_op_apply (hash, state) VALUES (?, 'received')")
          .run(op.hash)
      }
    })
    persist()

    return op
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
        `SELECT hash, source FROM ops
         ORDER BY timestamp DESC, hash ASC
         LIMIT ?`,
      )
      .all(limit) as OpIndexRow[]

    return rows.map(({ hash, source }) => this.readObject(hash, source ?? 'unknown'))
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
      .prepare('SELECT hash, source FROM ops WHERE blob_hash IS NOT NULL ORDER BY timestamp ASC, hash ASC')
      .all() as OpIndexRow[]

    return rows.map(({ hash, source }) => this.readObject(hash, source ?? 'unknown'))
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

  private migrateOpsColumns(): void {
    try {
      this.database.exec('ALTER TABLE ops ADD COLUMN blob_hash TEXT')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('duplicate column name')) throw error
    }
    try {
      this.database.exec("ALTER TABLE ops ADD COLUMN source TEXT CHECK (source IN ('local', 'remote', 'unknown') OR source IS NULL)")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('duplicate column name')) throw error
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_ops_blob_hash ON ops(blob_hash)')
  }

  private readObject(hash: string, source: OpSource = 'unknown'): Op {
    const objectPath = this.objectPath(hash)

    try {
      const op = JSON.parse(readFileSync(objectPath, 'utf8')) as Op
      return { ...(op.kind ? op : { ...op, kind: inferKind(op.diff) }), source }
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
        contentEncoding: op.contentEncoding,
        diff: op.diff,
        filePath: op.filePath,
        hash: op.hash,
        hashVersion: op.hashVersion,
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
