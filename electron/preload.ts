import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { Op } from './core/oplog/types'
import type { PeerInfo } from './core/sync/protocol'
import type { IpcResult } from './core/errors'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args)
}

const cairn = {
  selectFolder: (): Promise<IpcResult<string>> => invoke('cairn:selectFolder'),
  startWatching: (folder: string): Promise<IpcResult<void>> =>
    invoke('cairn:startWatching', folder),
  stopWatching: (): Promise<IpcResult<void>> => invoke('cairn:stopWatching'),
  listRecentOps: (limit: number): Promise<IpcResult<Op[]>> =>
    invoke('cairn:listRecentOps', limit),
  onOp: (callback: (op: Op) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, op: Op): void => callback(op)
    ipcRenderer.on('cairn:op', listener)

    return () => {
      ipcRenderer.removeListener('cairn:op', listener)
    }
  },
  createRoom: (): Promise<IpcResult<string>> => invoke('cairn:createRoom'),
  joinRoom: (roomCode: string): Promise<IpcResult<void>> =>
    invoke('cairn:joinRoom', roomCode),
  leaveRoom: (): Promise<IpcResult<void>> => invoke('cairn:leaveRoom'),
  listPeers: (): Promise<IpcResult<PeerInfo[]>> => invoke('cairn:listPeers'),
  onPeers: (callback: (peers: PeerInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, peers: PeerInfo[]): void => callback(peers)
    ipcRenderer.on('cairn:peers', listener)

    return () => {
      ipcRenderer.removeListener('cairn:peers', listener)
    }
  },
  onConflict: (callback: (payload: { op: Op; localContent: string; source: 'remote' }) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { op: Op; localContent: string; source: 'remote' },
    ): void => callback(payload)
    ipcRenderer.on('cairn:conflict', listener)

    return () => {
      ipcRenderer.removeListener('cairn:conflict', listener)
    }
  },
  saveGithubConfig: (config: { token?: string; owner: string; repo: string }): Promise<IpcResult<void>> => invoke('cairn:saveGithubConfig', config),
  getGithubConfig: (): Promise<IpcResult<{ owner: string; repo: string; hasToken: boolean }>> => invoke('cairn:getGithubConfig'),
  clearGithubConfig: (): Promise<IpcResult<void>> => invoke('cairn:clearGithubConfig'),
  resetGithubConfig: (): Promise<IpcResult<void>> => invoke('cairn:resetGithubConfig'),
  exportPR: (options: { branch?: string; prBranch?: string; title: string; body?: string }): Promise<IpcResult<{ prUrl: string; prNumber: number }>> => invoke('cairn:exportPR', options),
  checkFolder: (folder: string): Promise<IpcResult<boolean>> => invoke('cairn:checkFolder', folder),
  getLastSession: (): Promise<IpcResult<{ folder: string; watching: boolean; updatedAt: number }>> => invoke('cairn:getLastSession'),
  clearLastSession: (): Promise<IpcResult<void>> => invoke('cairn:clearLastSession'),
  getSettings: (): Promise<IpcResult<{ autoStartWatching: boolean; rememberLastFolder: boolean }>> => invoke('cairn:getSettings'),
  updateSettings: (partial: Partial<{ autoStartWatching: boolean; rememberLastFolder: boolean }>): Promise<IpcResult<void>> => invoke('cairn:updateSettings', partial),
}

contextBridge.exposeInMainWorld('cairn', cairn)
