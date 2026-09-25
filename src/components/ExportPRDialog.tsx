import { useEffect, useRef, useState } from 'react'

import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import {
  shouldCloseDialogFromBackdrop,
  shouldCloseDialogFromKey,
  submitExportPR,
} from '@/lib/settingsDialog'
import type { IpcResult } from '@/types/cairn'

export interface ExportPRDialogProps {
  open: boolean
  defaultTitle: string
  onSubmit(title: string): Promise<IpcResult<unknown>>
  onClose(): void
  onOpenSettings(): void
}

export function ExportPRDialog({
  open,
  defaultTitle,
  onSubmit,
  onClose,
  onOpenSettings,
}: ExportPRDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(defaultTitle)
  const [error, setError] = useState<NormalizedError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    void Promise.resolve().then(() => {
      setTitle(defaultTitle)
      setError(null)
      inputRef.current?.focus()
    })
  }, [defaultTitle, open])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitExportPR(title, onSubmit)
      if (!result.ok) {
        setError(normalizeError(result.error, t))
        return
      }
      onClose()
    } catch (cause) {
      console.error('[cairn] 无法创建 PR', cause)
      setError(normalizeError(cause, t))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (shouldCloseDialogFromBackdrop(event.target, event.currentTarget)) {
          onClose()
        }
      }}
      onKeyDown={(event) => {
        if (shouldCloseDialogFromKey(event.key)) {
          onClose()
        }
      }}
    >
      <section className="modal modal-compact" aria-labelledby="export-pr-dialog-title">
        <header className="modal-header">
          <h2 id="export-pr-dialog-title" className="modal-title">{t('exportPRTitle')}</h2>
          <button aria-label={t('exportPRCancel')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{t('exportPRLabel')}</span>
            <input
              ref={inputRef}
              className="input"
              value={title}
              aria-label={t('exportPRLabel')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {error && (
            <div className="modal-error">
              <p>{error.message}</p>
              {error.hint && <p>{error.hint}</p>}
              <button className="btn btn-ghost" type="button" onClick={() => void navigator.clipboard.writeText(error.raw)}>
                {t('errorCopyRaw')}
              </button>
              {error.category === 'config' && (
                <button className="btn btn-ghost" type="button" onClick={onOpenSettings}>
                  {t('errorOpenSettings')}
                </button>
              )}
            </div>
          )}
          <footer className="modal-actions">
            <button className="btn btn-primary" disabled={submitting || title.trim() === ''} type="button" onClick={() => void submit()}>
              {submitting ? t('exportPRCreating') : t('exportPRCreate')}
            </button>
            <button className="btn btn-ghost" disabled={submitting} type="button" onClick={onClose}>
              {t('exportPRCancel')}
            </button>
          </footer>
        </div>
      </section>
    </div>
  )
}
