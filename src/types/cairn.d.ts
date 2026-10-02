export interface Op {
  id: string
  hash: string
  author: string
  parentHashes: string[]
  timestamp: number
  filePath: string
  diff: string
  /** 必须与 electron/core/oplog/types.ts 的 OpKind 保持一致。 */
  kind?: 'created' | 'deleted' | 'modified'
  baseHash?: string
  source?: 'local' | 'remote'
}

export interface PeerInfo {
  peerId: string
  host: string
  port: number
  lastSeen: number
}

export interface LocalEndpoint {
  host: string
  port: number
}

export interface LastSession {
  folder: string
  watching: boolean
  updatedAt: number
}

export interface ProjectEntry {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  isFavorite: boolean
}

export interface AvailableProjectEntry extends ProjectEntry {
  available: boolean
}

export interface OnboardingState {
  completed: boolean
  completedAt?: number
}

export interface AppSettings {
  autoStartWatching: boolean
  rememberLastFolder: boolean
  trashRetentionDays: number
}

export interface TrashEntry {
  trashId: string
  originalPath: string
  deletedAt: number
  author: string
  opHash: string
  sizeBytes: number
}

export interface ConflictRecord {
  filePath: string
  opHash: string
  author: string
  timestamp: number
  baseContent?: string
  localContent: string
  remoteContent?: string
  mergedWithMarkers?: string
}

export type ConflictResolution = 'local' | 'remote' | 'merged'

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

export interface DiscoveryStatus {
  published: boolean
  browsing: boolean
  publishedName: string | undefined
  error: string | undefined
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
  getLocalEndpoint(): Promise<IpcResult<LocalEndpoint | undefined>>
  connectToAddress(input: LocalEndpoint & { roomCode: string }): Promise<IpcResult<void>>
  getDiscoveryStatus(): Promise<IpcResult<DiscoveryStatus>>
  onPeers(callback: (peers: PeerInfo[]) => void): () => void
  onConflict(callback: (payload: { op: Op; localContent: string; source: 'remote' }) => void): () => void
  saveGithubConfig(config: { token?: string; owner: string; repo: string }): Promise<IpcResult<void>>
  getGithubConfig(): Promise<IpcResult<{ owner: string; repo: string; hasToken: boolean }>>
  clearGithubConfig(): Promise<IpcResult<void>>
  resetGithubConfig(): Promise<IpcResult<void>>
  exportPR(options: { branch?: string; prBranch?: string; title: string; body?: string }): Promise<IpcResult<{ prUrl: string; prNumber: number }>>
  exportSnapshot(): Promise<IpcResult<ExportSnapshotResult | { canceled: true }>>
  copyToClipboard(text: string): Promise<IpcResult<void>>
  openExternal(url: string): Promise<IpcResult<void>>
  openInFileManager(targetPath: string): Promise<IpcResult<void>>
  startSharing(): Promise<IpcResult<SeederInfo>>
  stopSharing(): Promise<IpcResult<void>>
  downloadProject(input: { snapshotId: string; targetDir: string }): Promise<IpcResult<DownloadResult>>
  listSeeders(): Promise<IpcResult<SeederInfo[]>>
  getDefaultDownloadDir(): Promise<IpcResult<string>>
  cancelDownload(): Promise<IpcResult<void>>
  selectDownloadFolder(): Promise<IpcResult<string>>
  onDownloadProgress(callback: (progress: DownloadProgress) => void): () => void
  checkFolder(folder: string): Promise<IpcResult<boolean>>
  listProjects(): Promise<IpcResult<AvailableProjectEntry[]>>
  addProject(projectPath: string): Promise<IpcResult<ProjectEntry>>
  removeProject(id: string): Promise<IpcResult<void>>
  setActiveProject(id: string): Promise<IpcResult<void>>
  getActiveProject(): Promise<IpcResult<ProjectEntry | undefined>>
  checkProjectAvailability(id: string): Promise<IpcResult<boolean>>
  getLastSession(): Promise<IpcResult<LastSession>>
  clearLastSession(): Promise<IpcResult<void>>
  getOnboardingState(): Promise<IpcResult<OnboardingState>>
  completeOnboarding(): Promise<IpcResult<void>>
  resetOnboarding(): Promise<IpcResult<void>>
  getSettings(): Promise<IpcResult<AppSettings>>
  updateSettings(partial: Partial<AppSettings>): Promise<IpcResult<void>>
  listTrash(): Promise<IpcResult<TrashEntry[]>>
  restoreFromTrash(trashId: string): Promise<IpcResult<void>>
  purgeFromTrash(trashId: string): Promise<IpcResult<void>>
  emptyTrash(): Promise<IpcResult<void>>
  getTrashRetentionDays(): Promise<IpcResult<number>>
  setTrashRetentionDays(days: number): Promise<IpcResult<void>>
  listConflicts(): Promise<IpcResult<ConflictRecord[]>>
  getConflict(opHash: string): Promise<IpcResult<ConflictRecord | undefined>>
  resolveConflict(opHash: string, resolution: ConflictResolution, content?: string): Promise<IpcResult<void>>
  deleteConflict(opHash: string): Promise<IpcResult<void>>
}

declare global {
  interface Window {
    // 必须与 electron/core/oplog/types.ts 的 Op 定义保持一致。
    cairn: CairnApi
  }
}
