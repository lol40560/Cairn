import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

export interface SearchPaletteItem {
  id: string
  label: string
  keywords?: string
  detail?: string
  shortcut?: string
  icon?: ReactNode
  group?: string
}

interface SearchPaletteProps {
  emptyLabel: string
  items: SearchPaletteItem[]
  onClose(): void
  onSelect(item: SearchPaletteItem): void
  open: boolean
  placeholder: string
  title: string
}

function matches(item: SearchPaletteItem, query: string): boolean {
  const haystack = `${item.label} ${item.detail ?? ''} ${item.keywords ?? ''}`.toLocaleLowerCase()
  return haystack.includes(query.toLocaleLowerCase())
}

function matchRank(item: SearchPaletteItem, query: string): number {
  if (!query) return 0
  const needle = query.toLocaleLowerCase()
  const label = item.label.toLocaleLowerCase()
  const detail = item.detail?.toLocaleLowerCase() ?? ''
  if (label.startsWith(needle)) return 0
  if (label.includes(needle)) return 1
  // 支援 components/File 這類路徑導向搜尋，但仍優先檔名命中。
  if (detail.includes(needle) || `${detail}/${label}`.includes(needle)) return 2
  return 3
}

/** 共用的鍵盤搜尋面板，供命令、檔案和專案切換使用。 */
export function SearchPalette({ emptyLabel, items, onClose, onSelect, open, placeholder, title }: SearchPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const listId = useId()
  const visibleItems = useMemo(() => {
    const matched = items.filter((item) => matches(item, query))
    if (!query) return matched.slice(0, 50)
    return matched
      .sort((left, right) => matchRank(left, query) - matchRank(right, query) || left.label.localeCompare(right.label))
      .slice(0, 50)
  }, [items, query])

  useEffect(() => {
    if (!open) return
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => {
      setQuery('')
      setSelectedIndex(0)
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const close = (): void => {
    onClose()
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  if (!open) return null

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section aria-label={title} aria-modal="true" className="search-palette" role="dialog">
        <div className="search-palette-heading">
          <span>{title}</span>
          <kbd>Esc</kbd>
        </div>
        <input
          ref={inputRef}
          aria-activedescendant={visibleItems[selectedIndex] ? `${listId}-${visibleItems[selectedIndex].id}` : undefined}
          aria-controls={listId}
          aria-label={title}
          className="search-palette-input"
          placeholder={placeholder}
          role="combobox"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelectedIndex((index) => Math.min(index + 1, Math.max(visibleItems.length - 1, 0)))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex((index) => Math.max(index - 1, 0))
            }
            if (event.key === 'Enter' && visibleItems[selectedIndex]) {
              event.preventDefault()
              onSelect(visibleItems[selectedIndex])
              close()
            }
          }}
        />
        <div id={listId} aria-label={title} className="search-palette-list" role="listbox">
          {visibleItems.length === 0 ? <p className="search-palette-empty">{emptyLabel}</p> : visibleItems.map((item, index) => (
            <button
              key={item.id}
              id={`${listId}-${item.id}`}
              aria-selected={index === selectedIndex}
              className={`search-palette-item ${index === selectedIndex ? 'selected' : ''}`}
              role="option"
              type="button"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                onSelect(item)
                close()
              }}
            >
              {item.icon ? <span aria-hidden="true" className="search-palette-icon">{item.icon}</span> : null}
              <span className="search-palette-copy">
                {item.group ? <span className="search-palette-group">{item.group}</span> : null}
                <span>{item.label}</span>
                {item.detail ? <span className="search-palette-detail">{item.detail}</span> : null}
              </span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
