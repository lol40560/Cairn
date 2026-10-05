export type OpKind = 'created' | 'deleted' | 'modified'
export type RemoteOpApplyState = 'received' | 'applied' | 'rejected'

export interface Op {
  id: string
  hash: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  /** 由文件变更方向推导，用于界面展示且不参与 hash。 */
  kind?: OpKind
  /** 生成此 diff 时文件旧内容的 SHA-256，不参与 op hash。 */
  baseHash?: string
  /** 二進制檔案內容的 SHA-256，不參與 op hash。 */
  blobHash?: string
  /** 二進制檔案的位元組大小，不參與 op hash。 */
  size?: number
  source?: 'local' | 'remote'
}

export interface NewOp {
  id: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  /** 新写入的操作会携带类型，旧操作保持兼容。 */
  kind?: OpKind
  /** 生成此 diff 时文件旧内容的 SHA-256，不参与 op hash。 */
  baseHash?: string
  /** 二進制檔案內容的 SHA-256，不參與 op hash。 */
  blobHash?: string
  /** 二進制檔案的位元組大小，不參與 op hash。 */
  size?: number
  source?: 'local' | 'remote'
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
