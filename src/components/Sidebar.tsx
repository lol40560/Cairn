import { Activity, AlertTriangle, Bookmark, ChevronLeft, ChevronRight, FileText, Home, Settings, Trash2, Users } from 'lucide-react'

import cairnLogo from '@/assets/cairn-logo.png'
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
  const collapsed = useAppStore((state) => state.sidebarCollapsed)
  const conflicts = useAppStore((state) => state.conflicts)
  const unseenActivityCount = useAppStore((state) => state.unseenActivityCount)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed)

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon
    const label = t(item.labelKey)

    return (
      <button
        key={item.id}
        aria-current={activeView === item.id ? 'page' : undefined}
        className={`sidebar-nav-item ${activeView === item.id ? 'active' : ''}`}
        title={collapsed ? label : undefined}
        type="button"
        onClick={() => setActiveView(item.id)}
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        {!collapsed ? <span>{label}</span> : null}
        {item.id === 'conflicts' && conflicts.length > 0 ? (
          collapsed ? <span aria-label={`${conflicts.length} ${label}`} className="sidebar-badge-dot" /> : (
            <span aria-label={`${conflicts.length} ${label}`} className="sidebar-badge">{conflicts.length}</span>
          )
        ) : null}
        {item.id === 'activity' && unseenActivityCount > 0 ? (
          <span aria-label={`${unseenActivityCount} new changes`} className="sidebar-activity-badge">{unseenActivityCount > 99 ? '99+' : unseenActivityCount}</span>
        ) : null}
      </button>
    )
  }

  return (
    <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <img alt="" className="sidebar-logo" src={cairnLogo} />
        {!collapsed ? <span className="sidebar-brand-text">Cairn</span> : null}
        <button
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className="sidebar-collapse-btn"
          title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          type="button"
          onClick={() => setSidebarCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>
      <nav aria-label={t('workspaceNavigation')} className="sidebar-nav">
        <div className="sidebar-group">
          {!collapsed ? <p className="sidebar-group-title">{t('groupProject')}</p> : null}
          {projectItems.map(renderNavItem)}
        </div>
        <div className="sidebar-group">
          {!collapsed ? <p className="sidebar-group-title">{t('groupCollaboration')}</p> : null}
          {collaborationItems.map(renderNavItem)}
        </div>
        <div className="sidebar-group">
          {!collapsed ? <p className="sidebar-group-title">{t('groupRecovery')}</p> : null}
          {recoveryItems.map(renderNavItem)}
        </div>
      </nav>
      <div className="sidebar-bottom">
        <button
          aria-current={activeView === 'settings' ? 'page' : undefined}
          className={`sidebar-nav-item ${activeView === 'settings' ? 'active' : ''}`}
          title={collapsed ? t('settings') : undefined}
          type="button"
          onClick={() => setActiveView('settings')}
        >
          <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
          {!collapsed ? <span>{t('settings')}</span> : null}
        </button>
      </div>
    </aside>
  )
}
