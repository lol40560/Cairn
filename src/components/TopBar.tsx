import { useMemo, useState } from 'react'

import { AlertTriangle, ChevronDown, Copy, Users } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { derivePrimaryTeamStatus, deriveTeamHealth, formatDiagnostics, type PrimaryTeamStatus } from '@/lib/teamHealth'
import { useAppStore, type WatchStatus } from '@/store/appStore'

interface TopBarProps { folder: string; opCount: number; peerCount?: number; roomCode: string; status: WatchStatus; onSwitchProject?(): void }

function getProjectName(folder: string): string { return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Cairn' }

function primaryCopy(primary: PrimaryTeamStatus, t: ReturnType<typeof useTranslation>['t'], peerCount: number, conflictCount: number): string {
  switch (primary) {
    case 'watcher-stopped': return t('watcherStopped')
    case 'identity-mismatch': return t('projectMismatch')
    case 'offline': return t('teamOffline')
    case 'conflict': return t('unresolved').replace('{n}', String(conflictCount))
    case 'reconnecting': return `${t('reconnecting')} · ${t('connectedPeers').replace('{n}', String(peerCount))}`
    case 'connected': return `${t('connected')} · ${t('connectedPeers').replace('{n}', String(peerCount))}`
    case 'room-ready': return t('roomReady')
    case 'watching': return t('statusWatching')
    default: return t('localOnly')
  }
}

function relativeTime(timestamp: number | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return t('justNow')
  const minutes = Math.floor(seconds / 60)
  return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
}

/** 只展示目前能證明的連線／監控資訊；不把 Connected 說成同步完成。 */
export function TopBar({ folder, roomCode, status, onSwitchProject }: TopBarProps) {
  const { t } = useTranslation()
  const setActiveView = useAppStore((state) => state.setActiveView)
  const peers = useAppStore((state) => state.peers)
  const peerStatuses = useAppStore((state) => state.peerStatuses)
  const isHost = useAppStore((state) => state.isHost)
  const isSharing = useAppStore((state) => state.isSharing)
  const directAddress = useAppStore((state) => state.directAddress)
  const identityMismatches = useAppStore((state) => state.identityMismatches)
  const conflicts = useAppStore((state) => state.conflicts)
  const ops = useAppStore((state) => state.ops)
  const [showStatusDetails, setShowStatusDetails] = useState(false)
  const [copied, setCopied] = useState(false)
  const health = useMemo(() => deriveTeamHealth({ status, roomCode, directAddress, peers, peerStatuses, isHost, isSharing, identityMismatchCount: identityMismatches.length, conflicts, ops }), [conflicts, directAddress, identityMismatches.length, isHost, isSharing, ops, peerStatuses, peers, roomCode, status])
  const primary = derivePrimaryTeamStatus(health)
  const peerCount = health.connectedPeerCount
  const primaryLabel = primaryCopy(primary, t, peerCount, health.unresolvedConflictCount)
  const copyDiagnostics = async (): Promise<void> => {
    const result = await window.cairn.copyToClipboard(formatDiagnostics(health, roomCode))
    if (result.ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1_500) }
  }

  return (
    <header className="topbar">
      <button aria-label={t('switchProject')} className="brand" title={t('switchProject')} type="button" onClick={() => onSwitchProject ? onSwitchProject() : setActiveView('home')}>
        <span className="brand-name"><span className="brand-name-text">{getProjectName(folder)}</span><ChevronDown aria-hidden="true" className="brand-chevron" size={14} strokeWidth={1.8} /></span>
        <span className="project-path" title={folder}>{folder || '—'}</span>
      </button>
      <div className="topbar-spacer" />
      <button aria-expanded={showStatusDetails} className={`status-chip primary-${primary}`} title={primaryLabel} type="button" onClick={() => setShowStatusDetails((value) => !value)}>
        <span aria-hidden="true" className="status-dot" data-status={primary} />
        <span>{primaryLabel}</span>
      </button>
      {showStatusDetails ? (
        <section aria-label={t('projectStatus')} className="status-popover" role="dialog">
          <h2>{t('projectStatus')}</h2>
          <div><span>{t('localProject')}</span><strong>{health.localWatch === 'watching' ? t('statusWatching') : t('watcherStopped')}</strong></div>
          <div><span>{t('teamStatus')}</span><strong>{primaryCopy(health.connection === 'not-in-room' ? 'local-only' : health.connection === 'room-ready' ? 'room-ready' : health.connection, t, peerCount, health.unresolvedConflictCount)}</strong></div>
          {health.connection !== 'not-in-room' ? <div><span>{t('peers')}</span><strong>{t('connectedPeers').replace('{n}', String(peerCount))}</strong></div> : null}
          <div><span>{t('projectIdentity')}</span><strong>{health.identityMismatchCount ? t('projectMismatch') : t('matching')}</strong></div>
          <div><span>{t('conflictsTitle')}</span><strong>{health.unresolvedConflictCount ? t('unresolved').replace('{n}', String(health.unresolvedConflictCount)) : t('none')}</strong></div>
          {health.lastLocalActivityAt || health.lastRemoteActivityAt ? <div><span>{t('lastActivity')}</span><strong>{relativeTime(Math.max(health.lastLocalActivityAt ?? 0, health.lastRemoteActivityAt ?? 0), t)}</strong></div> : null}
          {roomCode ? <div><span>{t('roomCode')}</span><code>{roomCode}</code></div> : null}
          <div className="status-popover-actions">
            {health.connection !== 'not-in-room' ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setShowStatusDetails(false); setActiveView('room') }}><Users size={14} />{t('roomTitle')}</button> : null}
            {health.unresolvedConflictCount ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setShowStatusDetails(false); setActiveView('conflicts') }}><AlertTriangle size={14} />{t('reviewConflict')}</button> : null}
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copyDiagnostics()}><Copy size={14} />{copied ? t('diagnosticsCopied') : t('copyDiagnostics')}</button>
          </div>
        </section>
      ) : null}
    </header>
  )
}
