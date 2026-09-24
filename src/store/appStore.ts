import { create } from 'zustand'

import { detectLocale, persistLocale, type Locale } from '../i18n/locales'
import type { Op } from '../types/cairn'
import type { PeerInfo } from '../types/cairn'

export type WatchStatus = 'idle' | 'watching' | 'stopped'
export type ActiveView = 'activity' | 'room' | 'conflicts'

export interface AppState {
  folder: string
  activeView: ActiveView
  locale: Locale
  status: WatchStatus
  ops: Op[]
  roomCode: string
  peers: PeerInfo[]
  conflicts: Array<{ op: Op; localContent: string; timestamp: number }>
  githubConfigured: boolean
  setFolder(folder: string): void
  setActiveView(view: ActiveView): void
  setLocale(locale: Locale): void
  setStatus(status: WatchStatus): void
  setRoomCode(code: string): void
  setPeers(peers: PeerInfo[]): void
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
