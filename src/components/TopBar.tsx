import { useEffect, useMemo, useRef, useState } from 'react'

import { AlertTriangle, Check, ChevronDown, Copy, FolderOpen, Home, Search, Users, X } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { useProfile } from '@/lib/profile'
import { derivePrimaryTeamStatus, deriveTeamHealth, formatDiagnostics, type PrimaryTeamStatus } from '@/lib/teamHealth'
import { useAppStore, type WatchStatus } from '@/store/appStore'
import type { AvailableProjectEntry } from '@/types/cairn'

interface TopBarProps {
  folder: string
  /** Deprecated display inputs kept for compatibility with older callers. */
  opCount?: number
  peerCount?: number
  roomCode: string
  status: WatchStatus
  onOpenCommands?(): void
  onOpenProject?(project: AvailableProjectEntry): void
  onSwitchProject?(): void
}

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
export function TopBar({ folder, roomCode, status, onOpenCommands, onOpenProject, onSwitchProject }: TopBarProps) {
  const { t } = useTranslation()
  const setActiveView = useAppStore((state) => state.setActiveView)
  const projects = useAppStore((state) => state.projects)
  const peers = useAppStore((state) => state.peers)
  const peerStatuses = useAppStore((state) => state.peerStatuses)
  const isHost = useAppStore((state) => state.isHost)
  const isSharing = useAppStore((state) => state.isSharing)
  const directAddress = useAppStore((state) => state.directAddress)
  const identityMismatches = useAppStore((state) => state.identityMismatches)
  const conflicts = useAppStore((state) => state.conflicts)
  const ops = useAppStore((state) => state.ops)
  const [showStatusDetails, setShowStatusDetails] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showProjectMenu, setShowProjectMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const projectSwitcherRef = useRef<HTMLDivElement>(null)
  const { profile, setProfile } = useProfile()
  const [profileDraft, setProfileDraft] = useState(profile)
  const health = useMemo(() => deriveTeamHealth({ status, roomCode, directAddress, peers, peerStatuses, isHost, isSharing, identityMismatchCount: identityMismatches.length, conflicts, ops }), [conflicts, directAddress, identityMismatches.length, isHost, isSharing, ops, peerStatuses, peers, roomCode, status])
  const primary = derivePrimaryTeamStatus(health)
  const peerCount = health.connectedPeerCount
  const primaryLabel = primaryCopy(primary, t, peerCount, health.unresolvedConflictCount)
  const recentProjects = useMemo(() => [...projects.filter((project) => project.available)].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt), [projects])

  useEffect(() => {
    if (!showProjectMenu) return
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!projectSwitcherRef.current?.contains(event.target as Node)) setShowProjectMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowProjectMenu(false)
    }
    window.addEventListener('pointerdown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showProjectMenu])

  const showProjectsHome = (): void => {
    setShowProjectMenu(false)
    if (onSwitchProject) onSwitchProject()
    else setActiveView('projects')
  }

  const openProject = (project: AvailableProjectEntry): void => {
    setShowProjectMenu(false)
    onOpenProject?.(project)
  }

  const copyDiagnostics = async (): Promise<void> => {
    const result = await window.cairn.copyToClipboard(formatDiagnostics(health))
    if (result.ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1_500) }
  }

  return (
    <header className="topbar">
      <div className="topbar-logo" aria-label="Cairn">Cairn</div>
      <div className="topbar-spacer" />
      <div className="project-switcher" ref={projectSwitcherRef}>
        <button aria-expanded={showProjectMenu} aria-haspopup="menu" aria-label={t('switchProject')} className="brand" title={t('switchProject')} type="button" onClick={() => { setShowProfile(false); setShowStatusDetails(false); setShowProjectMenu((open) => !open) }}>
          <span className="brand-name">{folder ? null : <FolderOpen aria-hidden="true" size={14} />}<span className="brand-name-text">{folder ? getProjectName(folder) : t('projectsTitle')}</span><ChevronDown aria-hidden="true" className={`brand-chevron${showProjectMenu ? ' open' : ''}`} size={14} strokeWidth={1.8} /></span>
          <span className="project-path" title={folder}>{folder || t('chooseProjectHint')}</span>
        </button>
        {showProjectMenu ? (
          <section aria-label={t('switchProject')} className="project-dropdown" role="menu">
            <button className="project-dropdown-item" role="menuitem" type="button" onClick={showProjectsHome}><Home aria-hidden="true" size={16}/><span>{t('home')}</span></button>
            <div className="project-dropdown-separator" />
            <p className="project-dropdown-label">{t('recentProjects')}</p>
            {recentProjects.length > 0 ? recentProjects.map((project) => (
              <button className="project-dropdown-item" key={project.id} role="menuitem" type="button" onClick={() => openProject(project)}>
                <FolderOpen aria-hidden="true" size={16}/><span><strong>{project.name}</strong><small>{project.path}</small></span>{folder === project.path ? <Check aria-label="Current project" size={15}/> : null}
              </button>
            )) : <p className="project-dropdown-empty">{t('noProjects')}</p>}
          </section>
        ) : null}
      </div>
      {onOpenCommands ? (
        <button aria-label="Search" className="topbar-command" data-tour="search" title="Search" type="button" onClick={() => { setShowProjectMenu(false); setShowProfile(false); setShowStatusDetails(false); onOpenCommands() }}>
          <Search aria-hidden="true" size={17} />
        </button>
      ) : null}
      <button aria-expanded={showStatusDetails} className={`status-chip primary-${primary}`} title={primaryLabel} type="button" onClick={() => { setShowProjectMenu(false); setShowProfile(false); setShowStatusDetails((value) => !value) }}>
        <span aria-hidden="true" className="status-dot" data-status={primary} />
        <span>{ops.length} changes saved today</span>
      </button>
      <button
        aria-expanded={showProfile}
        aria-label={`${profile.displayName} profile`}
        className="topbar-avatar"
        type="button"
        onClick={() => {
          setShowProjectMenu(false)
          setShowStatusDetails(false)
          setProfileDraft(profile)
          setShowProfile((value) => !value)
        }}
      >
        {profile.initials}
      </button>
      {showProfile ? (
        <section aria-label="Profile settings" className="profile-popover" role="dialog">
          <header>
            <div><h2>Profile</h2><p>Personalize how you appear in Cairn.</p></div>
            <button aria-label="Close profile" className="profile-close" type="button" onClick={() => setShowProfile(false)}><X aria-hidden="true" size={16} /></button>
          </header>
          <label className="field">
            <span className="field-label">Display name</span>
            <input className="input" maxLength={60} value={profileDraft.displayName} onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Initials</span>
            <input className="input profile-initials-input" maxLength={2} value={profileDraft.initials} onChange={(event) => setProfileDraft((current) => ({ ...current, initials: event.target.value.toUpperCase() }))} />
          </label>
          <button className="btn btn-primary profile-save" disabled={!profileDraft.displayName.trim()} type="button" onClick={() => { setProfile(profileDraft); setShowProfile(false) }}>Save profile</button>
        </section>
      ) : null}
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
