export type OpKind = 'created' | 'deleted' | 'modified'
/** 來源是接收端本機 metadata，不屬於分散式 operation identity。 */
export type OpSource = 'local' | 'remote' | 'unknown'
/**
 * 操作物件的雜湊格式版本。未標記的歷史物件一律視為 v1，
 * 避免在升級後重新解讀既有物件名稱或 SQLite 索引。
 */
export type OpHashVersion = 1 | 2 | 3
export type RemoteOpApplyState = 'received' | 'applied' | 'rejected'

export interface Op {
  id: string
  hash: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  /** 未標記表示歷史 v1；新建立的操作使用 v2。 */
  hashVersion?: OpHashVersion
  /** 由文件变更方向推导，并参与 v2 hash。 */
  kind?: OpKind
  /** 生成此 diff 时文件旧内容的 SHA-256，并参与 v2 hash。 */
  baseHash?: string
  /** 二進制檔案內容的 SHA-256，並参与 v2 hash。 */
  blobHash?: string
  /** 二進制檔案的位元組大小，並参与 v2 hash。 */
  size?: number
  /** 大型文字檔以完整 UTF-8 blob 傳輸；參與 v3 hash。 */
  contentEncoding?: 'full-text-blob'
  /** 本機來源標記，絕不參與分散式操作 identity。 */
  source?: OpSource
}

export interface NewOp {
  id: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  /** 若未指定，Oplog 在建立新操作時會使用目前版本。 */
  hashVersion?: OpHashVersion
  /** 新写入的操作会携带类型，旧操作保持兼容。 */
  kind?: OpKind
  /** 生成此 diff 时文件旧内容的 SHA-256，并参与 v2 hash。 */
  baseHash?: string
  /** 二進制檔案內容的 SHA-256，並参与 v2 hash。 */
  blobHash?: string
  /** 二進制檔案的位元組大小，並参与 v2 hash。 */
  size?: number
  /** 大型文字檔以完整 UTF-8 blob 傳輸；參與 v3 hash。 */
  contentEncoding?: 'full-text-blob'
  source?: Exclude<OpSource, 'unknown'>
}

export interface Oplog {
  putOp(input: NewOp | Op): Op
  /** 持久化远端操作及其“尚未 materialize”的 apply intent。 */
  putReceivedRemoteOp(input: NewOp | Op): Op
  getOp(hash: string): Op | undefined
  /** 操作对象是否已被本机持久化；不等同于远端操作已落盘。 */
  hasReceivedOp(hash: string): boolean
  /** @deprecated 请使用 hasReceivedOp 或 getRemoteOpApplyState 明确表达语义。 */
  hasOp(hash: string): boolean
  getRemoteOpApplyState(hash: string): RemoteOpApplyState | undefined
  listUnappliedRemoteOps(): Op[]
  setRemoteOpTargetContentHash(hash: string, contentHash: string): void
  getRemoteOpTargetContentHash(hash: string): string | undefined
  markRemoteOpApplied(hash: string): void
  markRemoteOpRejected(hash: string): void
  walkDag(headHashes: string[]): Op[]
  listRecent(limit: number): Op[]
  listAllHashes(): string[]
  listBlobs(): Op[]
  close(): void
}
