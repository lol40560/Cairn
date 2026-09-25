import { useEffect, useState } from 'react'

import type { PeerInfo } from '@/types/cairn'

interface RoomViewProps {
  hasOps: boolean
  peers: PeerInfo[]
  roomCode: string
  onCreateRoom(): Promise<void>
  onExportPR(): void
  onJoinRoom(roomCode: string): Promise<void>
  onLeaveRoom(): Promise<void>
}

const peerColors = ['var(--peer-1)', 'var(--peer-2)', 'var(--peer-3)', 'var(--peer-4)', 'var(--peer-5)']

function getPeerTag(peerId: string, index: number): 'AI' | 'LAN' | 'host' {
  if (/claude|copilot|cursor|ai/i.test(peerId)) {
    return 'AI'
  }

  return index === 0 ? 'host' : 'LAN'
}

export function RoomView({
  hasOps,
  peers,
  roomCode,
  onCreateRoom,
  onExportPR,
  onJoinRoom,
  onLeaveRoom,
}: RoomViewProps) {
  const [joinCode, setJoinCode] = useState('')
  const [copied, setCopied] = useState(false)
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

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">Room</h1>
        <span className="view-spacer" />
        {joined && (
          <button className="btn btn-ghost" type="button" onClick={() => void onLeaveRoom()}>
            Leave
          </button>
        )}
        {joined && (
          <button className="btn btn-primary" disabled={!hasOps} type="button" onClick={onExportPR}>
            Export PR
          </button>
        )}
      </div>

      {!joined ? (
        <div className="room-block">
          <p className="room-label">Create or join</p>
          <div className="room-actions">
            <button className="btn btn-primary" type="button" onClick={() => void onCreateRoom()}>
              Create Room
            </button>
            <input
              aria-label="Room code"
              className="input room-input"
              maxLength={6}
              placeholder="Room code"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
            />
            <button className="btn" disabled={joinCode.trim() === ''} type="button" onClick={() => void handleJoin()}>
              Join
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="room-block">
            <p className="room-label">Room code</p>
            <div className="room-code-row">
              <code className="room-code">{roomCode}</code>
              <button className="btn" type="button" onClick={() => void handleCopy()}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="room-hint">Share this code with peers on your local network.</p>
          </div>

          <div className="peers-section">
            <p className="peers-label">Connected · {peers.length}</p>
            {peers.map((peer, index) => (
              <div key={peer.peerId} className="peer-row">
                <span aria-hidden="true" className="peer-dot" style={{ background: peerColors[index % peerColors.length] }} />
                <span className="peer-name">{peer.peerId.slice(0, 8)}</span>
                <span className="peer-meta">{getPeerTag(peer.peerId, index)}</span>
                <span className="peer-meta">{peer.host}:{peer.port}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
