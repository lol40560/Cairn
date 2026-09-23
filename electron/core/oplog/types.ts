export interface Op {
  id: string
  hash: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  source?: 'local' | 'remote'
}

export interface NewOp {
  id: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
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
