import { useEffect, useState } from 'react'

import { OpLog } from '@/components/OpLog'
import { RoomPanel } from '@/components/RoomPanel'
import { TopBar } from '@/components/TopBar'
import { ConflictPanel } from '@/components/ConflictPanel'
import { SettingsDialog } from '@/components/SettingsDialog'
import { ExportPRDialog } from '@/components/ExportPRDialog'
import { Toast } from '@/components/Toast'
import { createPRBranchName } from '@/lib/prBranch'
import { restoreLastSession } from '@/lib/sessionRestore'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import { useTranslation } from '@/i18n'
import type { IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.data
}

export function App() {
  const { t } = useTranslation()
  const folder = useAppStore((state) => state.folder)
  const ops = useAppStore((state) => state.ops)
  const prependOp = useAppStore((state) => state.prependOp)
  const replaceOps = useAppStore((state) => state.replaceOps)
  const setFolder = useAppStore((state) => state.setFolder)
  const peers = useAppStore((state) => state.peers)
  const roomCode = useAppStore((state) => state.roomCode)
  const setPeers = useAppStore((state) => state.setPeers)
  const setRoomCode = useAppStore((state) => state.setRoomCode)
  const setStatus = useAppStore((state) => state.setStatus)
  const status = useAppStore((state) => state.status)
  const [conflictDetected, setConflictDetected] = useState(false)
  const [roomOpen, setRoomOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const conflicts = useAppStore((state) => state.conflicts)
  const addConflict = useAppStore((state) => state.addConflict)
  const removeConflict = useAppStore((state) => state.removeConflict)
  const setGithubConfigured = useAppStore((state) => state.setGithubConfigured)
  const githubConfigured = useAppStore((state) => state.githubConfigured)
  const [lastFolderUnavailable, setLastFolderUnavailable] = useState(false)
  const [toast, setToast] = useState<NormalizedError | null>(null)

  useEffect(() => {
    let disposed = false

    const restoreSession = async (): Promise<void> => {
      try {
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
      } catch (error) {
        console.error('[cairn] 无法恢复上次会话', error)
        if (!disposed) {
          setToast(normalizeError(error, t))
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
      setConflictDetected(true); addConflict({ ...payload, timestamp: Date.now() })
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
      setRoomCode('')
      setConflictDetected(false)
      getIpcData(await window.cairn.startWatching(selectedFolder))
      setFolder(selectedFolder)
      setStatus('watching')
      setLastFolderUnavailable(false)

      const recentOps = getIpcData(await window.cairn.listRecentOps(200))
      replaceOps(recentOps)
    } catch (error) {
      setStatus('stopped')
      console.error('[cairn] 无法开始监控', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleCreateRoom = async (): Promise<void> => {
    try {
      const code = getIpcData(await window.cairn.createRoom())
      setRoomCode(code)
      setPeers(getIpcData(await window.cairn.listPeers()))
      setConflictDetected(false)
    } catch (error) {
      console.error('[cairn] 无法创建房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleJoinRoom = async (code: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.joinRoom(code))
      setRoomCode(code)
      setPeers(getIpcData(await window.cairn.listPeers()))
      setConflictDetected(false)
    } catch (error) {
      console.error('[cairn] 无法加入房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleLeaveRoom = async (): Promise<void> => {
    try {
      getIpcData(await window.cairn.leaveRoom())
      setPeers([])
      setRoomCode('')
      setConflictDetected(false)
    } catch (error) {
      console.error('[cairn] 无法离开房间', error)
      setToast(normalizeError(error, t))
    }
  }
  const handleExportPR = async (): Promise<void> => { setExportDialogOpen(true) }
  const exportPRSubmit = async (title: string) => {
    const result = await window.cairn.exportPR({
      branch: 'main',
      prBranch: createPRBranchName(roomCode),
      title,
    })
    if (result.ok) {
      console.info('[cairn] PR created')
    }
    return result
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden" aria-label="Cairn">
      <TopBar
        folder={folder}
        status={status}
        onSelectFolder={handleSelectFolder}
        onToggleRoom={() => setRoomOpen((open) => !open)}
        roomCode={roomCode}
        onSettings={() => setSettingsOpen(true)}
        githubConfigured={githubConfigured}
      />
      {roomOpen && (
        <RoomPanel
          conflictDetected={conflictDetected}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onLeaveRoom={handleLeaveRoom}
          peers={peers}
          roomCode={roomCode}
          githubConfigured={githubConfigured}
          onExportPR={handleExportPR}
        />
      )}
      <OpLog
        ops={ops}
        emptyMessage={lastFolderUnavailable ? t('lastFolderUnavailable') : undefined}
      />
      <ConflictPanel conflicts={conflicts} onIgnore={removeConflict} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onConfigured={setGithubConfigured} />
      <ExportPRDialog
        open={exportDialogOpen}
        defaultTitle={`Cairn ${roomCode}`}
        onClose={() => setExportDialogOpen(false)}
        onOpenSettings={() => {
          setExportDialogOpen(false)
          setSettingsOpen(true)
        }}
        onSubmit={exportPRSubmit}
      />
      <Toast error={toast} onDismiss={() => setToast(null)} />
    </main>
  )
}
