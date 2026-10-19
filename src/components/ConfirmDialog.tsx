import { useRef } from 'react'

import { useDialogFocus } from '@/lib/dialogFocus'

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
  const dialogRef = useDialogFocus<HTMLElement>(open, onCancel, confirmButtonRef)

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section ref={dialogRef} aria-modal="true" aria-labelledby="confirm-dialog-title" className="modal modal-compact confirm-dialog" role="dialog" tabIndex={-1}>
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
