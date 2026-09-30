import { useCallback, useEffect, useState } from 'react'

import { Dock } from '@/components/Dock'
import { ExportPRDialog } from '@/components/ExportPRDialog'
import { Onboarding } from '@/components/Onboarding'
import { SettingsDialog } from '@/components/SettingsDialog'
import { Toast, type ToastMessage } from '@/components/Toast'
import { TopBar } from '@/components/TopBar'
import { ActivityView } from '@/components/views/ActivityView'
import { ConflictsView } from '@/components/views/ConflictsView'
import { RoomView } from '@/components/views/RoomView'
import { TrashView } from '@/components/views/TrashView'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { createPRBranchName } from '@/lib/prBranch'
import { restoreLastSession } from '@/lib/sessionRestore'
import { useTranslation, type TranslateFn } from '@/i18n'
import { useAppStore } from '@/store/appStore'
import type { IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.data
}

function startupRestoreError(error: unknown, t: TranslateFn): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'hintKey' in error
    && error.hintKey === 'hintChooseSmallerFolder'
  ) {
    return t('startupFolderTooLarge')
  }
  return normalizeError(error, t).message
}

async function copyExportPath(filePath: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(filePath)
    return true
  } catch {
    const copyResult = await window.cairn.copyToClipboard(filePath)
    if (!copyResult.ok) {
      console.error('[cairn] 无法复制导出路径', copyResult.error)
    }
    return copyResult.ok
  }
}

