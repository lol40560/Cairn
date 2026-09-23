import type { AppSettings, IpcResult, LastSession, Op } from '@/types/cairn'

export interface SessionRestoreApi {
  checkFolder(folder: string): Promise<IpcResult<boolean>>
  clearLastSession(): Promise<IpcResult<void>>
  getLastSession(): Promise<IpcResult<LastSession>>
  getSettings(): Promise<IpcResult<AppSettings>>
  listRecentOps(limit: number): Promise<IpcResult<Op[]>>
  startWatching(folder: string): Promise<IpcResult<void>>
}

export interface SessionRestoreActions {
  replaceOps(ops: Op[]): void
  setFolder(folder: string): void
  setStatus(status: 'idle' | 'watching'): void
  setUnavailable(value: boolean): void
}

/** 按用户设置恢复文件夹与监控状态。 */
export async function restoreLastSession(
  api: SessionRestoreApi,
  actions: SessionRestoreActions,
): Promise<void> {
  const [settingsResult, sessionResult] = await Promise.all([api.getSettings(), api.getLastSession()])
  if (!settingsResult.ok) throw settingsResult.error
  if (!sessionResult.ok) throw sessionResult.error
  const settings = settingsResult.data
  const session = sessionResult.data
  if (!settings.rememberLastFolder || !session.folder) {
    return
  }

  const folderResult = await api.checkFolder(session.folder)
  if (!folderResult.ok) throw folderResult.error
  if (!folderResult.data) {
    const clearResult = await api.clearLastSession()
    if (!clearResult.ok) throw clearResult.error
    actions.setUnavailable(true)
    return
  }

  actions.setFolder(session.folder)
  if (settings.autoStartWatching && session.watching) {
    const startResult = await api.startWatching(session.folder)
    if (!startResult.ok) throw startResult.error
    actions.setStatus('watching')
  } else {
    actions.setStatus('idle')
  }
  const opsResult = await api.listRecentOps(200)
  if (!opsResult.ok) throw opsResult.error
  actions.replaceOps(opsResult.data)
}
