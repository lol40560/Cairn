import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { Op } from './core/oplog/types'
import type { PeerInfo, SeederInfo } from './core/sync/protocol'
import type { IpcResult } from './core/errors'
import type { ExportSnapshotResult } from './core/snapshot/export'
import type { DownloadProgress, DownloadResult } from './core/sync/downloader'
import type { DiscoveryStatus } from './core/sync/discovery'
import type { TrashEntry } from './core/trash'
import type { ProjectEntry } from './core/projects'
import type { ConflictRecord, ConflictResolution } from './core/conflicts'
import type { ProjectFileContent, ProjectFileEntry } from './main'

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
  listProjectFiles: (): Promise<IpcResult<{ files: ProjectFileEntry[]; truncated: boolean }>> =>
    invoke('cairn:listProjectFiles'),
  readProjectFile: (filePath: string): Promise<IpcResult<ProjectFileContent>> =>
    invoke('cairn:readProjectFile', filePath),
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
  getLocalEndpoint: (): Promise<IpcResult<{ host: string; port: number } | undefined>> =>
    invoke('cairn:getLocalEndpoint'),
  connectToAddress: (input: { host: string; port: number; roomCode: string }): Promise<IpcResult<void>> =>
    invoke('cairn:connectToAddress', input),
  getDiscoveryStatus: (): Promise<IpcResult<DiscoveryStatus>> =>
    invoke('cairn:getDiscoveryStatus'),
  onPeers: (callback: (peers: PeerInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, peers: PeerInfo[]): void => callback(peers)
    ipcRenderer.on('cairn:peers', listener)

    return () => {
      ipcRenderer.removeListener('cairn:peers', listener)
    }
  },
  onConflict: (callback: (conflict: ConflictRecord) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, conflict: ConflictRecord): void => callback(conflict)
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
  exportSnapshot: (): Promise<IpcResult<ExportSnapshotResult | { canceled: true }>> => invoke('cairn:exportSnapshot'),
  copyToClipboard: (text: string): Promise<IpcResult<void>> => invoke('cairn:copyToClipboard', text),
  openExternal: (url: string): Promise<IpcResult<void>> => invoke('cairn:openExternal', url),
  openInFileManager: (targetPath: string): Promise<IpcResult<void>> =>
    invoke('cairn:openInFileManager', targetPath),
  startSharing: (): Promise<IpcResult<SeederInfo>> => invoke('cairn:startSharing'),
  stopSharing: (): Promise<IpcResult<void>> => invoke('cairn:stopSharing'),
  downloadProject: (input: { snapshotId: string; targetDir: string }): Promise<IpcResult<DownloadResult>> =>
    invoke('cairn:downloadProject', input),
  listSeeders: (): Promise<IpcResult<SeederInfo[]>> => invoke('cairn:listSeeders'),
  getDefaultDownloadDir: (): Promise<IpcResult<string>> => invoke('cairn:getDefaultDownloadDir'),
  cancelDownload: (): Promise<IpcResult<void>> => invoke('cairn:cancelDownload'),
  selectDownloadFolder: (): Promise<IpcResult<string>> => invoke('cairn:selectDownloadFolder'),
  onDownloadProgress: (callback: (progress: DownloadProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: DownloadProgress): void => callback(progress)
    ipcRenderer.on('cairn:downloadProgress', listener)

    return () => {
      ipcRenderer.removeListener('cairn:downloadProgress', listener)
    }
  },
  checkFolder: (folder: string): Promise<IpcResult<boolean>> => invoke('cairn:checkFolder', folder),
  listProjects: (): Promise<IpcResult<Array<ProjectEntry & { available: boolean }>>> =>
    invoke('cairn:listProjects'),
  addProject: (projectPath: string): Promise<IpcResult<ProjectEntry>> =>
    invoke('cairn:addProject', projectPath),
  removeProject: (id: string): Promise<IpcResult<void>> => invoke('cairn:removeProject', id),
  setActiveProject: (id: string): Promise<IpcResult<void>> => invoke('cairn:setActiveProject', id),
  getActiveProject: (): Promise<IpcResult<ProjectEntry | undefined>> =>
    invoke('cairn:getActiveProject'),
  checkProjectAvailability: (id: string): Promise<IpcResult<boolean>> =>
    invoke('cairn:checkProjectAvailability', id),
  getLastSession: (): Promise<IpcResult<{ folder: string; watching: boolean; updatedAt: number }>> => invoke('cairn:getLastSession'),
  clearLastSession: (): Promise<IpcResult<void>> => invoke('cairn:clearLastSession'),
  getOnboardingState: (): Promise<IpcResult<{ completed: boolean; completedAt?: number }>> => invoke('cairn:getOnboardingState'),
  completeOnboarding: (): Promise<IpcResult<void>> => invoke('cairn:completeOnboarding'),
  resetOnboarding: (): Promise<IpcResult<void>> => invoke('cairn:resetOnboarding'),
  getSettings: (): Promise<IpcResult<{ autoStartWatching: boolean; rememberLastFolder: boolean; trashRetentionDays: number }>> => invoke('cairn:getSettings'),
  updateSettings: (partial: Partial<{ autoStartWatching: boolean; rememberLastFolder: boolean; trashRetentionDays: number }>): Promise<IpcResult<void>> => invoke('cairn:updateSettings', partial),
  listTrash: (): Promise<IpcResult<TrashEntry[]>> => invoke('cairn:listTrash'),
  restoreFromTrash: (trashId: string): Promise<IpcResult<void>> => invoke('cairn:restoreFromTrash', trashId),
  purgeFromTrash: (trashId: string): Promise<IpcResult<void>> => invoke('cairn:purgeFromTrash', trashId),
  emptyTrash: (): Promise<IpcResult<void>> => invoke('cairn:emptyTrash'),
  getTrashRetentionDays: (): Promise<IpcResult<number>> => invoke('cairn:getTrashRetentionDays'),
  setTrashRetentionDays: (days: number): Promise<IpcResult<void>> => invoke('cairn:setTrashRetentionDays', days),
  listConflicts: (): Promise<IpcResult<ConflictRecord[]>> => invoke('cairn:listConflicts'),
  getConflict: (opHash: string): Promise<IpcResult<ConflictRecord | undefined>> =>
    invoke('cairn:getConflict', opHash),
  resolveConflict: (opHash: string, resolution: ConflictResolution, content?: string): Promise<IpcResult<void>> =>
    invoke('cairn:resolveConflict', opHash, resolution, content),
  deleteConflict: (opHash: string): Promise<IpcResult<void>> => invoke('cairn:deleteConflict', opHash),
}

contextBridge.exposeInMainWorld('cairn', cairn)
