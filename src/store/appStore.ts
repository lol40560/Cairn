import { create } from 'zustand'

import { detectLocale, persistLocale, type Locale } from '../i18n/locales'
import type { AvailableProjectEntry, ConflictRecord, IdentityMismatch, LocalEndpoint, Op, PeerInfo, PeerState, ProjectFileEntry, SeederInfo, TrashEntry } from '../types/cairn'

export type WatchStatus = 'idle' | 'watching' | 'stopped'
export type ViewType = 'home' | 'activity' | 'files' | 'room' | 'conflicts' | 'trash'
export type ActiveView = ViewType
export type DownloadStatus = 'idle' | 'waiting-meta' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed'

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  receivedChunks: number
  totalChunks: number
}

export interface AppState {
  folder: string
  activeView: ActiveView
  projects: AvailableProjectEntry[]
  projectFiles: ProjectFileEntry[]
  selectedFilePath: string | undefined
  fileFilter: string
  locale: Locale
  status: WatchStatus
  ops: Op[]
  roomCode: string
  peers: PeerInfo[]
  isHost: boolean
  directAddress: string | undefined
  localEndpoint: LocalEndpoint | undefined
  seeders: SeederInfo[]
  isSharing: boolean
  mySnapshotId: string | undefined
  downloadStatus: DownloadStatus
  downloadProgress: DownloadProgress | undefined
  downloadTargetDir: string
  pendingAutoDownload: boolean
  showDownloadPrompt: boolean
  lastDownloadPath: string | undefined
  lastConflictFiles: string[]
  trash: TrashEntry[]
  conflicts: ConflictRecord[]
  identityMismatches: IdentityMismatch[]
  peerStatuses: Record<string, PeerState>
  githubConfigured: boolean
  sidebarCollapsed: boolean
  setFolder(folder: string): void
  setActiveView(view: ActiveView): void
  setProjects(projects: AvailableProjectEntry[]): void
  setProjectFiles(files: ProjectFileEntry[]): void
  setSelectedFilePath(path: string | undefined): void
  setFileFilter(filter: string): void
  setLocale(locale: Locale): void
  setStatus(status: WatchStatus): void
  setRoomCode(code: string): void
  setPeers(peers: PeerInfo[]): void
  setIsHost(isHost: boolean): void
  setDirectAddress(address: string | undefined): void
  setLocalEndpoint(endpoint: LocalEndpoint | undefined): void
  setSeeders(seeders: SeederInfo[]): void
  setIsSharing(isSharing: boolean): void
  setMySnapshotId(id: string | undefined): void
  setDownloadStatus(status: DownloadStatus): void
  setDownloadProgress(progress: DownloadProgress | undefined): void
  setDownloadTargetDir(directory: string): void
  setPendingAutoDownload(value: boolean): void
  setShowDownloadPrompt(value: boolean): void
  resetDownload(): void
  setLastDownloadResult(path: string, conflicts: string[]): void
  clearLastDownloadResult(): void
  setTrash(trash: TrashEntry[]): void
  setConflicts(conflicts: ConflictRecord[]): void
  addConflict(conflict: ConflictRecord): void
  removeConflict(opHash: string): void
  clearConflicts(): void
  addIdentityMismatch(info: IdentityMismatch): void
  clearIdentityMismatches(): void
  setPeerStatus(state: PeerState): void
  clearPeerStatuses(): void
  setGithubConfigured(value: boolean): void
  setSidebarCollapsed(collapsed: boolean): void
  replaceOps(ops: Op[]): void
  prependOp(op: Op): void
}

function readSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem('cairn.sidebarCollapsed') === 'true'
  } catch {
    return false
  }
}

