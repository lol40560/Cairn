export type OpKind = 'created' | 'deleted' | 'modified'

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
  source?: 'local' | 'remote'
}

export interface Oplog {
  putOp(input: NewOp | Op): Op
  getOp(hash: string): Op | undefined
  hasOp(hash: string): boolean
  walkDag(headHashes: string[]): Op[]
  listRecent(limit: number): Op[]
  listAllHashes(): string[]
  close(): void
}
