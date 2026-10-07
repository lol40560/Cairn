import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

import { ensureCairnDataDir } from '../data-dir'
import { computeHash, CURRENT_OP_HASH_VERSION, deriveOpKind, LEGACY_OP_HASH_VERSION } from './hash'
import type { NewOp, Op, OpKind, Oplog, OplogRecoveryReport, OpSource, RemoteOpApplyState } from './types'

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

function isCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_(?:CORRUPT|NOTADB)|database disk image is malformed|file is not a database|quick_check failed/iu.test(message)
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
  private database: Database.Database
  private readonly objectsRoot: string
  private readonly databasePath: string
  private recoveryReport: OplogRecoveryReport | undefined
  private closed = false

  constructor(projectRoot: string) {
    const dataRoot = ensureCairnDataDir(projectRoot)
    this.objectsRoot = join(dataRoot, 'objects')
    this.databasePath = join(dataRoot, 'oplog.db')

    mkdirSync(this.objectsRoot, { recursive: true })
    this.database = this.openOrRecover()
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

  getRecoveryReport(): OplogRecoveryReport | undefined {
    return this.recoveryReport
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

  /** SQLite 索引可由已验证的不可变对象重建；绝不重放历史 filesystem 操作。 */
  private openOrRecover(): Database.Database {
    let database: Database.Database | undefined
    try {
      database = new Database(this.databasePath)
      this.assertHealthyDatabase(database)
      database.exec(CREATE_SCHEMA)
      this.database = database
      this.migrateOpsColumns()
      return database
    } catch (error) {
      try {
        database?.close()
      } catch {
        // 已损坏的数据库可能无法正常关闭；仍保留原始证据。
      }
      if (!isCorruptionError(error)) throw error
      return this.recoverDatabase(error)
    }
  }

  private assertHealthyDatabase(database: Database.Database): void {
    const rows = database.pragma('quick_check') as Array<{ quick_check?: string }>
    if (rows.some((row) => Object.values(row).some((value) => value !== 'ok'))) {
      throw new Error('SQLITE_CORRUPT: PRAGMA quick_check failed')
    }
  }

  private recoverDatabase(trigger: unknown): Database.Database {
    const suffix = `.corrupt-${Date.now()}-${process.pid}`
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) renameSync(path, `${path}${suffix}`)
    }

    const temporaryPath = `${this.databasePath}.recovery-${process.pid}-${Date.now()}.tmp`
    let recovered: Database.Database | undefined
    let recoveredOperations = 0
    let skippedInvalidObjects = 0
    try {
      recovered = new Database(temporaryPath)
      recovered.exec(CREATE_SCHEMA)
      const insert = recovered.prepare(
        `INSERT OR IGNORE INTO ops (hash, id, author, timestamp, file_path, blob_hash, source)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown')`,
      )
      for (const op of this.readRecoverableObjects()) {
        if (!op) {
          skippedInvalidObjects += 1
          continue
        }
        insert.run(op.hash, op.id, op.author, op.timestamp, op.filePath, op.blobHash ?? null)
        recoveredOperations += 1
      }
      this.database = recovered
      this.migrateOpsColumns()
      this.assertHealthyDatabase(recovered)
      recovered.close()
      recovered = undefined
      renameSync(temporaryPath, this.databasePath)
      const opened = new Database(this.databasePath)
      this.database = opened
      this.migrateOpsColumns()
      this.recoveryReport = {
        recoveredOperations,
        skippedInvalidObjects,
        // SQLite-only local provenance cannot be inferred from distributed objects.
        provenanceUnavailable: recoveredOperations,
      }
      console.warn(
        `[cairn:oplog] 数据库恢复完成：恢复操作 ${recoveredOperations}，跳过无效对象 ${skippedInvalidObjects}，来源未知 ${recoveredOperations}`,
      )
      return opened
    } catch (error) {
      try {
        recovered?.close()
      } catch {
        // 保留失败现场即可。
      }
      if (existsSync(temporaryPath)) renameSync(temporaryPath, `${temporaryPath}.failed`)
      const reason = error instanceof Error ? error.message : String(error)
      const original = trigger instanceof Error ? trigger.message : String(trigger)
      throw new Error(`oplog SQLite 恢复失败（原始错误：${original}；恢复错误：${reason}）`, { cause: error })
    }
  }

  private *readRecoverableObjects(): Generator<Op | undefined> {
    for (const prefix of readdirSync(this.objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue
      for (const entry of readdirSync(join(this.objectsRoot, prefix.name), { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue
        try {
          const parsed = JSON.parse(readFileSync(join(this.objectsRoot, prefix.name, entry.name), 'utf8')) as Op
          const hashVersion = parsed.hashVersion ?? LEGACY_OP_HASH_VERSION
          if (parsed.hash !== entry.name || parsed.hash !== computeHash({
            ...parsed,
            hashVersion,
            source: parsed.source === 'unknown' ? undefined : parsed.source,
          })) {
            yield undefined
            continue
          }
          if (!parsed.id || !parsed.author || !Array.isArray(parsed.parentHashes) || typeof parsed.timestamp !== 'number'
            || !parsed.filePath || typeof parsed.diff !== 'string') {
            yield undefined
            continue
          }
          yield { ...parsed, hashVersion, source: 'unknown' }
        } catch {
          yield undefined
        }
      }
    }
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
