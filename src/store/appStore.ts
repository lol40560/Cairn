import { create } from 'zustand'

import { detectLocale, persistLocale, type Locale } from '../i18n/locales'
import type { LocalEndpoint, Op, PeerInfo, SeederInfo } from '../types/cairn'

export type WatchStatus = 'idle' | 'watching' | 'stopped'
export type ActiveView = 'activity' | 'room' | 'conflicts'
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
  lastDownloadPath: string | undefined
  lastConflictFiles: string[]
  conflicts: Array<{ op: Op; localContent: string; timestamp: number }>
  githubConfigured: boolean
  setFolder(folder: string): void
  setActiveView(view: ActiveView): void
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
  resetDownload(): void
  setLastDownloadResult(path: string, conflicts: string[]): void
  clearLastDownloadResult(): void
  addConflict(conflict: { op: Op; localContent: string; timestamp: number }): void
  removeConflict(opHash: string): void
  clearConflicts(): void
  setGithubConfigured(value: boolean): void
  replaceOps(ops: Op[]): void
  prependOp(op: Op): void
}

export const useAppStore = create<AppState>((set) => ({
  folder: '',
  activeView: 'activity',
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
  lastDownloadPath: undefined,
  lastConflictFiles: [],
  conflicts: [],
  githubConfigured: false,
  setFolder: (folder) => set({ folder }),
  setActiveView: (activeView) => set({ activeView }),
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
  resetDownload: () => set({ downloadProgress: undefined, downloadStatus: 'idle' }),
  setLastDownloadResult: (lastDownloadPath, lastConflictFiles) => set({ lastConflictFiles, lastDownloadPath }),
  clearLastDownloadResult: () => set({ lastConflictFiles: [], lastDownloadPath: undefined }),
  addConflict: (conflict) => set((state) => ({ conflicts: [...state.conflicts, conflict] })),
  removeConflict: (opHash) => set((state) => ({ conflicts: state.conflicts.filter((conflict) => conflict.op.hash !== opHash) })),
  clearConflicts: () => set({ conflicts: [] }),
  setGithubConfigured: (githubConfigured) => set({ githubConfigured }),
  replaceOps: (ops) => set({ ops }),
  prependOp: (op) =>
    set((state) => {
      if (state.ops.some((existing) => existing.hash === op.hash)) {
        return state
      }

      return { ops: [op, ...state.ops].slice(0, 200) }
    }),
}))
