import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n'
import type { Op } from '@/types/cairn'

export function ConflictPanel({ conflicts, onIgnore }: { conflicts: Array<{ op: Op; localContent: string; timestamp: number }>; onIgnore(hash: string): void }) {
  const { t } = useTranslation()
  return <section className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-bg-1 px-4"><p className={`text-xs font-medium ${conflicts.length > 0 ? 'text-danger' : ''}`}>{conflicts.length > 0 && <span className="mr-2 inline-block size-2 rounded-full bg-danger" />}{t('conflictTitle')}</p>{conflicts.length === 0 ? <p className="text-xs text-text-2">{t('noConflicts')}</p> : conflicts.map(({ op, timestamp }) => <div key={op.hash} className="flex items-center gap-2 text-xs"><span>{op.filePath}</span><span>{new Date(timestamp).toLocaleTimeString()}</span><span>{t('conflictHint')}</span><Button size="sm" variant="ghost" onClick={() => onIgnore(op.hash)}>{t('ignore')}</Button></div>)}</section>
}
