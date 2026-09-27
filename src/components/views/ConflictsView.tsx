import { useAppStore } from '@/store/appStore'
import { useTranslation, type TranslateFn } from '@/i18n'

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))

  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

export function ConflictsView() {
  const { t } = useTranslation()
  const conflicts = useAppStore((state) => state.conflicts)
  const clearConflicts = useAppStore((state) => state.clearConflicts)
  const removeConflict = useAppStore((state) => state.removeConflict)
  const hasConflicts = conflicts.length > 0

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('conflictsTitle')}</h1>
        <span className="view-count">{t('conflictsUnresolved').replace('{n}', String(conflicts.length))}</span>
        {hasConflicts && (
          <>
            <span className="view-spacer" />
            <button className="btn btn-ghost" type="button" onClick={clearConflicts}>
              {t('conflictsDismissAll')}
            </button>
          </>
        )}
      </div>

      {!hasConflicts ? (
        <div className="empty">
          <p className="empty-title">{t('conflictsEmpty')}</p>
          <p className="empty-desc">{t('conflictsEmptyDesc2')}</p>
        </div>
      ) : (
        <div className="conflict-list">
          {conflicts.map(({ op, timestamp }) => (
            <article key={op.hash} className="conflict-row">
              <div className="conflict-info">
                <p className="conflict-file">{op.filePath}</p>
                <p className="conflict-meta">
                  {op.author} · {formatRelativeTime(timestamp, t)} · {t('conflictsFrom').replace('{name}', op.author)}
                </p>
              </div>
              <button className="btn btn-ghost" type="button" onClick={() => removeConflict(op.hash)}>
                {t('conflictsIgnore')}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
