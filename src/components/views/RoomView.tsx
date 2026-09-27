import { useCallback, useEffect, useRef, useState } from 'react'

import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { PeerInfo, SeederInfo } from '@/types/cairn'

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
  const [copied, setCopied] = useState(false)
  const [exportingSnapshot, setExportingSnapshot] = useState(false)
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const canceledDownload = useRef(false)
  const directAddress = useAppStore((state) => state.directAddress)
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
  const seeders = useAppStore((state) => state.seeders)
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
  const setSeeders = useAppStore((state) => state.setSeeders)
  const dismissToast = useCallback(() => setToast(null), [])

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
      }
    })

    return () => {
      disposed = true
      window.clearInterval(pollTimer)
      unsubscribeProgress()
    }
  }, [joined, resetDownload, setDownloadProgress, setDownloadStatus, setDownloadTargetDir, setIsSharing, setMySnapshotId, setSeeders])

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

  const handleJoin = async (): Promise<void> => {
    const value = joinCode.trim()
    if (/^[A-Z0-9]{6}$/i.test(value)) {
      await onJoinRoom(value.toUpperCase())
      setJoinCode('')
      return
    }

    const address = value.match(/^([\d.]+):(\d+)$/)
    if (!address) {
      setToast({ message: t('invalidRoomCodeOrAddress'), tone: 'error' })
      return
    }

    const host = address[1]
    const port = Number.parseInt(address[2]!, 10)
    try {
      const result = await window.cairn.connectToAddress({ host, port })
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        return
      }
      setDirectAddress(`${host}:${port}`)
      setIsHost(false)
      setJoinCode('')
    } catch (error) {
      console.error('[cairn] 无法建立直接连接', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(roomCode)
    setCopied(true)
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

  const handleExportSnapshot = async (): Promise<void> => {
    setExportingSnapshot(true)
    try {
      await onExportSnapshot()
    } finally {
      setExportingSnapshot(false)
    }
  }

  const handleStartSharing = async (): Promise<void> => {
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
      clearLastDownloadResult()
      setDownloadProgress(undefined)
      setDownloadStatus('waiting-meta')
      const result = await window.cairn.downloadProject({ snapshotId: seeder.snapshotId, targetDir })
      if (canceledDownload.current) {
        return
      }
      if (!result.ok) {
        setToast(normalizeError(result.error, t))
        resetDownload()
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
        setToast(normalizeError(error, t))
        resetDownload()
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
      <div className="view-header">
        <h1 className="view-title">{t('roomTitle')}</h1>
        <span className="view-spacer" />
        {joined && (
          <button className="btn btn-ghost" type="button" onClick={() => void handleLeave()}>
            {t('leaveRoom')}
          </button>
        )}
        {joined && (
          <button className="btn btn-ghost" disabled={exportingSnapshot} type="button" onClick={() => void handleExportSnapshot()}>
            {t('exportSnapshot')}
          </button>
        )}
        {joined && (
          <button className="btn btn-primary" disabled={!hasOps} type="button" onClick={onExportPR}>
            {t('exportPR')}
          </button>
        )}
      </div>

      {!joined ? (
        <div className="room-block">
          <p className="room-label">{t('createOrJoin')}</p>
          <div className="room-actions">
            <button className="btn btn-primary" type="button" onClick={() => void onCreateRoom()}>
              {t('createRoom')}
            </button>
            <input
              aria-label={t('roomCode')}
              className="input room-input"
              placeholder={t('roomCodeOrAddress')}
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
            />
            <button className="btn" disabled={joinCode.trim() === ''} type="button" onClick={() => void handleJoin()}>
              {t('joinRoom')}
            </button>
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
                  <span>{t('sharingActive').replace('{n}', String(seeders.length))}</span>
                </div>
                <button className="btn btn-ghost" type="button" onClick={() => void handleStopSharing()}>
                  {t('stopSharing')}
                </button>
              </div>
            ) : isHost ? null : seeders.length > 0 ? (
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
              <div className="sharing-empty">
                <div className="sharing-empty-title">{t('waitingForHost')}</div>
                <div className="sharing-empty-desc">{t('waitingForHostDesc')}</div>
              </div>
            )}
            {isHost && !isSharing && seeders.length === 0 && !isDownloading && (
              <button className="btn" type="button" onClick={() => void handleStartSharing()}>
                {t('startSharing')}
              </button>
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
            <p className="peers-label">{t('connectedPeers').replace('{n}', String(peers.length))}</p>
            {peers.length === 0 ? (
              <div className="team-empty">
                <p className="team-empty-title">{t('teamAlone')}</p>
                <p className="team-empty-desc">{t('teamAloneDesc')}</p>
              </div>
            ) : peers.map((peer, index) => (
              <div key={peer.peerId} className="peer-row">
                <span aria-hidden="true" className="peer-dot" style={{ background: peerColors[index % peerColors.length] }} />
                <span className="peer-name">{peer.peerId.slice(0, 8)}</span>
                <span className="peer-meta">{t(getPeerTag(peer.peerId, isHost, index))}</span>
                <span className="peer-meta">{peer.host}:{peer.port}</span>
              </div>
            ))}
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
        </>
      )}
      <Toast message={toast} onDismiss={dismissToast} />
    </section>
  )
}
