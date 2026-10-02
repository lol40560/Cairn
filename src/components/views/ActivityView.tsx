import { useState } from 'react'

import { FolderOpen, SlidersHorizontal, Sparkles } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { OpDiffDialog } from '@/components/OpDiffDialog'
import { useTranslation } from '@/i18n'
import { countDiff } from '@/lib/diffStats'
import { formatLineCount } from '@/lib/lineCount'
import { useAppStore } from '@/store/appStore'
import type { TranslateFn } from '@/i18n'
import type { ConflictRecord, Op } from '@/types/cairn'

interface ActivityViewProps {
  emptyMessage?: string
  folder?: string
  ops: Op[]
  onChangeFolder(): Promise<void>
  onReviewConflicts?(): void
  conflicts?: ConflictRecord[]
}

function formatTime(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) return t('justNow')
  if (minutes < 60) {
    return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))
  }

  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

export function ActivityView({ emptyMessage, folder: folderOverride, ops, onChangeFolder, onReviewConflicts, conflicts: conflictsOverride }: ActivityViewProps) {
  const { locale, t } = useTranslation()
  const storedFolder = useAppStore((state) => state.folder)
  const folder = folderOverride ?? storedFolder
  const setActiveView = useAppStore((state) => state.setActiveView)
  const storedConflicts = useAppStore((state) => state.conflicts)
  const conflicts = conflictsOverride ?? storedConflicts
  const [remoteOnly, setRemoteOnly] = useState(false)
  const [selectedOp, setSelectedOp] = useState<Op | undefined>()
  const visibleOps = remoteOnly ? ops.filter((op) => op.source === 'remote') : ops
  const fileCount = new Set(ops.map((op) => op.filePath)).size

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('activityTitle')}</h1>
        <span className="view-count">{t('activitySummary').replace('{changes}', String(ops.length)).replace('{files}', String(fileCount))}</span>
        <span className="view-spacer" />
        <button
          aria-pressed={remoteOnly}
          className={`view-action view-action-ghost ${remoteOnly ? 'is-active' : ''}`}
          type="button"
          onClick={() => setRemoteOnly((value) => !value)}
        >
          <SlidersHorizontal size={14} strokeWidth={1.8} />
          {remoteOnly ? t('remote') : t('filter')}
        </button>
        <button className="view-action" type="button" onClick={() => void onChangeFolder()}>
          <FolderOpen size={14} strokeWidth={1.8} />
          {t('changeFolder')}
        </button>
      </div>

      {conflicts.length > 0 && (
        <div className="conflict-banner" role="status">
          <span aria-hidden="true" className="conflict-banner-icon">⚠</span>
          <span className="conflict-banner-text">
            {t('conflictBanner').replace('{n}', String(conflicts.length))}
          </span>
          <button className="btn btn-sm" type="button" onClick={onReviewConflicts}>
            {t('conflictReview')}
          </button>
        </div>
      )}

      {visibleOps.length === 0 ? (
        !folder ? (
          <EmptyState
            actions={[
              { label: t('chooseFolder'), onClick: () => void onChangeFolder(), variant: 'primary' },
              { label: t('joinTeam'), onClick: () => setActiveView('room'), variant: 'ghost' },
            ]}
            description={emptyMessage ?? t('emptyNoProjectDesc')}
            icon={FolderOpen}
            title={t('emptyNoProject')}
          />
        ) : (
          <EmptyState
            description={remoteOnly ? t('remoteChangesEmpty') : t('emptyNoChangesDesc')}
            icon={Sparkles}
            title={t('emptyNoChanges')}
          />
        )
      ) : (
        <div className="op-list">
          {visibleOps.map((op) => {
            const { added, removed } = countDiff(op.diff)
            const dotClass = op.source === 'remote' ? 'remote' : ''

            return (
              <article
                key={op.hash}
                aria-label={op.filePath}
                className="op-row op-row-clickable"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedOp(op)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedOp(op)
                  }
                }}
              >
                <span aria-label={op.source === 'remote' ? 'Remote change' : 'Local change'} className={`op-dot ${dotClass}`} />
                <time className="op-time">{formatTime(op.timestamp, locale)}</time>
                <div className="op-file">
                  <p className="op-file-name">{op.filePath}</p>
                  <p className="op-file-meta">{op.author} · {formatRelativeTime(op.timestamp, t)}</p>
                </div>
                <div className="op-stats">
                  {op.kind === 'created' ? (
                    <>
                      <span className="op-kind-badge">{t('opCreated')}</span>
                      <span className="op-kind-stats">
                        {t('opLinesAdded').replace('{n}', formatLineCount(added))}
                      </span>
                    </>
                  ) : op.kind === 'deleted' ? (
                    <>
                      <span className="op-kind-badge op-kind-deleted">{t('opDeleted')}</span>
                      <span className="op-kind-stats">
                        {t('opLinesRemoved').replace('{n}', formatLineCount(removed))}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>+{formatLineCount(added)}</span>
                      <span className="op-del">−{formatLineCount(removed)}</span>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
      <OpDiffDialog open={selectedOp !== undefined} op={selectedOp} onClose={() => setSelectedOp(undefined)} />
    </section>
  )
}
