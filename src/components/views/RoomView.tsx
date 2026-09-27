import { useEffect, useState } from 'react'

import { useTranslation } from '@/i18n'
import type { PeerInfo } from '@/types/cairn'

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

function getPeerTag(peerId: string, index: number): 'peerAi' | 'peerLan' | 'peerHost' {
  if (/claude|copilot|cursor|ai/i.test(peerId)) {
    return 'peerAi'
  }

  return index === 0 ? 'peerHost' : 'peerLan'
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
  const joined = roomCode !== ''

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleJoin = async (): Promise<void> => {
    await onJoinRoom(joinCode.trim().toUpperCase())
    setJoinCode('')
  }

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(roomCode)
    setCopied(true)
  }

  const handleExportSnapshot = async (): Promise<void> => {
    setExportingSnapshot(true)
    try {
      await onExportSnapshot()
    } finally {
      setExportingSnapshot(false)
    }
  }

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('roomTitle')}</h1>
        <span className="view-spacer" />
        {joined && (
          <button className="btn btn-ghost" type="button" onClick={() => void onLeaveRoom()}>
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
              maxLength={6}
              placeholder={t('roomCode')}
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
            <p className="room-label">{t('roomCode')}</p>
            <div className="room-code-row">
              <code className="room-code">{roomCode}</code>
              <button className="btn" type="button" onClick={() => void handleCopy()}>
                {copied ? t('copied') : t('copy')}
              </button>
            </div>
            <p className="room-hint">{t('shareRoomHint')}</p>
          </div>

          <div className="peers-section">
            <p className="peers-label">{t('connectedPeers').replace('{n}', String(peers.length))}</p>
            {peers.map((peer, index) => (
              <div key={peer.peerId} className="peer-row">
                <span aria-hidden="true" className="peer-dot" style={{ background: peerColors[index % peerColors.length] }} />
                <span className="peer-name">{peer.peerId.slice(0, 8)}</span>
                <span className="peer-meta">{t(getPeerTag(peer.peerId, index))}</span>
                <span className="peer-meta">{peer.host}:{peer.port}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