export function App() {
  const { t } = useTranslation()
  const activeView = useAppStore((state) => state.activeView)
  const conflicts = useAppStore((state) => state.conflicts)
  const folder = useAppStore((state) => state.folder)
  const ops = useAppStore((state) => state.ops)
  const peers = useAppStore((state) => state.peers)
  const roomCode = useAppStore((state) => state.roomCode)
  const status = useAppStore((state) => state.status)
  const addConflict = useAppStore((state) => state.addConflict)
  const prependOp = useAppStore((state) => state.prependOp)
  const replaceOps = useAppStore((state) => state.replaceOps)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setFolder = useAppStore((state) => state.setFolder)
  const setGithubConfigured = useAppStore((state) => state.setGithubConfigured)
  const setIsHost = useAppStore((state) => state.setIsHost)
  const setPeers = useAppStore((state) => state.setPeers)
  const setRoomCode = useAppStore((state) => state.setRoomCode)
  const setStatus = useAppStore((state) => state.setStatus)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [lastFolderUnavailable, setLastFolderUnavailable] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState<string | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)

  useEffect(() => {
    let disposed = false

    const restoreSession = async (): Promise<void> => {
      try {
        const sessionResult = await window.cairn.getLastSession()
        if (!sessionResult.ok) throw sessionResult.error

        await restoreLastSession(window.cairn, {
          replaceOps: (recentOps) => {
            if (!disposed) {
              replaceOps(recentOps)
            }
          },
          setFolder: (savedFolder) => {
            if (!disposed) {
              setFolder(savedFolder)
            }
          },
          setStatus: (savedStatus) => {
            if (!disposed) {
              setStatus(savedStatus)
            }
          },
          setUnavailable: (value) => {
            if (!disposed) {
              setLastFolderUnavailable(value)
            }
          },
        })

        // 已保存过项目的用户直接恢复工作区，不再覆盖为首次引导。
        if (!sessionResult.data.folder) {
          const onboardingResult = await window.cairn.getOnboardingState()
          if (!onboardingResult.ok) throw onboardingResult.error
          if (!onboardingResult.data.completed && !disposed) {
            setShowOnboarding(true)
          }
        }
        if (!disposed) {
          setRestoreError(undefined)
        }
      } catch (error) {
        console.error('[cairn] 无法恢复上次会话', error)
        if (!disposed) {
          setRestoreError(startupRestoreError(error, t))
        }
      } finally {
        if (!disposed) {
          setRestoring(false)
        }
      }
    }

    void restoreSession()
    void window.cairn
      .getGithubConfig()
      .then((result) => setGithubConfigured(getIpcData(result).hasToken))
      .catch((error) => {
        console.error('[cairn] 无法读取 GitHub 配置', error)
        if (!disposed) {
          setToast(normalizeError(error, t))
        }
      })
    void window.cairn
      .listPeers()
      .then((result) => {
        const initialPeers = getIpcData(result)
        if (!disposed) {
          setPeers(initialPeers)
        }
      })
      .catch((error) => {
        console.error('[cairn] 无法读取队友列表', error)
        if (!disposed) {
          setToast(normalizeError(error, t))
        }
      })
    const unsubscribe = window.cairn.onOp((op) => {
      if (!disposed) {
        prependOp(op)
      }
    })
    const unsubscribePeers = window.cairn.onPeers(setPeers)
    const unsubscribeConflict = window.cairn.onConflict((payload) => {
      addConflict({ ...payload, timestamp: Date.now() })
      console.warn('[cairn] 检测到冲突', payload)
    })

    return () => {
      disposed = true
      unsubscribe()
      unsubscribePeers()
      unsubscribeConflict()
    }
  }, [addConflict, prependOp, replaceOps, setFolder, setGithubConfigured, setPeers, setStatus, t])

  const handleSelectFolder = async (): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (selectedFolder === '') {
        return
      }

      getIpcData(await window.cairn.stopWatching())
      setPeers([])
      setIsHost(false)
      setRoomCode('')
      getIpcData(await window.cairn.startWatching(selectedFolder))
      setFolder(selectedFolder)
      setStatus('watching')
      setLastFolderUnavailable(false)
      replaceOps(getIpcData(await window.cairn.listRecentOps(200)))
    } catch (error) {
      setStatus('stopped')
      console.error('[cairn] 无法开始监控', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleOpenDifferentProject = async (): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (selectedFolder === '') return

      setRestoring(true)
      setRestoreError(undefined)
      getIpcData(await window.cairn.startWatching(selectedFolder))
      setPeers([])
      setIsHost(false)
      setRoomCode('')
      setFolder(selectedFolder)
      setStatus('watching')
      setLastFolderUnavailable(false)
      replaceOps(getIpcData(await window.cairn.listRecentOps(200)))
    } catch (error) {
      console.error('[cairn] 无法打开其他项目', error)
      setRestoreError(startupRestoreError(error, t))
    } finally {
      setRestoring(false)
    }
  }

  const handleCreateRoom = async (): Promise<void> => {
    try {
      const code = getIpcData(await window.cairn.createRoom())
      setRoomCode(code)
      setIsHost(true)
      setPeers(getIpcData(await window.cairn.listPeers()))
    } catch (error) {
      console.error('[cairn] 无法创建房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleJoinRoom = async (code: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.joinRoom(code))
      setRoomCode(code)
      setIsHost(false)
      setPeers(getIpcData(await window.cairn.listPeers()))
    } catch (error) {
      console.error('[cairn] 无法加入房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleLeaveRoom = async (): Promise<void> => {
    try {
      getIpcData(await window.cairn.leaveRoom())
      setPeers([])
      setIsHost(false)
      setRoomCode('')
    } catch (error) {
      console.error('[cairn] 无法离开房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleExportSnapshot = async (): Promise<void> => {
    try {
      const result = await window.cairn.exportSnapshot()
      if (!result.ok) {
        console.error('[cairn] 无法导出项目快照', result.error)
        setToast(
          result.error.code === 'SNAPSHOT_TOO_LARGE'
            ? { message: t('exportSnapshotTooLarge'), tone: 'error' }
            : normalizeError(result.error, t),
        )
        return
      }
      if ('canceled' in result.data) {
        return
      }

      const copied = await copyExportPath(result.data.filePath)

      setToast({
        hint: copied ? t('exportSnapshotCopied') : undefined,
        message: t('exportSnapshotSuccess')
          .replace('{count}', String(result.data.fileCount))
          .replace('{path}', result.data.filePath),
        tone: 'success',
      })
    } catch (error) {
      console.error('[cairn] 无法导出项目快照', error)
      setToast(normalizeError(error, t))
    }
  }

  const exportPRSubmit = async (title: string) => window.cairn.exportPR({
    branch: 'main',
    prBranch: createPRBranchName(roomCode),
    title,
  })

  const dismissToast = useCallback(() => setToast(null), [])

  return (
    <>
      <main aria-label="Cairn" className="app">
      <section className="shell">
        <TopBar folder={folder} opCount={ops.length} roomCode={roomCode} status={status} />
        <div className="content">
          {activeView === 'activity' && (
            <ActivityView
              emptyMessage={lastFolderUnavailable ? t('lastFolderUnavailable') : undefined}
              ops={ops}
              onChangeFolder={handleSelectFolder}
            />
          )}
          {activeView === 'room' && (
            <RoomView
              hasOps={ops.length > 0}
              peers={peers}
              roomCode={roomCode}
              onCreateRoom={handleCreateRoom}
              onExportSnapshot={handleExportSnapshot}
              onExportPR={() => setExportDialogOpen(true)}
              onJoinRoom={handleJoinRoom}
              onLeaveRoom={handleLeaveRoom}
            />
          )}
          {activeView === 'conflicts' && <ConflictsView />}
          {activeView === 'trash' && <TrashView />}
        </div>
      </section>
      <Dock
        activeView={activeView}
        conflictCount={conflicts.length}
        onOpenSettings={() => setSettingsOpen(true)}
        onViewChange={setActiveView}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onConfigured={setGithubConfigured}
        onShowOnboarding={() => setShowOnboarding(true)}
      />
      <ExportPRDialog
        defaultTitle={`Cairn ${roomCode}`}
        open={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        onOpenSettings={() => {
          setExportDialogOpen(false)
          setSettingsOpen(true)
        }}
        onSubmit={exportPRSubmit}
      />
      <Toast message={toast} onDismiss={dismissToast} />
      </main>
      {restoring && (
        <div className="startup-overlay" role="status">
          <div aria-hidden="true" className="startup-spinner" />
          <div className="startup-message">{t('startupLoading')}</div>
        </div>
      )}
      {restoreError && (
        <div className="startup-error" role="alert">
          <span>{restoreError}</span>
          <button className="btn btn-ghost" type="button" onClick={() => void handleOpenDifferentProject()}>
            {t('openDifferentProject')}
          </button>
        </div>
      )}
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}
    </>
  )
}
