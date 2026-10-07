import { useEffect, useMemo, useRef, useState } from 'react'

import { FolderOpen, Search, Sparkles } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { ActivitySessionRow } from '@/components/ActivitySessionRow'
import { FileGroupRow } from '@/components/FileGroupRow'
import { OpDiffDialog } from '@/components/OpDiffDialog'
import { useTranslation } from '@/i18n'
import { groupOpsByFile } from '@/lib/groupOpsByFile'
import { groupActivitySessions, type ActivitySession } from '@/lib/activitySessions'
import { contributorKind } from '@/lib/collaboration'
import { useAppStore } from '@/store/appStore'
import type { ConflictRecord, Op } from '@/types/cairn'

interface ActivityViewProps {
  emptyMessage?: string
  folder?: string
  ops: Op[]
  onChangeFolder(): Promise<void>
  onReviewConflicts?(): void
  conflicts?: ConflictRecord[]
}

export function ActivityView({ emptyMessage, folder: folderOverride, ops, onChangeFolder, onReviewConflicts, conflicts: conflictsOverride }: ActivityViewProps) {
  const { t } = useTranslation()
  const storedFolder = useAppStore((state) => state.folder)
  const folder = folderOverride ?? storedFolder
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setSelectedFilePath = useAppStore((state) => state.setSelectedFilePath)
  const activityViewMode = useAppStore((state) => state.activityViewMode)
  const setActivityViewMode = useAppStore((state) => state.setActivityViewMode)
  const storedConflicts = useAppStore((state) => state.conflicts)
  const conflicts = conflictsOverride ?? storedConflicts
  const [filter, setFilter] = useState<'all' | 'mine' | 'team' | 'ai'>('all')
  const [query, setQuery] = useState('')
  const [selectedOp, setSelectedOp] = useState<Op | undefined>()
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set())
  const [newChanges, setNewChanges] = useState(0)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())
  const [copiedSessionId, setCopiedSessionId] = useState<string | undefined>()
  const [contextMenu, setContextMenu] = useState<{ items: ContextMenuItem[]; x: number; y: number } | undefined>()
  const viewRef = useRef<HTMLElement>(null)
  const previousOpCount = useRef(ops.length)
  const visibleOps = useMemo(() => ops.filter((op) => {
    const kind = contributorKind(op)
    if (filter === 'mine' && kind !== 'me') return false
    if (filter === 'team' && kind !== 'teammate') return false
    if (filter === 'ai' && kind !== 'ai') return false
    const normalizedQuery = query.trim().toLowerCase()
    return op.filePath.toLowerCase().includes(normalizedQuery) || op.author.toLowerCase().includes(normalizedQuery)
  }), [filter, ops, query])
  const groups = useMemo(() => groupOpsByFile(visibleOps), [visibleOps])
  const sessions = useMemo(() => groupActivitySessions(visibleOps), [visibleOps])
  const fileCount = new Set(ops.map((op) => op.filePath)).size
  const hasAiActivity = ops.some((op) => contributorKind(op) === 'ai')

  const toggleFile = (filePath: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  const toggleSession = (sessionId: string): void => {
    setExpandedSessions((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const copySessionSummary = async (session: ActivitySession): Promise<void> => {
    const attribution = session.attribution === 'me'
      ? t('contributorMe')
      : session.attribution === 'ai' ? t('contributorAi')
        : session.attribution === 'teammate' ? t('contributorTeammate') : t('contributorUnknown')
    const summary = [
      `${session.author} — ${attribution}`,
      t('sessionChangesFiles').replace('{changes}', String(session.operationCount)).replace('{files}', String(session.fileCount)),
      `+${session.totalAdded} −${session.totalRemoved}`,
      '',
      `${t('sessionFilesLabel')}:`,
      ...session.filePaths.map((path) => `- ${path}`),
    ].join('\n')
    const result = await window.cairn.copyToClipboard(summary)
    if (!result.ok) return
    setCopiedSessionId(session.id)
    window.setTimeout(() => setCopiedSessionId((current) => current === session.id ? undefined : current), 1_500)
  }

  useEffect(() => {
    const added = ops.length - previousOpCount.current
    previousOpCount.current = ops.length
    if (added > 0 && (viewRef.current?.scrollTop ?? 0) > 24) {
      setNewChanges((count) => count + added)
    }
  }, [ops.length])

  const openFile = (filePath: string): void => {
    setSelectedFilePath(filePath)
    setActiveView('files')
  }

  return (
    <section
      ref={viewRef}
      className="view active"
      onScroll={() => {
        if ((viewRef.current?.scrollTop ?? 0) < 12) setNewChanges(0)
      }}
    >
      <div className="view-header">
        <h1 className="view-title">{t('activityTitle')}</h1>
        <span className="view-count">{t('activitySummary').replace('{changes}', String(ops.length)).replace('{files}', String(fileCount))}</span>
        <span className="view-spacer" />
        <div aria-label={t('activityMode')} className="activity-modes" role="group">
          {([
            ['grouped', 'activityGrouped'],
            ['raw', 'activityRaw'],
          ] as const).map(([mode, label]) => (
            <button
              aria-pressed={activityViewMode === mode}
              className={`filter-chip ${activityViewMode === mode ? 'active' : ''}`}
              key={mode}
              type="button"
              onClick={() => setActivityViewMode(mode)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div aria-label={t('filter')} className="activity-filters" role="group">
          {([
            ['all', 'allChanges'],
            ['mine', 'myChanges'],
            ['team', 'teamChanges'],
            ...(hasAiActivity ? [['ai', 'aiChanges']] : []),
          ] as Array<['all' | 'mine' | 'team' | 'ai', 'allChanges' | 'myChanges' | 'teamChanges' | 'aiChanges']>).map(([mode, label]) => (
            <button
              aria-pressed={filter === mode}
              className={`filter-chip ${filter === mode ? 'active' : ''}`}
              key={mode}
              type="button"
              onClick={() => setFilter(mode)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <label className="activity-search">
          <Search aria-hidden="true" size={14} />
          <span className="sr-only">{t('searchChanges')}</span>
          <input data-activity-search placeholder={t('searchChanges')} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
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

      {newChanges > 0 ? (
        <button
          className="activity-new-changes"
          type="button"
          onClick={() => {
            viewRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
            setNewChanges(0)
          }}
        >
          {t('newChanges').replace('{n}', String(newChanges))} ↓
        </button>
      ) : null}

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
            description={filter === 'team' ? t('remoteChangesEmpty') : t('emptyNoChangesDesc')}
            icon={Sparkles}
            title={t('emptyNoChanges')}
          />
        )
      ) : (
        activityViewMode === 'grouped' ? (
          <div className="activity-sessions">
            {sessions.map((session) => (
              <ActivitySessionRow
                copied={copiedSessionId === session.id}
                expanded={expandedSessions.has(session.id)}
                key={session.id}
                session={session}
                onCopySummary={(value) => void copySessionSummary(value)}
                onOpClick={setSelectedOp}
                onToggle={() => toggleSession(session.id)}
              />
            ))}
          </div>
        ) : (
          <div className="file-groups">
            {groups.map((group) => (
              <FileGroupRow
                key={group.filePath}
                expanded={expandedFiles.has(group.filePath)}
                group={group}
                onOpClick={setSelectedOp}
                onToggle={() => toggleFile(group.filePath)}
                onContextMenu={(event, filePath, latestOp) => setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { label: t('openFile'), onSelect: () => openFile(filePath) },
                    { label: t('copyPath'), onSelect: () => void window.cairn.copyToClipboard(filePath) },
                    { label: t('viewLatestDiff'), onSelect: () => setSelectedOp(latestOp) },
                  ],
                })}
              />
            ))}
          </div>
        )
      )}
      <OpDiffDialog open={selectedOp !== undefined} op={selectedOp} onClose={() => setSelectedOp(undefined)} />
      {contextMenu ? <ContextMenu items={contextMenu.items} position={contextMenu} onClose={() => setContextMenu(undefined)} /> : null}
    </section>
  )
}
