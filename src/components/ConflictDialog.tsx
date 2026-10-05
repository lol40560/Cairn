import { useEffect, useState } from 'react'

import { CheckCircle2, X } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { MonacoDiff } from '@/components/MonacoDiff'
import { useTranslation, type TranslateFn } from '@/i18n'
import { detectLanguage } from '@/lib/detect-language'
import { useAppStore } from '@/store/appStore'
import type { ConflictRecord } from '@/types/cairn'

type Resolution = 'local' | 'remote' | 'merged'

interface ConflictDialogProps {
  open: boolean
  conflicts: ConflictRecord[]
  onClose(): void
  onResolve(opHash: string, resolution: Resolution): Promise<void>
  dirtyFilePaths?: string[]
}

interface ConflictCardProps {
  conflict: ConflictRecord
  onResolve(opHash: string, resolution: Resolution): Promise<void>
  dirty?: boolean
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

export function ConflictCard({ conflict, onResolve, dirty: dirtyOverride }: ConflictCardProps) {
  const { t } = useTranslation()
  const dirtyFilePaths = useAppStore((state) => state.dirtyFilePaths)
  const [pendingResolution, setPendingResolution] = useState<Exclude<Resolution, 'merged'> | undefined>()
  const dirty = dirtyOverride ?? dirtyFilePaths.includes(conflict.filePath)
  const confirm = (): void => {
    if (!pendingResolution) return
    const resolution = pendingResolution
    setPendingResolution(undefined)
    void onResolve(conflict.opHash, resolution)
  }

  return (
    <article className="conflict-card">
      <header className="conflict-card-header">
        <div>
          <p className="conflict-file">{conflict.filePath}</p>
          <p className="conflict-meta">
            {t('conflictBy').replace('{author}', conflict.author)} · {formatConflictRelativeTime(conflict.timestamp, t)}
          </p>
          <p className="conflict-meta">{t('conflictContentType')} · {t('conflictReasonApplyFailed')}</p>
        </div>
      </header>
      <MonacoDiff
        height="320px"
        language={detectLanguage(conflict.filePath)}
        modelId={conflict.opHash}
        modified={conflict.localContent}
        modifiedLabel={t('conflictLocal')}
        original={conflict.remoteContent ?? ''}
        originalLabel={t('conflictRemote').replace('{author}', conflict.author)}
      />
      <div className="conflict-actions">
        <button className="btn btn-secondary btn-sm" disabled={dirty} type="button" onClick={() => setPendingResolution('local')}>
          {t('conflictKeepMine')}
        </button>
        <button className="btn btn-secondary btn-sm" disabled={dirty || conflict.remoteContent === undefined} type="button" onClick={() => setPendingResolution('remote')}>
          {t('conflictKeepTheirs')}
        </button>
      </div>
      {dirty ? <p className="conflict-dirty-blocked" role="status">{t('conflictDirtyBlocked')}</p> : null}
      <ConfirmDialog
        cancelLabel={t('cancel')}
        confirmLabel={pendingResolution === 'local' ? t('conflictKeepMine') : t('conflictKeepTheirs')}
        danger={pendingResolution === 'remote'}
        message={pendingResolution === 'local' ? t('conflictUseMineMessage') : t('conflictUseTheirsMessage')}
        open={pendingResolution !== undefined}
        title={pendingResolution === 'local' ? t('conflictUseMineTitle') : t('conflictUseTheirsTitle')}
        onCancel={() => setPendingResolution(undefined)}
        onConfirm={confirm}
      />
    </article>
  )
}

export function ConflictDialog({ open, conflicts, onClose, onResolve, dirtyFilePaths }: ConflictDialogProps) {
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
            <EmptyState icon={CheckCircle2} title={t('conflictNone')} />
          ) : conflicts.map((conflict) => (
            <ConflictCard key={conflict.opHash} conflict={conflict} dirty={dirtyFilePaths?.includes(conflict.filePath)} onResolve={onResolve} />
          ))}
          <div className="modal-actions">
            <button className="btn btn-ghost" type="button" onClick={onClose}>{t('close')}</button>
          </div>
        </div>
      </section>
    </div>
  )
}
