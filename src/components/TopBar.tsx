import { ChevronDown } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { useAppStore, type WatchStatus } from '@/store/appStore'

interface TopBarProps {
  folder: string
  opCount: number
  roomCode: string
  status: WatchStatus
}

const statusKeys: Record<WatchStatus, 'statusIdle' | 'statusWatching' | 'statusStopped'> = {
  idle: 'statusIdle',
  watching: 'statusWatching',
  stopped: 'statusStopped',
}

function getProjectName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Cairn'
}

export function TopBar({ folder, opCount, roomCode, status }: TopBarProps) {
  const { t } = useTranslation()
  const setActiveView = useAppStore((state) => state.setActiveView)

  return (
    <header className="topbar">
      <button
        aria-label={t('switchProject')}
        className="brand"
        title={t('switchProject')}
        type="button"
        onClick={() => setActiveView('home')}
      >
        <span className="brand-name">
          {getProjectName(folder)}
          <ChevronDown aria-hidden="true" className="brand-chevron" size={14} strokeWidth={1.8} />
        </span>
        <span className="project-path" title={folder}>{folder || '—'}</span>
      </button>
      <div className="topbar-spacer" />
      <div className="status-chip" title={t(statusKeys[status])}>
        <span className="status-dot" data-status={status} />
        <span>{t(statusKeys[status])}</span>
        <span className="status-extra">
          <span className="status-separator">·</span>
          {opCount} · {roomCode || t('noRoom')}
        </span>
      </div>
    </header>
  )
}
