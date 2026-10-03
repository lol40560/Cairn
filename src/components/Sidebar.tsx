import { Activity, AlertTriangle, FileText, Home, Settings, Trash2, Users } from 'lucide-react'

import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales'
import { useAppStore, type ViewType } from '@/store/appStore'

interface NavItem {
  id: ViewType
  icon: typeof Home
  labelKey: TranslationKey
}

const projectItems: NavItem[] = [
  { icon: Home, id: 'home', labelKey: 'home' },
  { icon: Activity, id: 'activity', labelKey: 'activity' },
  { icon: FileText, id: 'files', labelKey: 'files' },
]

const collaborationItems: NavItem[] = [
  { icon: Users, id: 'room', labelKey: 'room' },
  { icon: AlertTriangle, id: 'conflicts', labelKey: 'conflicts' },
]

const recoveryItems: NavItem[] = [
  { icon: Trash2, id: 'trash', labelKey: 'trash' },
]

export function Sidebar({ onOpenSettings }: { onOpenSettings(): void }) {
  const { t } = useTranslation()
  const activeView = useAppStore((state) => state.activeView)
  const conflicts = useAppStore((state) => state.conflicts)
  const setActiveView = useAppStore((state) => state.setActiveView)

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon
    const label = t(item.labelKey)

    return (
      <button
        key={item.id}
        aria-current={activeView === item.id ? 'page' : undefined}
        className={`sidebar-nav-item ${activeView === item.id ? 'active' : ''}`}
        type="button"
        onClick={() => setActiveView(item.id)}
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        <span>{label}</span>
        {item.id === 'conflicts' && conflicts.length > 0 ? (
          <span aria-label={`${conflicts.length} ${label}`} className="sidebar-badge">{conflicts.length}</span>
        ) : null}
      </button>
    )
  }

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-text">Cairn</span>
      </div>
      <nav aria-label={t('workspaceNavigation')} className="sidebar-nav">
        <div className="sidebar-group">
          <p className="sidebar-group-title">{t('groupProject')}</p>
          {projectItems.map(renderNavItem)}
        </div>
        <div className="sidebar-group">
          <p className="sidebar-group-title">{t('groupCollaboration')}</p>
          {collaborationItems.map(renderNavItem)}
        </div>
        <div className="sidebar-group">
          <p className="sidebar-group-title">{t('groupRecovery')}</p>
          {recoveryItems.map(renderNavItem)}
        </div>
      </nav>
      <div className="sidebar-bottom">
        <button className="sidebar-nav-item" type="button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
          <span>{t('settings')}</span>
        </button>
      </div>
    </aside>
  )
}
