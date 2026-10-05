import { useCallback, useEffect, useRef } from 'react'

export interface ContextMenuItem {
  danger?: boolean
  label: string
  onSelect(): void
  separatorBefore?: boolean
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  onClose(): void
  position: { x: number; y: number }
}

/** 輕量原生風格內容選單；只用於可節省點擊的次要操作。 */
export function ContextMenu({ items, onClose, position }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const close = useCallback((): void => {
    onClose()
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [onClose])

  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 0)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [close])

  return (
    <div className="context-menu-layer" role="presentation" onMouseDown={close}>
      <div
        ref={menuRef}
        aria-label="Context menu"
        className="context-menu"
        role="menu"
        style={{ left: position.x, top: position.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <div key={item.label} className={item.separatorBefore ? 'context-menu-section' : undefined}>
            <button
              className={item.danger ? 'danger' : undefined}
              role="menuitem"
              type="button"
              onClick={() => {
                item.onSelect()
                close()
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
