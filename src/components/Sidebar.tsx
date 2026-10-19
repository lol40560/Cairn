import { Activity, AlertTriangle, Bookmark, FileText, Home, Settings, Trash2, Users } from 'lucide-react'

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
  { icon: Bookmark, id: 'checkpoints', labelKey: 'checkpoints' },
  { icon: Trash2, id: 'trash', labelKey: 'trash' },
]

export function Sidebar() {
  const { t } = useTranslation()
  const activeView = useAppStore((state) => state.activeView)
  const conflicts = useAppStore((state) => state.conflicts)
  const unseenActivityCount = useAppStore((state) => state.unseenActivityCount)
  const setActiveView = useAppStore((state) => state.setActiveView)

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon
    const label = t(item.labelKey)

    return (
      <button
        key={item.id}
        aria-current={activeView === item.id ? 'page' : undefined}
        className={`sidebar-nav-item ${activeView === item.id ? 'active' : ''}`}
        data-tour={`nav-${item.id}`}
        title={label}
        type="button"
        onClick={() => setActiveView(item.id)}
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        <span className="sr-only">{label}</span>
        {item.id === 'conflicts' && conflicts.length > 0 ? (
          <span aria-label={`${conflicts.length} ${label}`} className="sidebar-badge">{conflicts.length}</span>
        ) : null}
        {item.id === 'activity' && unseenActivityCount > 0 ? (
          <span aria-label={`${unseenActivityCount} new changes`} className="sidebar-activity-badge">{unseenActivityCount > 99 ? '99+' : unseenActivityCount}</span>
        ) : null}
      </button>
    )
  }

  const renderGroup = (labelKey: TranslationKey, items: NavItem[]) => (
    <div className="sidebar-group">
      <p className="sr-only">{t(labelKey)}</p>
      {items.map(renderNavItem)}
    </div>
  )

  return (
    <aside aria-label="Cairn" className="app-sidebar">
      <span className="sr-only">Cairn</span>
      <nav aria-label={t('workspaceNavigation')} className="sidebar-nav">
        {renderGroup('groupProject', projectItems)}
        {renderGroup('groupCollaboration', collaborationItems)}
        {renderGroup('groupRecovery', recoveryItems)}
      </nav>
      <div className="sidebar-bottom">
        <button
          aria-current={activeView === 'settings' ? 'page' : undefined}
          className={`sidebar-nav-item ${activeView === 'settings' ? 'active' : ''}`}
          title={t('settings')}
          type="button"
          onClick={() => setActiveView('settings')}
        >
          <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
          <span className="sr-only">{t('settings')}</span>
        </button>
      </div>
    </aside>
  )
}
