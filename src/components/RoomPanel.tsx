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
    <section className="flex h-12 shrink-0 items-center border-b border-border bg-bg-1 px-4">
      {roomCode === '' ? (
        <div className="flex items-center gap-3">
          <Button className="h-9" variant="default" onClick={() => void onCreateRoom()}>
            {t('createRoom')}
          </Button>
          <input
            aria-label={t('roomCode')}
            className="h-9 w-28 rounded-md border border-border bg-bg-2 px-3 text-sm"
            placeholder="Room code"
            maxLength={6}
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
          />
          <Button className="h-9" variant="outline" onClick={() => void handleJoin()}>
            {t('joinRoom')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-text-2">{t('roomCode')}:</span>
          <code className="rounded border border-border bg-bg-2 px-3 py-1 font-mono text-sm tracking-[0.2em] text-text-0">{roomCode}</code>
          <Button aria-label={t('copy')} size="sm" variant="ghost" className="size-8 p-0" onClick={() => void copyRoomCode()}>
            <Copy size={14} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => void onLeaveRoom()}>
            {t('leaveRoom')}
          </Button>
          <Button size="sm" disabled={!githubConfigured} onClick={() => void onExportPR?.()}>{t('exportPR')}</Button>
          {conflictDetected && <Badge variant="outline" className="border-transparent bg-danger/15 text-danger">{t('conflictDetected')}</Badge>}
          <span className="text-sm text-muted-foreground">{t('peers')}:</span>
          {peers.map((peer) => (
            <span key={peer.peerId} className="flex items-center gap-1 text-sm">
              <span className="inline-block size-2 rounded-full bg-peer-1" />
              {peer.peerId.slice(0, 8)}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
