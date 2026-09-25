import { useState } from 'react'

import { FolderOpen, SlidersHorizontal } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { countDiff } from '@/lib/diffStats'
import type { TranslateFn } from '@/i18n'
import type { Op } from '@/types/cairn'

interface ActivityViewProps {
  emptyMessage?: string
  ops: Op[]
  onChangeFolder(): Promise<void>
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

export function ActivityView({ emptyMessage, ops, onChangeFolder }: ActivityViewProps) {
  const { locale, t } = useTranslation()
  const [remoteOnly, setRemoteOnly] = useState(false)
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

      {visibleOps.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{emptyMessage ?? t('emptyState')}</p>
          {remoteOnly && <p className="empty-desc">{t('remoteChangesEmpty')}</p>}
        </div>
      ) : (
        <div className="op-list">
          {visibleOps.map((op) => {
            const { added, removed } = countDiff(op.diff)
            const dotClass = op.source === 'remote' ? 'remote' : ''

            return (
              <article key={op.hash} className="op-row">
                <span aria-label={op.source === 'remote' ? 'Remote change' : 'Local change'} className={`op-dot ${dotClass}`} />
                <time className="op-time">{formatTime(op.timestamp, locale)}</time>
                <div className="op-file">
                  <p className="op-file-name">{op.filePath}</p>
                  <p className="op-file-meta">{op.author} · {formatRelativeTime(op.timestamp, t)}</p>
                </div>
                <div className="op-stats">
                  <span>+{added}</span>
                  <span className="op-del">−{removed}</span>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
