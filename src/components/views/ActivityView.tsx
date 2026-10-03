import { useMemo, useState } from 'react'

import { FolderOpen, SlidersHorizontal, Sparkles } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { FileGroupRow } from '@/components/FileGroupRow'
import { OpDiffDialog } from '@/components/OpDiffDialog'
import { useTranslation } from '@/i18n'
import { groupOpsByFile } from '@/lib/groupOpsByFile'
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
  const storedConflicts = useAppStore((state) => state.conflicts)
  const conflicts = conflictsOverride ?? storedConflicts
  const [remoteOnly, setRemoteOnly] = useState(false)
  const [selectedOp, setSelectedOp] = useState<Op | undefined>()
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set())
  const visibleOps = remoteOnly ? ops.filter((op) => op.source === 'remote') : ops
  const groups = useMemo(() => groupOpsByFile(visibleOps), [visibleOps])
  const fileCount = new Set(ops.map((op) => op.filePath)).size

  const toggleFile = (filePath: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

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
        <div className="file-groups">
          {groups.map((group) => (
            <FileGroupRow
              key={group.filePath}
              expanded={expandedFiles.has(group.filePath)}
              group={group}
              onOpClick={setSelectedOp}
              onToggle={() => toggleFile(group.filePath)}
            />
          ))}
        </div>
      )}
      <OpDiffDialog open={selectedOp !== undefined} op={selectedOp} onClose={() => setSelectedOp(undefined)} />
    </section>
  )
}
