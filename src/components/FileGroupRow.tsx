import { ChevronRight } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { countDiff } from '@/lib/diffStats'
import { formatLineCount } from '@/lib/lineCount'
import type { FileGroup } from '@/lib/groupOpsByFile'
import type { Op } from '@/types/cairn'

interface FileGroupRowProps {
  expanded: boolean
  group: FileGroup
  onOpClick(op: Op): void
  onToggle(): void
}

function formatTime(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

function formatRelativeTime(timestamp: number, t: ReturnType<typeof useTranslation>['t']): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))

  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

function DiffStats({ op }: { op: Op }) {
  const { added, removed } = countDiff(op.diff)

  return <><span className="file-group-added">+{formatLineCount(added)}</span> <span className="file-group-removed">−{formatLineCount(removed)}</span></>
}

export function FileGroupRow({ expanded, group, onOpClick, onToggle }: FileGroupRowProps) {
  const { locale, t } = useTranslation()
  const authorSummary = group.authors.length === 1
    ? group.authors[0]
    : t('multipleAuthors').replace('{n}', String(group.authors.length))

  return (
    <div className={`file-group ${expanded ? 'expanded' : ''}`}>
      <button aria-expanded={expanded} className="file-group-header" type="button" onClick={onToggle}>
        <ChevronRight aria-hidden="true" className={`file-group-chevron ${expanded ? 'open' : ''}`} size={14} />
        <div className="file-group-info">
          <div className="file-group-name">{group.filePath}</div>
          <div className="file-group-meta">
            <span>{authorSummary}</span>
            <span>·</span>
            <span>{t('changesCount').replace('{n}', String(group.totalOps))}</span>
            <span>·</span>
            <span className="file-group-added">+{formatLineCount(group.totalAdded)}</span>
            <span className="file-group-removed">−{formatLineCount(group.totalRemoved)}</span>
          </div>
        </div>
        <time className="file-group-time">{formatRelativeTime(group.lastModified, t)}</time>
      </button>

      {expanded ? (
        <div className="file-group-ops">
          {group.ops.map((op) => (
            <button key={op.hash} className="op-row-compact" type="button" onClick={() => onOpClick(op)}>
              <time className="op-row-time">{formatTime(op.timestamp, locale)}</time>
              <span className="op-row-kind">
                {op.kind === 'created' ? t('opCreated') : op.kind === 'deleted' ? t('opDeleted') : <DiffStats op={op} />}
              </span>
              <span className="op-row-author">{op.author}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
