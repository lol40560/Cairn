import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
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
      className="fixed inset-0 z-20 flex items-center justify-center bg-bg-0/80"
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
      <section className="w-96 space-y-3 rounded-md bg-popover p-4 shadow">
        <p>{t('exportPR')}</p>
        <input
          ref={inputRef}
          className="w-full border bg-popover p-2"
          value={title}
          aria-label={t('prTitle')}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error && (
          <div className="space-y-1 text-sm text-danger">
            <p>{error.message}</p>
            {error.hint && <p>{error.hint}</p>}
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(error.raw)}>
              {t('errorCopyRaw')}
            </Button>
            {error.category === 'config' && (
              <Button variant="ghost" onClick={onOpenSettings}>
                {t('errorOpenSettings')}
              </Button>
            )}
          </div>
        )}
        <Button variant="outline" disabled={submitting || title.trim() === ''} onClick={() => void submit()}>
          {submitting ? t('creating') : t('create')}
        </Button>
        <Button variant="ghost" disabled={submitting} onClick={onClose}>
          {t('cancel')}
        </Button>
      </section>
    </div>
  )
}
