import { useEffect, useRef, useState, type MouseEvent } from 'react'

import { ChevronRight } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { countDiff } from '@/lib/diffStats'
import { contributorKind } from '@/lib/collaboration'
import { formatLineCount } from '@/lib/lineCount'
import type { FileGroup } from '@/lib/groupOpsByFile'
import type { Op } from '@/types/cairn'

interface FileGroupRowProps {
  expanded: boolean
  group: FileGroup
  onOpClick(op: Op): void
  onContextMenu?(event: MouseEvent<HTMLButtonElement>, filePath: string, latestOp: Op): void
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

function AuthorAttribution({ op }: { op: Op }) {
  const { t } = useTranslation()
  const kind = contributorKind(op)
  const label = kind === 'me' ? t('contributorMe') : kind === 'ai' ? t('contributorAi') : t('contributorTeammate')

  return <span className={`op-row-author contributor-${kind}`} title={label}>{op.author} <span className="contributor-label">· {label}</span></span>
}

export function FileGroupRow({ expanded, group, onContextMenu, onOpClick, onToggle }: FileGroupRowProps) {
  const { locale, t } = useTranslation()
  const latestOpHash = group.ops[0]?.hash
  const initialOpHash = useRef(latestOpHash)
  const [wasUpdated, setWasUpdated] = useState(false)

  useEffect(() => {
    if (initialOpHash.current === latestOpHash) return undefined

    initialOpHash.current = latestOpHash
    setWasUpdated(true)
    const timer = window.setTimeout(() => setWasUpdated(false), 800)
    return () => window.clearTimeout(timer)
  }, [latestOpHash])

  const authorSummary = group.authors.length === 1
    ? group.authors[0]
    : t('multipleAuthors').replace('{n}', String(group.authors.length))

  return (
    <div className={`file-group ${expanded ? 'expanded' : ''}${wasUpdated ? ' was-updated' : ''}`}>
      <button
        aria-expanded={expanded}
        className="file-group-header"
        type="button"
        onClick={onToggle}
        onContextMenu={(event) => {
          if (!onContextMenu || !group.ops[0]) return
          event.preventDefault()
          onContextMenu(event, group.filePath, group.ops[0])
        }}
      >
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
              <AuthorAttribution op={op} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