export const useAppStore = create<AppState>((set) => ({
  folder: '',
  activeView: 'activity',
  projects: [],
  projectFiles: [],
  selectedFilePath: undefined,
  fileFilter: '',
  locale: detectLocale(),
  status: 'idle',
  ops: [],
  roomCode: '',
  peers: [],
  isHost: false,
  directAddress: undefined,
  localEndpoint: undefined,
  seeders: [],
  isSharing: false,
  mySnapshotId: undefined,
  downloadStatus: 'idle',
  downloadProgress: undefined,
  downloadTargetDir: '',
  pendingAutoDownload: false,
  showDownloadPrompt: false,
  lastDownloadPath: undefined,
  lastConflictFiles: [],
  trash: [],
  conflicts: [],
  identityMismatches: [],
  peerStatuses: {},
  githubConfigured: false,
  sidebarCollapsed: readSidebarCollapsed(),
  setFolder: (folder) => set({ folder }),
  setActiveView: (activeView) => set({ activeView }),
  setProjects: (projects) => set({ projects }),
  setProjectFiles: (projectFiles) => set({ projectFiles }),
  setSelectedFilePath: (selectedFilePath) => set({ selectedFilePath }),
  setFileFilter: (fileFilter) => set({ fileFilter }),
  setLocale: (locale) => {
    persistLocale(locale)
    set({ locale })
  },
  setStatus: (status) => set({ status }),
  setRoomCode: (roomCode) => set({ roomCode }),
  setPeers: (peers) => set({ peers }),
  setIsHost: (isHost) => set({ isHost }),
  setDirectAddress: (directAddress) => set({ directAddress }),
  setLocalEndpoint: (localEndpoint) => set({ localEndpoint }),
  setSeeders: (seeders) => set({ seeders }),
  setIsSharing: (isSharing) => set({ isSharing }),
  setMySnapshotId: (mySnapshotId) => set({ mySnapshotId }),
  setDownloadStatus: (downloadStatus) => set({ downloadStatus }),
  setDownloadProgress: (downloadProgress) => set({ downloadProgress }),
  setDownloadTargetDir: (downloadTargetDir) => set({ downloadTargetDir }),
  setPendingAutoDownload: (pendingAutoDownload) => set({ pendingAutoDownload }),
  setShowDownloadPrompt: (showDownloadPrompt) => set({ showDownloadPrompt }),
  resetDownload: () => set({
    downloadProgress: undefined,
    downloadStatus: 'idle',
    pendingAutoDownload: false,
    showDownloadPrompt: false,
  }),
  setLastDownloadResult: (lastDownloadPath, lastConflictFiles) => set({ lastConflictFiles, lastDownloadPath }),
  clearLastDownloadResult: () => set({ lastConflictFiles: [], lastDownloadPath: undefined }),
  setTrash: (trash) => set({ trash }),
  setConflicts: (conflicts) => set({ conflicts }),
  addConflict: (conflict) => set((state) => ({
    conflicts: [conflict, ...state.conflicts.filter((existing) => existing.opHash !== conflict.opHash)],
  })),
  removeConflict: (opHash) => set((state) => ({ conflicts: state.conflicts.filter((conflict) => conflict.opHash !== opHash) })),
  clearConflicts: () => set({ conflicts: [] }),
  addIdentityMismatch: (info) => set((state) => ({
    identityMismatches: [info, ...state.identityMismatches.filter((existing) => existing.peerId !== info.peerId)],
  })),
  clearIdentityMismatches: () => set({ identityMismatches: [] }),
  setPeerStatus: (peerState) => set((state) => ({
    peerStatuses: { ...state.peerStatuses, [peerState.peerId]: peerState },
  })),
  clearPeerStatuses: () => set({ peerStatuses: {} }),
  setGithubConfigured: (githubConfigured) => set({ githubConfigured }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    try {
      globalThis.localStorage?.setItem('cairn.sidebarCollapsed', String(sidebarCollapsed))
    } catch {
      // 無法存取儲存空間時，仍保留本次工作階段的設定。
    }
    set({ sidebarCollapsed })
  },
  replaceOps: (ops) => set({ ops }),
  prependOp: (op) =>
    set((state) => {
      if (state.ops.some((existing) => existing.hash === op.hash)) {
        return state
      }

      return { ops: [op, ...state.ops].slice(0, 200) }
    }),
}))
