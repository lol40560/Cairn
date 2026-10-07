import { useCallback, useEffect, useRef, useState } from 'react'

import { Users } from 'lucide-react'

import { Toast, type ToastMessage } from '@/components/Toast'
import { DownloadPromptDialog } from '@/components/DownloadPromptDialog'
import { EmptyState } from '@/components/EmptyState'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { derivePrimaryTeamStatus, deriveTeamHealth, formatDiagnostics } from '@/lib/teamHealth'
import { useAppStore } from '@/store/appStore'
import type { IpcResult, PeerInfo, SeederInfo } from '@/types/cairn'

interface RoomViewProps {
  hasOps: boolean
  peers: PeerInfo[]
  roomCode: string
  onCreateRoom(): Promise<void>
  onExportSnapshot(): Promise<void>
  onExportPR(): void
  onJoinRoom(roomCode: string): Promise<void>
  onLeaveRoom(): Promise<void>
}

const peerColors = ['var(--peer-1)', 'var(--peer-2)', 'var(--peer-3)', 'var(--peer-4)', 'var(--peer-5)']

function getPeerTag(peerId: string, isHost: boolean, index: number): 'peerAi' | 'peerLan' | 'peerHost' {
  if (/claude|copilot|cursor|ai/i.test(peerId)) {
    return 'peerAi'
  }

  // 创建者看到的均是来宾；加入者最先发现的连接为创建者，其他连接视为 LAN 队友。
  return !isHost && index === 0 ? 'peerHost' : 'peerLan'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 创建团队成功后立即开始项目分享；创建失败时不尝试分享。 */
// eslint-disable-next-line react-refresh/only-export-components -- 单测复用此交互流程。
export async function createRoomAndStartSharing(
  onCreateRoom: () => Promise<void>,
  startSharing: () => Promise<IpcResult<SeederInfo>>,
): Promise<IpcResult<SeederInfo> | undefined> {
  await onCreateRoom()

  const state = useAppStore.getState()
  if (!state.isHost || state.roomCode === '') {
    return undefined
  }

  const result = await startSharing()
  if (result.ok) {
    state.setIsSharing(true)
    state.setMySnapshotId(result.data.snapshotId)
  }
  return result
}

export function RoomView({
  hasOps,
  peers,
  roomCode,
  onCreateRoom,
  onExportSnapshot,
  onExportPR,
  onJoinRoom,
  onLeaveRoom,
}: RoomViewProps) {
  const { t } = useTranslation()
  const [joinCode, setJoinCode] = useState('')
  const [directAddressInput, setDirectAddressInput] = useState('')
  const [showAdvancedConnection, setShowAdvancedConnection] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exportingSnapshot, setExportingSnapshot] = useState(false)
  const [joining, setJoining] = useState(false)
  const [startingRoom, setStartingRoom] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [reconnectClock, setReconnectClock] = useState(0)
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const canceledDownload = useRef(false)
  const downloadFailureHandled = useRef(false)
  const directAddress = useAppStore((state) => state.directAddress)
  const watchStatus = useAppStore((state) => state.status)
  const conflicts = useAppStore((state) => state.conflicts)
  const ops = useAppStore((state) => state.ops)
  const localEndpoint = useAppStore((state) => state.localEndpoint)
  const joinedByRoomCode = roomCode !== ''
  const joined = joinedByRoomCode || directAddress !== undefined
  const downloadProgress = useAppStore((state) => state.downloadProgress)
  const downloadStatus = useAppStore((state) => state.downloadStatus)
  const downloadTargetDir = useAppStore((state) => state.downloadTargetDir)
  const lastConflictFiles = useAppStore((state) => state.lastConflictFiles)
  const lastDownloadPath = useAppStore((state) => state.lastDownloadPath)
  const isSharing = useAppStore((state) => state.isSharing)
  const isHost = useAppStore((state) => state.isHost)
  const identityMismatches = useAppStore((state) => state.identityMismatches)
  const peerStatuses = useAppStore((state) => state.peerStatuses)
  const pendingAutoDownload = useAppStore((state) => state.pendingAutoDownload)
  const seeders = useAppStore((state) => state.seeders)
  const showDownloadPrompt = useAppStore((state) => state.showDownloadPrompt)
  const connectedPeerCount = peers.filter((peer) => peerStatuses[peer.peerId]?.status !== 'reconnecting' && peerStatuses[peer.peerId]?.status !== 'offline').length
  const resetDownload = useAppStore((state) => state.resetDownload)
  const clearLastDownloadResult = useAppStore((state) => state.clearLastDownloadResult)
  const setDownloadProgress = useAppStore((state) => state.setDownloadProgress)
  const setDownloadStatus = useAppStore((state) => state.setDownloadStatus)
  const setDownloadTargetDir = useAppStore((state) => state.setDownloadTargetDir)
  const setLastDownloadResult = useAppStore((state) => state.setLastDownloadResult)
  const setIsSharing = useAppStore((state) => state.setIsSharing)
  const setDirectAddress = useAppStore((state) => state.setDirectAddress)
  const setIsHost = useAppStore((state) => state.setIsHost)
  const setLocalEndpoint = useAppStore((state) => state.setLocalEndpoint)
  const setMySnapshotId = useAppStore((state) => state.setMySnapshotId)
  const setPendingAutoDownload = useAppStore((state) => state.setPendingAutoDownload)
  const setSeeders = useAppStore((state) => state.setSeeders)
  const setShowDownloadPrompt = useAppStore((state) => state.setShowDownloadPrompt)
  const dismissToast = useCallback(() => setToast(null), [])
  const health = deriveTeamHealth({
    status: watchStatus, roomCode, directAddress, peers, peerStatuses, isHost, isSharing,
    identityMismatchCount: identityMismatches.length, conflicts, ops,
  })
  const primaryHealth = derivePrimaryTeamStatus(health)

  useEffect(() => {
    if (!Object.values(peerStatuses).some((state) => state.status === 'reconnecting')) {
      return
    }
    const updateClock = (): void => setReconnectClock(Date.now())
    updateClock()
    const timer = window.setInterval(updateClock, 1_000)
    return () => window.clearInterval(timer)
  }, [peerStatuses])

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!joined) {
      setSeeders([])
      setIsSharing(false)
      setMySnapshotId(undefined)
      resetDownload()
      return
    }

    let disposed = false
    const loadSeeders = async (): Promise<void> => {
      try {
        const result = await window.cairn.listSeeders()
        if (result.ok && !disposed) {
          setSeeders(result.data)
        }
      } catch (error) {
        console.error('[cairn] 无法读取项目分享列表', error)
      }
    }
    const loadDefaultDirectory = async (): Promise<void> => {
      try {
        const result = await window.cairn.getDefaultDownloadDir()
        if (result.ok && !disposed) {
          setDownloadTargetDir(result.data)
        }
      } catch (error) {
        console.error('[cairn] 无法初始化下载目录', error)
      }
    }

    void loadSeeders()
    void loadDefaultDirectory()
    const pollTimer = window.setInterval(() => void loadSeeders(), 2_000)
    const unsubscribeProgress = window.cairn.onDownloadProgress((progress) => {
      if (!disposed) {
        setDownloadProgress({
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          receivedChunks: progress.receivedChunks,
          totalChunks: progress.totalChunks,
        })
        setDownloadStatus(progress.status)
        if (progress.status === 'failed' && !canceledDownload.current) {
          downloadFailureHandled.current = true
          const isConnectionLost = /连接中断|connection\s+lost/i.test(progress.error ?? '')
          setToast({
            message: isConnectionLost ? t('downloadConnectionLost') : t('downloadChunkTimeout'),
            tone: 'error',
          })
          resetDownload()
        }
      }
    })

    return () => {
      disposed = true
      window.clearInterval(pollTimer)
      unsubscribeProgress()
    }
  }, [joined, resetDownload, setDownloadProgress, setDownloadStatus, setDownloadTargetDir, setIsSharing, setMySnapshotId, setSeeders, t])

  useEffect(() => {
    if (!joinedByRoomCode || !isHost) {
      setLocalEndpoint(undefined)
      return
    }

    let disposed = false
    void window.cairn.getLocalEndpoint().then((result) => {
      if (result.ok && !disposed) {
        setLocalEndpoint(result.data)
      }
    }).catch((error) => console.error('[cairn] 无法读取本机直连地址', error))

    return () => {
      disposed = true
    }
  }, [isHost, joinedByRoomCode, setLocalEndpoint])

  useEffect(() => {
    if (!pendingAutoDownload) return

    const timeout = window.setTimeout(() => {
      setPendingAutoDownload(false)
      setToast({ message: t('downloadPromptTimeout'), tone: 'error' })
    }, 10_000)
    return () => window.clearTimeout(timeout)
  }, [pendingAutoDownload, setPendingAutoDownload, t])

  useEffect(() => {
    if (!pendingAutoDownload || seeders.length === 0 || downloadStatus !== 'idle') return

    setPendingAutoDownload(false)
    setShowDownloadPrompt(true)
  }, [downloadStatus, pendingAutoDownload, seeders, setPendingAutoDownload, setShowDownloadPrompt])

  const handleJoin = async (): Promise<void> => {
    const roomCodeInput = joinCode.replace(/[\s-]/g, '').toUpperCase()
    if (!/^[A-Z2-7\s-]{26,32}$/i.test(roomCodeInput) || roomCodeInput.replace(/[\s-]/g, '').length !== 26) {
      setToast({ message: t('wrongRoom'), tone: 'error' })
      return
    }

    setJoining(true)
    try {
      // 先进入房间，确保 mDNS 与直连都使用同一份邀请码认证。
      await onJoinRoom(roomCodeInput)
      if (useAppStore.getState().roomCode !== roomCodeInput) {
        return
      }

      const directAddressValue = directAddressInput.trim()
      if (!directAddressValue) {
        setPendingAutoDownload(true)
        setJoinCode('')
        return
      }

      const address = directAddressValue.match(/^([\d.]+):(\d+)$/)
      if (!address) {
        setToast({ message: t('invalidRoomCodeOrAddress'), tone: 'error' })
        return
      }

      const host = address[1]
      const port = Number.parseInt(address[2]!, 10)
      const result = await window.cairn.connectToAddress({ host, port, roomCode: roomCodeInput })
      if (!result.ok) {
        setToast({ message: t('authFailed'), tone: 'error' })
        return
      }
      setDirectAddress(`${host}:${port}`)
      setIsHost(false)
      setJoinCode('')
      setDirectAddressInput('')
      setPendingAutoDownload(true)
    } catch (error) {
      console.error('[cairn] 无法建立直接连接', error)
      setToast(normalizeError(error, t))
    } finally {
      setJoining(false)
    }
  }

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(roomCode)
    setCopied(true)
  }

  const handleCopyDiagnostics = async (): Promise<void> => {
    const result = await window.cairn.copyToClipboard(formatDiagnostics(health))
    if (result.ok) setToast({ message: t('diagnosticsCopied') })
    else setToast(normalizeError(result.error, t))
  }

  const handleCopyEndpoint = async (): Promise<void> => {
    if (!localEndpoint) {
      return
    }
    const address = `${localEndpoint.host}:${localEndpoint.port}`
    try {
      await navigator.clipboard.writeText(address)
    } catch {
      const result = await window.cairn.copyToClipboard(address)
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        return
      }
    }
    setCopied(true)
  }

  const handleLeave = async (): Promise<void> => {
    await onLeaveRoom()
    setDirectAddress(undefined)
    setLocalEndpoint(undefined)
  }

  const handleManualRetry = async (peerId: string): Promise<void> => {
    const result = await window.cairn.retryPeer(peerId)
    if (!result.ok) setToast(normalizeError(result.error, t))
  }

  const handleExportSnapshot = async (): Promise<void> => {
    setExportingSnapshot(true)
    try {
      await onExportSnapshot()
    } finally {
      setExportingSnapshot(false)
    }
  }

  const handleStartSharing = async (): Promise<void> => {
    setSharing(true)
    try {
      const result = await window.cairn.startSharing()
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        return
      }
      setIsSharing(true)
      setMySnapshotId(result.data.snapshotId)
    } catch (error) {
      console.error('[cairn] 无法开始项目分享', error)
      setToast(normalizeError(error, t))
    } finally {
      setSharing(false)
    }
  }

  const handleStartRoom = async (): Promise<void> => {
    setStartingRoom(true)
    try {
      const result = await createRoomAndStartSharing(onCreateRoom, () => window.cairn.startSharing())
      if (result && !result.ok) {
        setToast(normalizeError(result.error, t))
      }
    } catch (error) {
      console.error('[cairn] 创建团队后无法开始项目分享', error)
      setToast(normalizeError(error, t))
    } finally {
      setStartingRoom(false)
    }
  }

  const handleStopSharing = async (): Promise<void> => {
    try {
      const result = await window.cairn.stopSharing()
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        return
      }
      setIsSharing(false)
      setMySnapshotId(undefined)
    } catch (error) {
      console.error('[cairn] 无法停止项目分享', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleDownloadConfirm = async (): Promise<void> => {
    const seeder = seeders[0]
    setShowDownloadPrompt(false)
    setPendingAutoDownload(false)
    if (seeder) await handleDownload(seeder)
  }

  const handleDownloadSkip = (): void => {
    setShowDownloadPrompt(false)
    setPendingAutoDownload(false)
  }

  const handleDownload = async (seeder: SeederInfo): Promise<void> => {
    let targetDir = downloadTargetDir
    try {
      if (!targetDir) {
        const defaultDirectory = await window.cairn.getDefaultDownloadDir()
        if (!defaultDirectory.ok) {
          setToast(normalizeError(defaultDirectory.error, t))
          return
        }
        targetDir = defaultDirectory.data
        setDownloadTargetDir(targetDir)
      }

      canceledDownload.current = false
      downloadFailureHandled.current = false
      clearLastDownloadResult()
      setDownloadProgress(undefined)
      setDownloadStatus('waiting-meta')
      const result = await window.cairn.downloadProject({ snapshotId: seeder.snapshotId, targetDir })
      if (canceledDownload.current) {
        return
      }
      if (!result.ok) {
        if (!downloadFailureHandled.current) {
          setToast(normalizeError(result.error, t))
          resetDownload()
        }
        return
      }

      setDownloadStatus('done')
      setToast({
        hint:
          result.data.conflictFiles.length > 0
            ? t('downloadConflictsMsg').replace('{n}', String(result.data.conflictFiles.length))
            : undefined,
        message: t('downloadSuccessMsg')
          .replace('{n}', String(result.data.extractedFiles))
          .replace('{path}', result.data.targetDir),
        tone: 'success',
      })
      setLastDownloadResult(result.data.targetDir, result.data.conflictFiles)
      resetDownload()
    } catch (error) {
      if (!canceledDownload.current) {
        console.error('[cairn] 无法下载项目', error)
        if (!downloadFailureHandled.current) {
          setToast(normalizeError(error, t))
          resetDownload()
        }
      }
    }
  }

  const handleCancelDownload = async (): Promise<void> => {
    canceledDownload.current = true
    try {
      const result = await window.cairn.cancelDownload()
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
      }
    } catch (error) {
      console.error('[cairn] 无法取消项目下载', error)
      setToast(normalizeError(error, t))
    } finally {
      resetDownload()
    }
  }

  const handleChangeTargetDir = async (): Promise<void> => {
    try {
      const result = await window.cairn.selectDownloadFolder()
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        return
      }
      if (result.data) {
        setDownloadTargetDir(result.data)
      }
    } catch (error) {
      console.error('[cairn] 无法选择下载目录', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleOpenFolder = async (): Promise<void> => {
    if (!lastDownloadPath) {
      return
    }
    try {
      const result = await window.cairn.openInFileManager(lastDownloadPath)
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
      }
    } catch (error) {
      console.error('[cairn] 无法打开下载目录', error)
      setToast(normalizeError(error, t))
    }
  }

  const isDownloading = ['waiting-meta', 'downloading', 'verifying', 'extracting'].includes(downloadStatus)
  const receivedBytes = downloadProgress?.receivedBytes ?? 0
  const totalBytes = downloadProgress?.totalBytes ?? 0
  const percent = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : 0
  const downloadStatusText = (() => {
    switch (downloadStatus) {
      case 'waiting-meta':
        return t('downloadWaiting')
      case 'downloading':
        return t('downloadDownloading')
      case 'verifying':
        return t('downloadVerifying')
      case 'extracting':
        return t('downloadExtracting')
      default:
        return ''
    }
  })()

  return (
    <section className="view active">
      <DownloadPromptDialog
        defaultTargetDir={downloadTargetDir}
        open={showDownloadPrompt}
        seeder={seeders[0]}
        onChangeTarget={() => void handleChangeTargetDir()}
        onConfirm={() => void handleDownloadConfirm()}
        onSkip={handleDownloadSkip}
      />
      <div className="view-header">
        <h1 className="view-title">{t('roomTitle')}</h1>
        <span className="view-spacer" />
        {joined && (
          <button className="btn btn-ghost" type="button" onClick={() => void handleLeave()}>
            {t('leaveRoom')}
          </button>
        )}
      </div>

      <section className={`team-health-summary state-${primaryHealth}`} aria-label={t('projectStatus')}>
        <div className="team-health-heading">
          <span aria-hidden="true" className="team-health-dot" />
          <div>
            <strong>{primaryHealth === 'identity-mismatch' ? t('projectMismatch') : primaryHealth === 'offline' ? t('teamOffline') : primaryHealth === 'reconnecting' ? t('reconnecting') : primaryHealth === 'conflict' ? t('attentionRequired') : primaryHealth === 'room-ready' ? t('roomReady') : health.localWatch === 'watching' ? t('statusWatching') : t('watcherStopped')}</strong>
            <p>{health.connection === 'offline' ? t('localChangesTracked') : health.connection === 'reconnecting' ? t('connectedPeers').replace('{n}', String(health.connectedPeerCount)) : health.connection === 'connected' ? t('connectedPeers').replace('{n}', String(health.connectedPeerCount)) : health.connection === 'room-ready' ? t('waitingForTeammates') : health.connection === 'not-in-room' ? t('localOnly') : ''}</p>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleCopyDiagnostics()}>{t('copyDiagnostics')}</button>
      </section>

      {identityMismatches.length > 0 && (
        <div className="identity-warning" role="alert">
          <div className="identity-warning-title">{t('identityMismatchTitle')}</div>
          {identityMismatches.map((mismatch) => (
            <div key={mismatch.peerId} className="identity-warning-row">
              <div className="identity-warning-peer">{mismatch.guestIdentity.projectName}</div>
              <div className="identity-warning-detail">
                <span>{t('identityHost')}: {mismatch.hostIdentity.baseCommit?.slice(0, 7) ?? '—'}</span>
                <span>{t('identityTheirs')}: {mismatch.guestIdentity.baseCommit?.slice(0, 7) ?? '—'}</span>
              </div>
            </div>
          ))}
          <div className="identity-warning-hint">{t('identityMismatchHint')}</div>
        </div>
      )}

      {!joined ? (
        <div className="room-setup">
          <div className="room-setup-primary">
            <p className="room-label">{t('createRoom')}</p>
            <button aria-busy={startingRoom} className="btn btn-primary" disabled={startingRoom} type="button" onClick={() => void handleStartRoom()}>
              {startingRoom ? <Spinner size={12} /> : null}
              {startingRoom ? t('creating') : t('createRoom')}
            </button>
          </div>
          <div className="room-join-panel">
            <p className="room-label">{t('joinTeam')}</p>
            <p className="room-hint">{t('shareRoomHint')}</p>
            <div className="room-actions">
            <input
              aria-label={t('inviteCodeLabel')}
              className="input room-input"
              placeholder={t('inviteCodeLabel')}
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
            />
            <button aria-busy={joining} className="btn" disabled={joinCode.trim() === '' || joining} type="button" onClick={() => void handleJoin()}>
              {joining ? <Spinner size={12} /> : null}
              {joining ? t('joining') : t('joinRoom')}
            </button>
            </div>
            <button
              aria-expanded={showAdvancedConnection}
              className="advanced-connection-toggle"
              type="button"
              onClick={() => setShowAdvancedConnection((value) => !value)}
            >
              {t('advancedConnection')}
            </button>
            {showAdvancedConnection ? (
              <label className="room-advanced-field">
                <span>{t('directAddressLabel')}</span>
                <input
                  aria-label={t('directAddressLabel')}
                  className="input room-input"
                  placeholder={t('directAddressPlaceholder')}
                  value={directAddressInput}
                  onChange={(event) => setDirectAddressInput(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="room-block">
            {joinedByRoomCode ? (
              <>
                <p className="room-label">{t('roomCode')}</p>
                <div className="room-code-row">
                  <code className="room-code">{roomCode}</code>
                  <button className="btn" type="button" onClick={() => void handleCopy()}>
                    {copied ? t('copied') : t('copy')}
                  </button>
                </div>
                <p className="room-hint">{t('shareRoomHint')}</p>
              </>
            ) : (
              <>
                <p className="room-label">{t('directConnection')}</p>
                <p className="room-hint">{t('connectedTo').replace('{address}', directAddress ?? '')}</p>
              </>
            )}
          </div>

          <div className="room-block">
            <p className="room-label">{t('sharingSection')}</p>
            {isDownloading ? (
              <div className="download-progress">
                <div className="download-progress-header">
                  <span>{downloadStatusText}</span>
                  {totalBytes > 0 && <span>{percent}%</span>}
                </div>
                <div className="download-progress-bar">
                  <div className="download-progress-fill" style={{ width: `${percent}%` }} />
                </div>
                {totalBytes > 0 && (
                  <div className="download-progress-meta">
                    {formatBytes(receivedBytes)} / {formatBytes(totalBytes)}
                  </div>
                )}
                <button className="btn btn-ghost" type="button" onClick={() => void handleCancelDownload()}>
                  {t('cancelDownload')}
                </button>
              </div>
            ) : isSharing ? (
              <div className="share-active">
                <div className="share-status">
                  <span aria-hidden="true" className="peer-dot" style={{ background: 'var(--peer-1)' }} />
                  <span>{t('teammatesCanDownload').replace('{n}', String(seeders.length))}</span>
                </div>
                <button className="btn btn-ghost" type="button" onClick={() => void handleStopSharing()}>
                  {t('stopSharing')}
                </button>
              </div>
            ) : isHost ? (
              <div className="sharing-empty">
                <div className="sharing-empty-title">{t('stoppedSharing')}</div>
                <button aria-busy={sharing} className="btn" disabled={sharing} type="button" onClick={() => void handleStartSharing()}>
                  {sharing ? <Spinner size={12} /> : null}
                  {sharing ? t('creating') : t('restartSharing')}
                </button>
              </div>
            ) : seeders.length > 0 ? (
              <div className="download-available">
                {seeders.map((seeder) => (
                  <div key={`${seeder.peerId}:${seeder.snapshotId}`} className="seeder-row">
                    <div className="seeder-info">
                      <div className="seeder-name">{seeder.projectName}</div>
                      <div className="seeder-meta">
                        {t('downloadFrom')
                          .replace('{peer}', seeder.peerId.slice(0, 8))
                          .replace('{size}', formatBytes(seeder.size))}
                      </div>
                    </div>
                    <button className="btn btn-primary" type="button" onClick={() => void handleDownload(seeder)}>
                      {t('download')}
                    </button>
                  </div>
                ))}
                <div className="download-target">
                  <span className="download-target-label">{t('saveTo')}</span>
                  <button
                    className="download-target-path"
                    title={downloadTargetDir}
                    type="button"
                    onClick={() => void handleChangeTargetDir()}
                  >
                    {downloadTargetDir}
                  </button>
                </div>
              </div>
            ) : (
              <EmptyState
                description={t('waitingForHostDesc')}
                icon={Users}
                title={t('waitingForHost')}
              />
            )}
            {lastDownloadPath && (
              <div className="download-result">
                <div className="download-result-title">{t('downloadSuccess')}</div>
                <div className="download-result-path-row">
                  <span className="download-result-label">{t('savedTo')}</span>
                  <button
                    className="download-result-path"
                    title={t('openInFinder')}
                    type="button"
                    onClick={() => void handleOpenFolder()}
                  >
                    {lastDownloadPath}
                  </button>
                </div>
                {lastConflictFiles.length > 0 && (
                  <div className="download-result-conflicts">
                    {t('downloadConflictsMsg').replace('{n}', String(lastConflictFiles.length))}
                  </div>
                )}
                <button className="btn btn-ghost" type="button" onClick={clearLastDownloadResult}>
                  {t('dismiss')}
                </button>
              </div>
            )}
          </div>

          <div className="peers-section">
            <p className="peers-label">{t('people')} · {t('connectedPeers').replace('{n}', String(connectedPeerCount))}</p>
            {peers.length === 0 ? (
              <div className="team-empty">
                <p className="team-empty-title">{t('teamAlone')}</p>
                <p className="team-empty-desc">{t('teamAloneDesc')}</p>
              </div>
            ) : peers.map((peer, index) => {
              const status = peerStatuses[peer.peerId]
              const reconnecting = status?.status === 'reconnecting'
              const offline = status?.status === 'offline'
              const seconds = Math.max(0, Math.ceil(((status?.nextRetryAt ?? reconnectClock) - reconnectClock) / 1_000))
              return (
                <div
                  key={peer.peerId}
                  className={`peer-row${reconnecting ? ' peer-reconnecting' : ''}${offline ? ' peer-offline' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className={`peer-dot${reconnecting ? ' dot-reconnecting' : ''}${offline ? ' dot-offline' : ''}`}
                    style={reconnecting || offline ? undefined : { background: peerColors[index % peerColors.length] }}
                  />
                  <span className="peer-name">{peer.peerId.slice(0, 8)}</span>
                  <span className="peer-meta">{t(getPeerTag(peer.peerId, isHost, index))}</span>
                  <span className="peer-meta">{peer.host}:{peer.port}</span>
                  {reconnecting && (
                    <span className="peer-status">{t('reconnectingIn').replace('{s}', String(seconds))}</span>
                  )}
                  {offline && (
                    <span className="peer-status peer-status-offline">
                      {t('offline')} · <button type="button" onClick={() => void handleManualRetry(peer.peerId)}>{t('retry')}</button>
                    </span>
                  )}
                  {status?.status === 'connected' && <span className="peer-status peer-status-connected">{t('peerConnected')}</span>}
                </div>
              )
            })}
            {isHost && (
              <div className="direct-connection">
                <p className="direct-connection-label">{t('directConnection')}</p>
                <div className="direct-connection-row">
                  <code className="direct-connection-address">
                    {localEndpoint ? `${localEndpoint.host}:${localEndpoint.port}` : '—'}
                  </code>
                  <button className="btn btn-ghost" disabled={!localEndpoint} type="button" onClick={() => void handleCopyEndpoint()}>
                    {copied ? t('copied') : t('copy')}
                  </button>
                </div>
                <p className="direct-connection-hint">{t('directConnectionHint')}</p>
              </div>
            )}
          </div>
          <div className="room-block room-exports">
            <p className="room-label">{t('exports')}</p>
            <div className="room-actions">
              <button className="btn" disabled={exportingSnapshot} type="button" onClick={() => void handleExportSnapshot()}>
                {t('exportSnapshot')}
              </button>
              <button className="btn btn-primary" disabled={!hasOps} type="button" onClick={onExportPR}>
                {t('exportPR')}
              </button>
            </div>
          </div>
        </>
      )}
      <Toast message={toast} onDismiss={dismissToast} />
    </section>
  )
}
