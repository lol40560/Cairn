import { useEffect } from 'react'

import { diffLines } from 'diff'
import { X } from 'lucide-react'

import { useTranslation, type TranslateFn } from '@/i18n'
import type { ConflictRecord } from '@/types/cairn'

type Resolution = 'local' | 'remote' | 'merged'

interface ConflictDialogProps {
  open: boolean
  conflicts: ConflictRecord[]
  onClose(): void
  onResolve(opHash: string, resolution: Resolution): Promise<void>
}

interface ConflictCardProps {
  conflict: ConflictRecord
  onResolve(opHash: string, resolution: Resolution): Promise<void>
}

interface DisplayLine {
  text: string
  type: 'same' | 'local-only' | 'remote-only'
}

function formatConflictRelativeTime(timestamp: number, t: TranslateFn): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))
  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

/** 用行级差异让双方内容在不引入编辑器的前提下易于比对。 */
function highlightDiff(local: string, remote: string): {
  localLines: DisplayLine[]
  remoteLines: DisplayLine[]
} {
  const localLines: DisplayLine[] = []
  const remoteLines: DisplayLine[] = []
  for (const part of diffLines(local, remote)) {
    const lines = part.value.split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (part.removed) {
      localLines.push(...lines.map((text) => ({ text, type: 'local-only' as const })))
    } else if (part.added) {
      remoteLines.push(...lines.map((text) => ({ text, type: 'remote-only' as const })))
    } else {
      const same = lines.map((text) => ({ text, type: 'same' as const }))
      localLines.push(...same)
      remoteLines.push(...same)
    }
  }
  return { localLines, remoteLines }
}

function DiffColumn({ label, lines }: { label: string; lines: DisplayLine[] }) {
  return (
    <div className="conflict-column">
      <div className="conflict-column-label">{label}</div>
      <pre className="conflict-column-content">
        {lines.map((line, index) => (
          <span key={`${index}-${line.text}`} className={`conflict-line conflict-line-${line.type}`}>
            {line.text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}

export function ConflictCard({ conflict, onResolve }: ConflictCardProps) {
  const { t } = useTranslation()
  const { localLines, remoteLines } = highlightDiff(conflict.localContent, conflict.remoteContent ?? '')

  return (
    <article className="conflict-card">
      <header className="conflict-card-header">
        <div>
          <p className="conflict-file">{conflict.filePath}</p>
          <p className="conflict-meta">
            {t('conflictBy').replace('{author}', conflict.author)} · {formatConflictRelativeTime(conflict.timestamp, t)}
          </p>
        </div>
      </header>
      <div className="conflict-diff">
        <DiffColumn label={t('conflictLocal')} lines={localLines} />
        <DiffColumn label={t('conflictRemote').replace('{author}', conflict.author)} lines={remoteLines} />
      </div>
      <div className="conflict-actions">
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void onResolve(conflict.opHash, 'local')}>
          {t('conflictKeepMine')}
        </button>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => void onResolve(conflict.opHash, 'remote')}>
          {t('conflictKeepTheirs')}
        </button>
      </div>
    </article>
  )
}

export function ConflictDialog({ open, conflicts, onClose, onResolve }: ConflictDialogProps) {
  const { t } = useTranslation()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section aria-modal="true" aria-label={t('conflictsTitle')} className="modal conflict-modal" role="dialog">
        <header className="modal-header">
          <h2 className="modal-title">{t('conflictsTitle')} ({conflicts.length})</h2>
          <button aria-label={t('close')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body conflict-modal-body">
          {conflicts.length === 0 ? (
            <p className="empty-desc">{t('conflictNone')}</p>
          ) : conflicts.map((conflict) => (
            <ConflictCard key={conflict.opHash} conflict={conflict} onResolve={onResolve} />
          ))}
          <div className="modal-actions">
            <button className="btn btn-ghost" type="button" onClick={onClose}>{t('close')}</button>
          </div>
        </div>
      </section>
    </div>
  )
}
