import { useEffect } from 'react'

import { Editor } from '@monaco-editor/react'
import { X } from 'lucide-react'

import { useTranslation, type TranslateFn } from '@/i18n'
import type { Op } from '@/types/cairn'

interface OpDiffDialogProps {
  open: boolean
  op: Op | undefined
  onClose(): void
}

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))
  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

export function OpDiffDialog({ open, op, onClose }: OpDiffDialogProps) {
  const { t } = useTranslation()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open || !op) return null

  const kind = op.kind === 'created' ? t('opCreated') : op.kind === 'deleted' ? t('opDeleted') : t('activity')
  return (
    <div className="modal-backdrop op-diff-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section aria-modal="true" aria-label={op.filePath} className="op-diff-dialog" role="dialog">
        <header className="op-diff-header">
          <div>
            <h2 className="op-diff-title">{op.filePath}</h2>
            <p className="op-diff-meta">{op.author} · {formatRelativeTime(op.timestamp, t)} · {op.hash.slice(0, 8)} · {kind}</p>
          </div>
          <button aria-label={t('close')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="op-diff-body">
          <Editor
            height="100%"
            language="diff"
            options={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              lineNumbers: 'on',
              minimap: { enabled: false },
              readOnly: true,
              scrollBeyondLastLine: false,
              scrollbar: { horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
            }}
            theme="vs-dark"
            value={op.diff}
          />
        </div>
        <footer className="op-diff-footer">
          <button className="btn btn-ghost" type="button" onClick={onClose}>{t('close')}</button>
        </footer>
      </section>
    </div>
  )
}
