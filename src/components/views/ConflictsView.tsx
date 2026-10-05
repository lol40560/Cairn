import { CheckCircle2 } from 'lucide-react'

import { ConflictCard } from '@/components/ConflictDialog'
import { EmptyState } from '@/components/EmptyState'
import { useTranslation } from '@/i18n'
import { useAppStore } from '@/store/appStore'
import type { ConflictRecord } from '@/types/cairn'

interface ConflictsViewProps {
  conflicts?: ConflictRecord[]
  onResolve?(opHash: string, resolution: 'local' | 'remote' | 'merged'): Promise<void>
  dirtyFilePaths?: string[]
}

/** 将持久化冲突直接呈现在独立视图中，解决后由调用方刷新 store。 */
export function ConflictsView({ conflicts: conflictsOverride, onResolve, dirtyFilePaths }: ConflictsViewProps) {
  const { t } = useTranslation()
  const storedConflicts = useAppStore((state) => state.conflicts)
  const conflicts = conflictsOverride ?? storedConflicts
  const hasConflicts = conflicts.length > 0
  const handleResolve = onResolve ?? (async () => undefined)

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('conflictsTitle')}</h1>
        <span className="view-count">{t('conflictsUnresolved').replace('{n}', String(conflicts.length))}</span>
      </div>

      {!hasConflicts ? (
        <EmptyState
          description={t('conflictsEmptyDesc2')}
          icon={CheckCircle2}
          title={t('conflictsEmpty')}
        />
      ) : (
        <div className="conflict-list conflict-view-list">
          {conflicts.map((conflict) => (
            <ConflictCard key={conflict.opHash} conflict={conflict} dirty={dirtyFilePaths?.includes(conflict.filePath)} onResolve={handleResolve} />
          ))}
        </div>
      )}
    </section>
  )
}
