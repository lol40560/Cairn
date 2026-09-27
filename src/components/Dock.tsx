import { Activity, Settings, Trash2, TriangleAlert, UsersRound } from 'lucide-react'

import { useTranslation } from '@/i18n'
import type { ActiveView } from '@/store/appStore'

interface DockProps {
  activeView: ActiveView
  conflictCount: number
  onOpenSettings(): void
  onViewChange(view: ActiveView): void
}

const viewItems = [
  { icon: Activity, labelKey: 'activity', view: 'activity' },
  { icon: UsersRound, labelKey: 'room', view: 'room' },
  { icon: TriangleAlert, labelKey: 'conflicts', view: 'conflicts' },
  { icon: Trash2, labelKey: 'trash', view: 'trash' },
] as const

export function Dock({ activeView, conflictCount, onOpenSettings, onViewChange }: DockProps) {
  const { t } = useTranslation()

  return (
    <div className="dock-anchor">
      <nav aria-label={t('workspaceNavigation')} className="dock">
        {viewItems.map(({ icon: Icon, labelKey, view }) => {
          const label = t(labelKey)

          return (
          <button
            key={view}
            aria-current={activeView === view ? 'page' : undefined}
            aria-label={label}
            className={`dock-item ${activeView === view ? 'active' : ''}`}
            title={label}
            type="button"
            onClick={() => onViewChange(view)}
          >
            <span className="dock-icon"><Icon size={16} strokeWidth={1.8} /></span>
            <span className="dock-label">{label}</span>
            {view === 'conflicts' && conflictCount > 0 && <span className="dock-badge" />}
          </button>
          )
        })}
        <span aria-hidden="true" className="dock-separator" />
        <button aria-label={t('settings')} className="dock-item" title={t('settings')} type="button" onClick={onOpenSettings}>
          <span className="dock-icon"><Settings size={16} strokeWidth={1.8} /></span>
          <span className="dock-label">{t('settings')}</span>
        </button>
      </nav>
    </div>
  )
}
