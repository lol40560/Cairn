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

export interface PeerInfo {
  peerId: string
  host: string
  port: number
  lastSeen: number
}

export interface LastSession {
  folder: string
  watching: boolean
  updatedAt: number
}

export interface AppSettings {
  autoStartWatching: boolean
  rememberLastFolder: boolean
}

export interface ExportSnapshotResult {
  filePath: string
  fileSize: number
  fileCount: number
  skippedCount: number
}

export interface SeederInfo {
  peerId: string
  snapshotId: string
  projectName: string
  size: number
}

export interface DownloadProgress {
  snapshotId: string
  projectName: string
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  totalBytes: number
  status: 'idle' | 'waiting-meta' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed'
  error?: string
}

export interface DownloadResult {
  targetDir: string
  extractedFiles: number
  conflictFiles: string[]
}

export type ErrorCategory =
  | 'config'
  | 'network'
  | 'permission'
  | 'github'
  | 'conflict'
  | 'notFound'
  | 'unknown'

export interface SerializedError {
  category: ErrorCategory
  message: string
  code?: string
  hintKey?: string
  raw: string
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedError }

export interface CairnApi {
  selectFolder(): Promise<IpcResult<string>>
  startWatching(folder: string): Promise<IpcResult<void>>
  stopWatching(): Promise<IpcResult<void>>
  listRecentOps(limit: number): Promise<IpcResult<Op[]>>
  onOp(callback: (op: Op) => void): () => void
  createRoom(): Promise<IpcResult<string>>
  joinRoom(roomCode: string): Promise<IpcResult<void>>
  leaveRoom(): Promise<IpcResult<void>>
  listPeers(): Promise<IpcResult<PeerInfo[]>>
  onPeers(callback: (peers: PeerInfo[]) => void): () => void
  onConflict(callback: (payload: { op: Op; localContent: string; source: 'remote' }) => void): () => void
  saveGithubConfig(config: { token?: string; owner: string; repo: string }): Promise<IpcResult<void>>
  getGithubConfig(): Promise<IpcResult<{ owner: string; repo: string; hasToken: boolean }>>
  clearGithubConfig(): Promise<IpcResult<void>>
  resetGithubConfig(): Promise<IpcResult<void>>
  exportPR(options: { branch?: string; prBranch?: string; title: string; body?: string }): Promise<IpcResult<{ prUrl: string; prNumber: number }>>
  exportSnapshot(): Promise<IpcResult<ExportSnapshotResult | { canceled: true }>>
  copyToClipboard(text: string): Promise<IpcResult<void>>
  startSharing(): Promise<IpcResult<SeederInfo>>
  stopSharing(): Promise<IpcResult<void>>
  downloadProject(input: { snapshotId: string; targetDir: string }): Promise<IpcResult<DownloadResult>>
  listSeeders(): Promise<IpcResult<SeederInfo[]>>
  getDefaultDownloadDir(): Promise<IpcResult<string>>
  cancelDownload(): Promise<IpcResult<void>>
  selectDownloadFolder(): Promise<IpcResult<string>>
  onDownloadProgress(callback: (progress: DownloadProgress) => void): () => void
  checkFolder(folder: string): Promise<IpcResult<boolean>>
  getLastSession(): Promise<IpcResult<LastSession>>
  clearLastSession(): Promise<IpcResult<void>>
  getSettings(): Promise<IpcResult<AppSettings>>
  updateSettings(partial: Partial<AppSettings>): Promise<IpcResult<void>>
}

declare global {
  interface Window {
    // 必须与 electron/core/oplog/types.ts 的 Op 定义保持一致。
    cairn: CairnApi
  }
}
