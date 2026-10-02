import type { LucideIcon } from 'lucide-react'

interface EmptyStateAction {
  label: string
  onClick(): void
  variant?: 'default' | 'primary' | 'ghost'
}

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  actions?: EmptyStateAction[]
}

/** 统一各视图的空状态，保持下一步操作清晰可见。 */
export function EmptyState({ icon: Icon, title, description, actions }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon ? (
        <div className="empty-state-icon">
          <Icon aria-hidden="true" size={40} strokeWidth={1.2} />
        </div>
      ) : null}
      <div className="empty-state-title">{title}</div>
      {description ? <div className="empty-state-desc">{description}</div> : null}
      {actions && actions.length > 0 ? (
        <div className="empty-state-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={`btn ${action.variant === 'primary' ? 'btn-primary' : action.variant === 'ghost' ? 'btn-ghost' : ''}`}
              type="button"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
