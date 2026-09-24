import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n'
import type { Op } from '@/types/cairn'

interface ConflictPanelProps {
  conflicts: Array<{ op: Op; localContent: string; timestamp: number }>
  onIgnore(hash: string): void
}

export function ConflictPanel({ conflicts, onIgnore }: ConflictPanelProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const hasConflicts = conflicts.length > 0

  return (
    <section className={`shrink-0 border-t border-border ${hasConflicts ? 'bg-danger/5' : 'bg-bg-1'}`}>
      <div className="flex h-10 items-center gap-3 px-4">
        {hasConflicts ? (
          <button
            aria-expanded={expanded}
            className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-danger"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="size-1.5 rounded-full bg-danger" />
            {t('conflictTitle')}
          </button>
        ) : (
          <span className="text-xs font-medium uppercase tracking-wider text-text-2">{t('conflictTitle')}</span>
        )}

        {hasConflicts ? (
          <button
            aria-label={t('conflictTitle')}
            className="rounded bg-danger/10 px-2 py-0.5 text-xs text-danger"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {conflicts.length}
          </button>
        ) : (
          <span className="text-xs text-text-2">{t('noConflicts')}</span>
        )}
      </div>

      {hasConflicts && expanded && (
        <div className="border-t border-danger/10 px-4 py-2">
          {conflicts.map(({ op, timestamp }) => (
            <div key={op.hash} className="flex min-h-8 items-center gap-3 text-xs text-text-1">
              <span className="size-1.5 shrink-0 rounded-full bg-danger" />
              <span className="min-w-0 flex-1 truncate font-mono text-text-0">{op.filePath}</span>
              <span>{t('peers')}: {op.author}</span>
              <time className="font-mono text-text-2">{new Date(timestamp).toLocaleTimeString()}</time>
              <Button size="sm" variant="ghost" onClick={() => onIgnore(op.hash)}>
                {t('ignore')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
