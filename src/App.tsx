import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ConflictDialog } from '@/components/ConflictDialog'
import { HackathonController } from '@/components/HackathonController'
import { SearchPalette, type SearchPaletteItem } from '@/components/SearchPalette'
import { ExportPRDialog } from '@/components/ExportPRDialog'
import { Onboarding } from '@/components/Onboarding'
import { SettingsView } from '@/components/SettingsDialog'
import { Sidebar } from '@/components/Sidebar'
import { Toast, type ToastMessage } from '@/components/Toast'
import { TopBar } from '@/components/TopBar'
import { ActivityView } from '@/components/views/ActivityView'
import { CheckpointsView } from '@/components/views/CheckpointsView'
import { ConflictsView } from '@/components/views/ConflictsView'
import { FilesView } from '@/components/views/FilesView'
import { DemoFilesView } from '@/components/views/DemoFilesView'
import { DemoCheckpointsView } from '@/components/views/DemoCheckpointsView'
import { HomeView } from '@/components/views/HomeView'
import { RoomView } from '@/components/views/RoomView'
import { TrashView } from '@/components/views/TrashView'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { createPRBranchName } from '@/lib/prBranch'
import { restoreLastSession } from '@/lib/sessionRestore'
import { isEditableTarget, shortcutLabel } from '@/lib/shortcuts'
import { getDemoScenario, type HackathonExecutionMode, type HackathonSceneId } from '@/lib/hackathonMode'
import { createDemoWorkspace } from '@/lib/demoWorkspace'
import { createSimulationCapabilityController, type RealWorkspaceAction } from '@/lib/simulationCapabilities'
import { useTranslation, type TranslateFn } from '@/i18n'
import { useAppStore } from '@/store/appStore'
import type { AvailableProjectEntry, IpcResult } from '@/types/cairn'

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
  const dirtyFilePaths = useAppStore((state) => state.dirtyFilePaths)
  const folder = useAppStore((state) => state.folder)
  const ops = useAppStore((state) => state.ops)
  const peers = useAppStore((state) => state.peers)
  const roomCode = useAppStore((state) => state.roomCode)
  const status = useAppStore((state) => state.status)
  const addConflict = useAppStore((state) => state.addConflict)
  const addIdentityMismatch = useAppStore((state) => state.addIdentityMismatch)
  const clearIdentityMismatches = useAppStore((state) => state.clearIdentityMismatches)
  const clearPeerStatuses = useAppStore((state) => state.clearPeerStatuses)
  const prependOp = useAppStore((state) => state.prependOp)
  const replaceOps = useAppStore((state) => state.replaceOps)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setFolder = useAppStore((state) => state.setFolder)
  const setGithubConfigured = useAppStore((state) => state.setGithubConfigured)
  const setIsHost = useAppStore((state) => state.setIsHost)
  const setPeers = useAppStore((state) => state.setPeers)
  const setPeerStatus = useAppStore((state) => state.setPeerStatus)
  const setRoomCode = useAppStore((state) => state.setRoomCode)
  const setStatus = useAppStore((state) => state.setStatus)
  const setConflicts = useAppStore((state) => state.setConflicts)
  const projects = useAppStore((state) => state.projects)
  const projectFiles = useAppStore((state) => state.projectFiles)
  const setProjects = useAppStore((state) => state.setProjects)
  const setProjectFiles = useAppStore((state) => state.setProjectFiles)
  const setSelectedFilePath = useAppStore((state) => state.setSelectedFilePath)
  const selectedFilePath = useAppStore((state) => state.selectedFilePath)
  const incrementUnseenActivity = useAppStore((state) => state.incrementUnseenActivity)
  const clearUnseenActivity = useAppStore((state) => state.clearUnseenActivity)
  const removeConflict = useAppStore((state) => state.removeConflict)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [lastFolderUnavailable, setLastFolderUnavailable] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState<string | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false)
  const [hackathonEnabled, setHackathonEnabled] = useState(false)
  const [hackathonMode, setHackathonMode] = useState<HackathonExecutionMode>('live')
  const [hackathonScene, setHackathonScene] = useState<HackathonSceneId>('ready')
  const [presentationMode, setPresentationMode] = useState(false)
  const [viewBeforeHackathon, setViewBeforeHackathon] = useState(activeView)
  const [demoWorkspace, setDemoWorkspace] = useState(() => createDemoWorkspace('ready'))
  const [demoWorkspaceVersion, setDemoWorkspaceVersion] = useState(0)
  const [demoDirty, setDemoDirty] = useState(false)
  const [demoConflictResolved, setDemoConflictResolved] = useState(false)
  const activeViewRef = useRef(activeView)
  const [simulationGate] = useState(() => createSimulationCapabilityController(
    () => setToast({ message: t('simulationActionUnavailable'), tone: 'error' }),
  ))

  const permitRealWorkspaceAction = useCallback((action: RealWorkspaceAction): boolean => (
    simulationGate.permit(action)
  ), [simulationGate])
  const setSimulationIsolation = useCallback((active: boolean): void => {
    simulationGate.setSimulationActive(active)
    void window.cairn.setSimulationMode(active)
  }, [simulationGate])

  useEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  useEffect(() => {
    const active = hackathonEnabled && hackathonMode === 'simulation'
    setSimulationIsolation(active)
  }, [hackathonEnabled, hackathonMode, setSimulationIsolation])

  const activateProject = useCallback(async (project: AvailableProjectEntry): Promise<void> => {
    if (!permitRealWorkspaceAction('switch-project')) return
    try {
      getIpcData(await window.cairn.startWatching(project.path))
      setFolder(project.path)
      setStatus('watching')
      replaceOps(getIpcData(await window.cairn.listRecentOps(200)))
      setActiveView('activity')
    } catch (error) {
      setToast(normalizeError(error, t))
    }
  }, [permitRealWorkspaceAction, replaceOps, setActiveView, setFolder, setStatus, t])

  const openQuickOpen = useCallback(async (): Promise<void> => {
    if (!permitRealWorkspaceAction('quick-open')) return
    if (projectFiles.length === 0 && folder) {
      const result = await window.cairn.listProjectFiles()
      if (result.ok) setProjectFiles(result.data.files)
    }
    setQuickOpenOpen(true)
  }, [folder, permitRealWorkspaceAction, projectFiles.length, setProjectFiles])

  const openProjectSwitcher = useCallback(async (): Promise<void> => {
    if (!permitRealWorkspaceAction('switch-project')) return
    const result = await window.cairn.listProjects()
    if (result.ok) setProjects(result.data)
    setProjectSwitcherOpen(true)
  }, [permitRealWorkspaceAction, setProjects])

  const openFileFromPalette = useCallback((path: string): void => {
    if (!permitRealWorkspaceAction('project-file')) return
    if (activeView === 'files') {
      window.dispatchEvent(new CustomEvent('cairn:open-file', { detail: path }))
      return
    }
    setSelectedFilePath(path)
    setActiveView('files')
  }, [activeView, permitRealWorkspaceAction, setActiveView, setSelectedFilePath])

  useEffect(() => {
    let disposed = false

    const restoreSession = async (): Promise<void> => {
      try {
        const sessionResult = await window.cairn.getLastSession()
        if (!sessionResult.ok) throw sessionResult.error

        const session = sessionResult.data
        const settingsResult = await window.cairn.getSettings()
        if (!settingsResult.ok) throw settingsResult.error

        if (settingsResult.data.rememberLastFolder && session.folder) {
          const folderResult = await window.cairn.checkFolder(session.folder)
          if (!folderResult.ok) throw folderResult.error

          if (folderResult.data) {
            await restoreLastSession(window.cairn, {
              replaceOps: (recentOps) => {
                if (!disposed) replaceOps(recentOps)
              },
              setFolder: (savedFolder) => {
                if (!disposed) setFolder(savedFolder)
              },
              setStatus: (savedStatus) => {
                if (!disposed) setStatus(savedStatus)
              },
              setUnavailable: (value) => {
                if (!disposed) setLastFolderUnavailable(value)
              },
            })
            if (!disposed) setActiveView('activity')
          } else if (!disposed) {
            // 保留历史记录以便 Home 视图展示缺失项目，而非清空用户选择。
            setLastFolderUnavailable(true)
            setActiveView('home')
          }
        } else {
          const projectsResult = await window.cairn.listProjects()
          if (!projectsResult.ok) throw projectsResult.error

          if (projectsResult.data.length > 0) {
            if (!disposed) setActiveView('home')
          } else {
            const onboardingResult = await window.cairn.getOnboardingState()
            if (!onboardingResult.ok) throw onboardingResult.error
            if (!disposed) {
              if (!onboardingResult.data.completed) {
                setShowOnboarding(true)
              } else {
                setActiveView('home')
              }
            }
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
        if (activeViewRef.current !== 'activity') incrementUnseenActivity()
      }
    })
    const unsubscribePeers = window.cairn.onPeers(setPeers)
    const unsubscribeConflict = window.cairn.onConflict((conflict) => {
      addConflict(conflict)
      console.warn('[cairn] 检测到冲突', conflict)
    })
    const unsubscribeIdentityMismatch = window.cairn.onIdentityMismatch((info) => {
      if (!disposed) addIdentityMismatch(info)
    })
    const unsubscribePeerStatus = window.cairn.onPeerStatusChanged((peerState) => {
      if (!disposed) setPeerStatus(peerState)
    })

    return () => {
      disposed = true
      unsubscribe()
      unsubscribePeers()
      unsubscribeConflict()
      unsubscribeIdentityMismatch()
      unsubscribePeerStatus()
    }
  }, [addConflict, addIdentityMismatch, incrementUnseenActivity, prependOp, replaceOps, setActiveView, setFolder, setGithubConfigured, setPeerStatus, setPeers, setStatus, t])

  useEffect(() => {
    if (activeView === 'activity') clearUnseenActivity()
  }, [activeView, clearUnseenActivity])

  useEffect(() => {
    let disposed = false
    void window.cairn.listConflicts().then((result) => {
      if (!disposed && result.ok) {
        setConflicts(result.data)
      }
    }).catch((error) => console.error('[cairn] 无法读取冲突列表', error))
    return () => { disposed = true }
  }, [folder, setConflicts])

  const handleOpenDifferentProject = async (): Promise<void> => {
    if (!permitRealWorkspaceAction('switch-project')) return
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
    if (!permitRealWorkspaceAction('room-connect')) return
    try {
      clearIdentityMismatches()
      clearPeerStatuses()
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
    if (!permitRealWorkspaceAction('room-connect')) return
    try {
      clearIdentityMismatches()
      clearPeerStatuses()
      getIpcData(await window.cairn.joinRoom(code))
      setRoomCode(code)
      setIsHost(false)
      setPeers(getIpcData(await window.cairn.listPeers()))
    } catch (error) {
      console.error('[cairn] 无法加入房间', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleLeaveRoom = useCallback(async (): Promise<void> => {
    if (!permitRealWorkspaceAction('leave-team')) return
    try {
      getIpcData(await window.cairn.leaveRoom())
      setPeers([])
      setIsHost(false)
      setRoomCode('')
      clearIdentityMismatches()
      clearPeerStatuses()
    } catch (error) {
      console.error('[cairn] 无法离开房间', error)
      setToast(normalizeError(error, t))
    }
  }, [clearIdentityMismatches, clearPeerStatuses, permitRealWorkspaceAction, setIsHost, setPeers, setRoomCode, t])

  const handleExportSnapshot = useCallback(async (): Promise<void> => {
    if (!permitRealWorkspaceAction('export-snapshot')) return
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
  }, [permitRealWorkspaceAction, t])

  const exportPRSubmit = async (title: string) => {
    if (!permitRealWorkspaceAction('export-pr')) {
      return {
        ok: false as const,
        error: { category: 'permission' as const, message: t('simulationActionUnavailable'), raw: 'SIMULATION_ISOLATED' },
      }
    }
    return window.cairn.exportPR({
      branch: 'main',
      prBranch: createPRBranchName(roomCode),
      title,
    })
  }

  const dismissToast = useCallback(() => setToast(null), [])
  const simulationActive = hackathonEnabled && hackathonMode === 'simulation'

  const commands = useMemo(() => {
    const list: Array<SearchPaletteItem & { action(): void }> = [
      { id: 'nav-home', label: t('home'), group: t('groupProject'), shortcut: shortcutLabel('1'), action: () => setActiveView('home') },
      { id: 'nav-activity', label: t('activityTitle'), group: t('groupProject'), shortcut: shortcutLabel('2'), action: () => setActiveView('activity') },
      { id: 'nav-files', label: t('files'), group: t('groupProject'), shortcut: shortcutLabel('3'), action: () => setActiveView('files') },
      { id: 'nav-team', label: t('room'), group: t('groupCollaboration'), shortcut: shortcutLabel('4'), action: () => setActiveView('room') },
      { id: 'nav-conflicts', label: t('conflicts'), group: t('groupCollaboration'), shortcut: shortcutLabel('5'), action: () => setActiveView('conflicts') },
      { id: 'nav-checkpoints', label: t('checkpoints'), group: t('groupRecovery'), action: () => setActiveView('checkpoints') },
      { id: 'nav-trash', label: t('trash'), group: t('groupRecovery'), action: () => setActiveView('trash') },
      { id: 'settings', label: t('settings'), group: t('settings'), shortcut: shortcutLabel(','), action: () => setActiveView('settings') },
    ]
    if (!simulationActive) {
      list.push(
        { id: 'switch-project', label: t('switchProject'), group: t('groupProject'), action: () => void openProjectSwitcher() },
        { id: 'add-project', label: t('addProject'), group: t('groupProject'), action: () => setActiveView('home') },
        { id: 'quick-open', label: t('quickOpen'), group: t('files'), shortcut: shortcutLabel('P'), action: () => void openQuickOpen() },
      )
    }
    if (!simulationActive && activeView === 'files' && selectedFilePath) list.push({ id: 'save-file', label: t('filesSave'), group: t('files'), shortcut: shortcutLabel('S'), action: () => window.dispatchEvent(new Event('cairn:save-current-file')) })
    if (!simulationActive && roomCode) {
      list.push({ id: 'copy-invite', label: t('copyInviteCode'), group: t('room'), action: () => {
        if (permitRealWorkspaceAction('copy-invite')) void window.cairn.copyToClipboard(roomCode)
      } })
      list.push({ id: 'leave-team', label: t('leaveRoom'), group: t('room'), action: () => void handleLeaveRoom() })
    }
    if (!simulationActive && folder) list.push({ id: 'export-snapshot', label: t('exportSnapshot'), group: t('exportPR'), action: () => void handleExportSnapshot() })
    if (!simulationActive && roomCode) list.push({ id: 'export-pr', label: t('exportPR'), group: t('exportPR'), action: () => setExportDialogOpen(true) })
    return list
  }, [activeView, folder, handleExportSnapshot, handleLeaveRoom, openProjectSwitcher, openQuickOpen, permitRealWorkspaceAction, roomCode, selectedFilePath, setActiveView, simulationActive, t])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      const key = event.key.toLowerCase()
      const editable = isEditableTarget(event.target)

      if (key === 'p') {
        event.preventDefault()
        void openQuickOpen()
        return
      }
      if (key === 'k' && !editable) {
        event.preventDefault()
        setCommandPaletteOpen(true)
        return
      }
      if (key === ',' && !editable) {
        event.preventDefault()
        setActiveView('settings')
        return
      }
      if (key === 'f' && activeView === 'activity' && !editable) {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('[data-activity-search]')?.focus()
        return
      }
      if (!editable && /^[1-5]$/.test(key)) {
        const viewByKey: Record<string, 'home' | 'activity' | 'files' | 'room' | 'conflicts'> = {
          1: 'home', 2: 'activity', 3: 'files', 4: 'room', 5: 'conflicts',
        }
        event.preventDefault()
        setActiveView(viewByKey[key]!)
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [activeView, openQuickOpen, setActiveView])

  const handleResolveConflict = async (
    opHash: string,
    resolution: 'local' | 'remote' | 'merged',
  ): Promise<void> => {
    if (simulationGate.isSimulationActive()) {
      const conflict = getDemoScenario(hackathonScene).conflicts.find((item) => item.opHash === opHash)
      if (conflict) {
        demoWorkspace.saveFile(conflict.filePath, resolution === 'remote' ? conflict.remoteContent ?? conflict.localContent : conflict.localContent)
        setDemoConflictResolved(true)
        setDemoWorkspaceVersion((version) => version + 1)
      }
      return
    }
    const result = await window.cairn.resolveConflict(opHash, resolution, undefined, dirtyFilePaths)
    if (!result.ok) {
      setToast(normalizeError(result.error, t))
      return
    }
    removeConflict(opHash)
  }

  const enterHackathonMode = (): void => {
    if (dirtyFilePaths.length > 0) {
      setToast({ message: t('conflictDirtyBlocked'), tone: 'error' })
      return
    }
    setViewBeforeHackathon(activeView)
    setHackathonEnabled(true)
    setHackathonMode('live')
    setHackathonScene('ready')
    setDemoWorkspace(createDemoWorkspace('ready'))
    setDemoWorkspaceVersion((version) => version + 1)
    setDemoDirty(false)
    setDemoConflictResolved(false)
  }
  const exitHackathonMode = (): void => {
    setSimulationIsolation(false)
    setHackathonEnabled(false)
    setPresentationMode(false)
    setActiveView(viewBeforeHackathon)
  }
  const demoData = hackathonEnabled && hackathonMode === 'simulation' ? getDemoScenario(hackathonScene) : undefined
  const displayedOps = demoData?.ops ?? ops
  const displayedConflicts = demoData ? demoData.conflicts.filter(() => !demoConflictResolved) : conflicts
  const simulationLocksCurrentView = simulationActive && !['activity', 'conflicts', 'files', 'checkpoints'].includes(activeView)

  return (
    <>
      <div aria-label="Cairn" className={`app-shell${presentationMode ? ' presentation-mode' : ''}`}>
        <Sidebar />
        <main className="app-main">
        <TopBar folder={simulationActive ? 'demo-app' : folder} opCount={displayedOps.length} peerCount={simulationActive ? 0 : peers.length} roomCode={simulationActive ? '' : roomCode} status={status} onSwitchProject={() => void openProjectSwitcher()} />
        <div className="app-content">
          {simulationLocksCurrentView ? <section className="view active demo-isolation-view"><h1 className="view-title">{t('simulation')}</h1><p>{t('demoSimulationNotice')}</p></section> : <>
          {activeView === 'home' && <HomeView />}
          {activeView === 'activity' && (
            <ActivityView
              emptyMessage={lastFolderUnavailable ? t('lastFolderUnavailable') : undefined}
              onReviewConflicts={() => setConflictDialogOpen(true)}
              ops={displayedOps}
              conflicts={displayedConflicts}
              onChangeFolder={async () => setActiveView('home')}
            />
          )}
          {activeView === 'files' && (demoData ? <DemoFilesView key={demoWorkspaceVersion} workspace={demoWorkspace} ops={displayedOps} conflicts={displayedConflicts} onDirtyChange={setDemoDirty} /> : <FilesView />)}
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
          {activeView === 'conflicts' && <ConflictsView conflicts={displayedConflicts} dirtyFilePaths={demoData && demoDirty ? ['src/auth.ts'] : undefined} onResolve={handleResolveConflict} />}
          {activeView === 'checkpoints' && (demoData ? <DemoCheckpointsView key={demoWorkspaceVersion} workspace={demoWorkspace} onWorkspaceChanged={() => setDemoWorkspaceVersion((version) => version + 1)} /> : <CheckpointsView />)}
          {activeView === 'trash' && <TrashView />}
          {activeView === 'settings' && (
            <SettingsView
              onConfigured={setGithubConfigured}
              onShowOnboarding={() => setShowOnboarding(true)}
              onStartHackathonMode={enterHackathonMode}
            />
          )}
          </>}
        </div>
        </main>
      <ExportPRDialog
        defaultTitle={`Cairn ${roomCode}`}
        open={exportDialogOpen && !simulationActive}
        onClose={() => setExportDialogOpen(false)}
        onOpenSettings={() => {
          setExportDialogOpen(false)
          setActiveView('settings')
        }}
        onSubmit={exportPRSubmit}
      />
      <ConflictDialog
        conflicts={displayedConflicts}
        dirtyFilePaths={demoData && demoDirty ? ['src/auth.ts'] : undefined}
        open={conflictDialogOpen}
        onClose={() => setConflictDialogOpen(false)}
        onResolve={handleResolveConflict}
      />
      <Toast message={toast} onDismiss={dismissToast} />
      {hackathonEnabled ? <HackathonController
        mode={hackathonMode}
        presentationMode={presentationMode}
        scene={hackathonScene}
        onExit={exitHackathonMode}
        onModeChange={(mode) => {
          const isSimulation = mode === 'simulation'
          setSimulationIsolation(isSimulation)
          setHackathonMode(mode)
          if (isSimulation) {
            setQuickOpenOpen(false)
            setProjectSwitcherOpen(false)
            setExportDialogOpen(false)
            setConflictDialogOpen(false)
            setDemoWorkspace(createDemoWorkspace(hackathonScene))
            setDemoWorkspaceVersion((version) => version + 1)
            setDemoDirty(false)
            setDemoConflictResolved(false)
            setActiveView('activity')
          }
        }}
        onPresentationChange={setPresentationMode}
        onSceneChange={(scene) => { if (hackathonMode === 'simulation' && demoDirty) { setToast({ message: t('demoDiscardBeforeSceneChange'), tone: 'error' }); return } setHackathonScene(scene); if (hackathonMode === 'simulation') { setDemoWorkspace(createDemoWorkspace(scene)); setDemoWorkspaceVersion((version) => version + 1); setDemoConflictResolved(false); setActiveView(scene === 'conflict' ? 'conflicts' : scene === 'recovery' ? 'checkpoints' : 'activity') } }}
      /> : null}
      <SearchPalette
        emptyLabel={t('noCommandsFound')}
        items={commands}
        open={commandPaletteOpen}
        placeholder={t('commandPalettePlaceholder')}
        title={t('commandPalette')}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(item) => commands.find((command) => command.id === item.id)?.action()}
      />
      <SearchPalette
        emptyLabel={t('noFilesFound')}
        items={(simulationActive ? [] : projectFiles).map((file) => ({
          id: file.path,
          label: file.name,
          detail: file.path.slice(0, Math.max(0, file.path.length - file.name.length)).replace(/\/$/, ''),
          keywords: file.path,
        }))}
        open={quickOpenOpen}
        placeholder={t('quickOpenPlaceholder')}
        title={t('quickOpen')}
        onClose={() => setQuickOpenOpen(false)}
        onSelect={(item) => {
          openFileFromPalette(item.id)
        }}
      />
      <SearchPalette
        emptyLabel={t('noProjectsFound')}
        items={[
          ...(simulationActive ? [] : projects)
            .filter((project) => project.available)
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
            .map((project) => ({ id: project.id, label: project.name, detail: project.path, keywords: project.path })),
          { id: '__add_project__', label: t('addProject'), group: t('groupProject') },
        ]}
        open={projectSwitcherOpen}
        placeholder={t('searchProjects')}
        title={t('switchProject')}
        onClose={() => setProjectSwitcherOpen(false)}
        onSelect={(item) => {
          if (item.id === '__add_project__') {
            setActiveView('home')
            return
          }
          const project = projects.find((entry) => entry.id === item.id)
          if (project) void activateProject(project)
        }}
      />
      </div>
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
