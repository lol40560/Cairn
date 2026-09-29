import { useTranslation } from '@/i18n'
import type { WatchStatus } from '@/store/appStore'

import { Logo } from './Logo'

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

  return (
    <header className="topbar">
      <Logo size={20} className="shrink-0" />
      <div className="project">
        <span className="project-name">{getProjectName(folder)}</span>
        <span className="project-path" title={folder}>{folder || '—'}</span>
      </div>
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
