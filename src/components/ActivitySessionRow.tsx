import { useEffect, useMemo, useRef, useState } from 'react'

import { ChevronRight, Copy, X } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { countDiff } from '@/lib/diffStats'
import { groupOpsByFile, type FileGroup } from '@/lib/groupOpsByFile'
import { formatLineCount } from '@/lib/lineCount'
import { useDialogFocus } from '@/lib/dialogFocus'
import type { ActivitySession } from '@/lib/activitySessions'

interface ActivitySessionRowProps {
  copied: boolean
  expanded: boolean
  session: ActivitySession
  onCopySummary(session: ActivitySession): void
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

function ActivityFilePreview({ group, onClose }: {
  group: FileGroup
  onClose(): void
}) {
  const { t } = useTranslation()
  const [selectedOp, setSelectedOp] = useState(group.ops[0])
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose, closeButtonRef)

  if (!selectedOp) return null

  return (
    <div className="activity-file-preview-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section ref={dialogRef} aria-label={group.filePath} aria-modal="true" className="activity-file-preview" role="dialog" tabIndex={-1}>
        <header className="activity-file-preview-header">
          <div className="activity-file-preview-heading">
            <h3>{group.filePath}</h3>
            <div className="activity-file-preview-meta">
              <span>{t('editedBy').replace('{authors}', group.authors.join(', '))}</span>
              <span>·</span>
              <span>{t('changesCount').replace('{n}', String(group.totalOps))}</span>
              <span>·</span>
              <span className="file-group-added">+{formatLineCount(group.totalAdded)}</span>
              <span className="file-group-removed">−{formatLineCount(group.totalRemoved)}</span>
            </div>
          </div>
          <button ref={closeButtonRef} aria-label={t('close')} className="activity-file-preview-close" type="button" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        {group.ops.length > 1 ? (
          <div aria-label={t('changesCount').replace('{n}', String(group.totalOps))} className="activity-file-preview-ops" role="tablist">
            {group.ops.map((op) => {
              const stats = countDiff(op.diff)
              return (
                <button
                  aria-selected={selectedOp.hash === op.hash}
                  className={selectedOp.hash === op.hash ? 'active' : ''}
                  key={op.hash}
                  role="tab"
                  type="button"
                  onClick={() => setSelectedOp(op)}
                >
                  <span>{op.author}</span>
                  <time>{new Date(op.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  <span className="file-group-added">+{formatLineCount(stats.added)}</span>
                  <span className="file-group-removed">−{formatLineCount(stats.removed)}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="activity-file-preview-selected-meta">
          <span>{selectedOp.author}</span>
          <span>·</span>
          <time>{relativeTime(selectedOp.timestamp, t)}</time>
          <span>·</span>
          <code>{selectedOp.hash.slice(0, 8)}</code>
        </div>
        <pre className="activity-file-preview-diff" tabIndex={0}>{selectedOp.diff}</pre>
      </section>
    </div>
  )
}

/** 工作階段只保留一層檔案列表；詳細 op 以輕量預覽呈現。 */
export function ActivitySessionRow({ copied, expanded, session, onCopySummary, onToggle }: ActivitySessionRowProps) {
  const { t } = useTranslation()
  const [selectedFile, setSelectedFile] = useState<FileGroup>()
  const [wasUpdated, setWasUpdated] = useState(false)
  const latestOperationHash = session.operations.at(-1)?.hash
  const previousLatestOperationHash = useRef(latestOperationHash)
  const fileGroups = useMemo(() => groupOpsByFile(session.operations), [session.operations])
  const attribution = session.attribution === 'me'
    ? t('contributorMe')
    : session.attribution === 'ai' ? t('contributorAi')
      : session.attribution === 'teammate' ? t('contributorTeammate') : t('contributorUnknown')
  const duration = durationLabel(session.durationMs, t)
  const primaryFile = session.filePaths[0] ?? ''
  const remainingFiles = Math.max(0, session.fileCount - 1)

  useEffect(() => {
    if (previousLatestOperationHash.current === latestOperationHash) return
    previousLatestOperationHash.current = latestOperationHash
    setWasUpdated(true)
    const timeout = window.setTimeout(() => setWasUpdated(false), 800)
    return () => window.clearTimeout(timeout)
  }, [latestOperationHash])

  return (
    <article className={`activity-session ${expanded ? 'expanded' : ''} ${wasUpdated ? 'was-updated' : ''}`}>
      <div className="activity-session-header">
        <button
          aria-expanded={expanded}
          aria-label={expanded ? t('collapseFiles') : t('showFiles')}
          className="activity-session-main"
          type="button"
          onClick={onToggle}
        >
          <ChevronRight aria-hidden="true" className="activity-session-chevron" size={15} />
          <div className="activity-session-info">
            <div className="activity-session-file-title">
              <code>{primaryFile}</code>
              {remainingFiles > 0 ? <span>{t('sessionMoreFiles').replace('{n}', String(remainingFiles))}</span> : null}
            </div>
            <div className="activity-session-meta">
              <span>{session.author}</span>
              <span className={`contributor-${session.attribution}`}>· {attribution}</span>
              <span>·</span>
              <span>{t('changesCount').replace('{n}', String(session.operationCount))}</span>
              <span>·</span>
              <time>{relativeTime(session.endedAt, t)}</time>
              {duration ? <><span>·</span><span>{duration}</span></> : null}
            </div>
          </div>
          <div className="activity-session-totals">
            <span className="file-group-added">+{formatLineCount(session.totalAdded)}</span>
            <span className="file-group-removed">−{formatLineCount(session.totalRemoved)}</span>
          </div>
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
            <button
              className="activity-session-file-row"
              key={group.filePath}
              type="button"
              onClick={() => setSelectedFile(group)}
            >
              <span className="activity-session-file-info">
                <code>{group.filePath}</code>
                <span>{t('editedBy').replace('{authors}', group.authors.join(', '))} · {t('changesCount').replace('{n}', String(group.totalOps))}</span>
              </span>
              <span className="activity-session-file-stats">
                <span className="file-group-added">+{formatLineCount(group.totalAdded)}</span>
                <span className="file-group-removed">−{formatLineCount(group.totalRemoved)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {selectedFile ? (
        <ActivityFilePreview
          group={selectedFile}
          onClose={() => setSelectedFile(undefined)}
        />
      ) : null}
    </article>
  )
}
