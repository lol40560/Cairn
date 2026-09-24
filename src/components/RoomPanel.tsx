import { useState } from 'react'
import { Copy } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n'
import type { PeerInfo } from '@/types/cairn'

interface RoomPanelProps {
  conflictDetected: boolean
  onCreateRoom(): Promise<void>
  onJoinRoom(roomCode: string): Promise<void>
  onLeaveRoom(): Promise<void>
  peers: PeerInfo[]
  roomCode: string
  githubConfigured?: boolean
  onExportPR?(): Promise<void>
}

const peerColors = ['bg-peer-1', 'bg-peer-2', 'bg-peer-3', 'bg-peer-4', 'bg-peer-5']

export function RoomPanel({
  conflictDetected,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  peers,
  roomCode,
  githubConfigured = false,
  onExportPR,
}: RoomPanelProps) {
  const { t } = useTranslation()
  const [joinCode, setJoinCode] = useState('')

  const handleJoin = async (): Promise<void> => {
    await onJoinRoom(joinCode.trim().toUpperCase())
    setJoinCode('')
  }

  const copyRoomCode = async (): Promise<void> => {
    await navigator.clipboard?.writeText(roomCode)
  }

  return (
    <section className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-4">
      {roomCode === '' ? (
        <>
          <Button className="h-9" size="sm" variant="default" onClick={() => void onCreateRoom()}>
            {t('createRoom')}
          </Button>
          <input
            aria-label={t('roomCode')}
            className="h-9 w-40 rounded-md border border-border bg-bg-2 px-3 font-mono text-sm tracking-widest text-text-0 outline-none placeholder:text-text-2 focus-visible:ring-2 focus-visible:ring-ring"
            maxLength={6}
            placeholder="房间码"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
          />
          <Button className="h-9" size="sm" variant="outline" onClick={() => void handleJoin()}>
            {t('joinRoom')}
          </Button>
        </>
      ) : (
        <>
          <span className="text-xs text-text-2">{t('roomCode')}</span>
          <code className="rounded-md border border-primary/20 bg-primary/10 px-3 py-1 font-mono text-sm tracking-[0.2em] text-primary">{roomCode}</code>
          <Button aria-label={t('copy')} size="sm" variant="ghost" className="size-9 p-0" onClick={() => void copyRoomCode()}>
            <Copy size={14} />
          </Button>
          <Button className="h-9" size="sm" variant="outline" onClick={() => void onLeaveRoom()}>
            {t('leaveRoom')}
          </Button>
          <Button className="h-9" size="sm" variant="default" disabled={!githubConfigured} onClick={() => void onExportPR?.()}>{t('exportPR')}</Button>
          {conflictDetected && <Badge variant="outline" className="border-transparent bg-danger/15 text-danger">{t('conflictDetected')}</Badge>}
          {peers.length > 0 && <span className="text-xs text-text-2">{t('peers')}:</span>}
          {peers.map((peer, index) => (
            <span key={peer.peerId} className="flex items-center gap-1 text-xs text-text-1">
              <span className={`inline-block size-2 rounded-full ${peerColors[index % peerColors.length]}`} />
              {peer.peerId.slice(0, 8)}
            </span>
          ))}
        </>
      )}
    </section>
  )
}
