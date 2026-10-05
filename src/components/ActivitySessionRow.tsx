import { useEffect, useMemo, useRef, useState } from 'react'

import { ChevronRight, Copy } from 'lucide-react'

import { FileGroupRow } from '@/components/FileGroupRow'
import { useTranslation } from '@/i18n'
import { groupOpsByFile } from '@/lib/groupOpsByFile'
import { formatLineCount } from '@/lib/lineCount'
import type { ActivitySession } from '@/lib/activitySessions'
import type { Op } from '@/types/cairn'

interface ActivitySessionRowProps {
  copied: boolean
  expanded: boolean
  session: ActivitySession
  onCopySummary(session: ActivitySession): void
  onOpClick(op: Op): void
  onToggle(): void
}

function relativeTime(timestamp: number, t: ReturnType<typeof useTranslation>['t']): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? (hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))) : t('daysAgo').replace('{n}', String(Math.floor(hours / 24)))
}

function durationLabel(durationMs: number, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  const minutes = Math.floor(durationMs / 60_000)
  if (minutes < 1) return undefined
  return t('sessionDuration').replace('{n}', String(minutes))
}

/** 一段可展开的确定性工作流；文件与 op 仍保持原有可检查层级。 */
export function ActivitySessionRow({ copied, expanded, session, onCopySummary, onOpClick, onToggle }: ActivitySessionRowProps) {
  const { t } = useTranslation()
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set())
  const [wasUpdated, setWasUpdated] = useState(false)
  const latestOperationHash = session.operations.at(-1)?.hash
  const previousLatestOperationHash = useRef(latestOperationHash)
  const fileGroups = useMemo(() => groupOpsByFile(session.operations), [session.operations])
  const attribution = session.attribution === 'me'
    ? t('contributorMe')
    : session.attribution === 'ai' ? t('contributorAi') : t('contributorTeammate')
  const duration = durationLabel(session.durationMs, t)

  useEffect(() => {
    if (previousLatestOperationHash.current === latestOperationHash) return
    previousLatestOperationHash.current = latestOperationHash
    setWasUpdated(true)
    const timeout = window.setTimeout(() => setWasUpdated(false), 800)
    return () => window.clearTimeout(timeout)
  }, [latestOperationHash])

  const toggleFile = (path: string): void => {
    setExpandedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <article className={`activity-session ${expanded ? 'expanded' : ''} ${wasUpdated ? 'was-updated' : ''}`}>
      <div className="activity-session-header">
        <button aria-expanded={expanded} className="activity-session-main" type="button" onClick={onToggle}>
          <ChevronRight aria-hidden="true" className={`file-group-chevron ${expanded ? 'open' : ''}`} size={14} />
          <div className="activity-session-info">
            <div className="activity-session-author">{session.author} <span className={`contributor-${session.attribution}`}>· {attribution}</span></div>
            <div className="activity-session-meta">
              <span>{t('sessionChangesFiles').replace('{changes}', String(session.operationCount)).replace('{files}', String(session.fileCount))}</span>
              {duration ? <><span>·</span><span>{duration}</span></> : null}
              <span>·</span>
              <span className="file-group-added">+{formatLineCount(session.totalAdded)}</span>
              <span className="file-group-removed">−{formatLineCount(session.totalRemoved)}</span>
            </div>
            <div className="activity-session-files">
              {session.filePaths.slice(0, 3).map((path) => <code key={path}>{path}</code>)}
              {session.filePaths.length > 3 ? <span>{t('sessionMoreFiles').replace('{n}', String(session.filePaths.length - 3))}</span> : null}
            </div>
          </div>
          <time className="file-group-time">{relativeTime(session.endedAt, t)}</time>
        </button>
        <button
          aria-label={t('copySessionSummary')}
          className="activity-session-copy"
          title={t('copySessionSummary')}
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onCopySummary(session)
          }}
        >
          {copied ? t('copied') : <Copy aria-hidden="true" size={14} />}
        </button>
      </div>
      {expanded ? (
        <div className="activity-session-files-expanded">
          {fileGroups.map((group) => (
            <FileGroupRow
              key={group.filePath}
              expanded={expandedFiles.has(group.filePath)}
              group={group}
              onOpClick={onOpClick}
              onToggle={() => toggleFile(group.filePath)}
            />
          ))}
        </div>
      ) : null}
    </article>
  )
}
