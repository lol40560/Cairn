import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  onConfirm(): void
  onCancel(): void
}

/** 在应用内确认会丢弃未保存内容的操作，避免依赖浏览器原生对话框。 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined

    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => confirmButtonRef.current?.focus(), 0)

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [onCancel, open])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section aria-modal="true" aria-labelledby="confirm-dialog-title" className="modal modal-compact confirm-dialog" role="dialog">
        <header className="modal-header">
          <h2 id="confirm-dialog-title" className="modal-title">{title}</h2>
        </header>
        <div className="modal-body">
          <p className="confirm-dialog-message">{message}</p>
        </div>
        <footer className="modal-actions confirm-dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmButtonRef} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
