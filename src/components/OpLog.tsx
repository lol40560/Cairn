import { countDiff } from '@/lib/diffStats'
import { useTranslation } from '@/i18n'
import type { TranslateFn } from '@/i18n'
import type { Op } from '@/types/cairn'

interface OpLogProps {
  ops: Op[]
  emptyMessage?: string
}

function formatTime(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) {
    return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

function getRecentOps(ops: Op[]): Op[] {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  return ops.filter((op) => op.timestamp >= dayAgo)
}

export function OpLog({ ops, emptyMessage }: OpLogProps) {
  const { locale, t } = useTranslation()
  const recentOps = getRecentOps(ops)
  const summaryOps = recentOps.length > 0 ? recentOps : ops
  const uniqueFiles = new Set(summaryOps.map((op) => op.filePath))

  if (ops.length === 0) {
    return <section className="flex min-h-0 flex-1 items-center justify-center px-4"><p className="text-sm text-text-2">{emptyMessage ?? t('emptyState')}</p></section>
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto pt-6 pb-6">
      <div className="mx-6 mb-3 border-b border-border/40 pb-3"><p className="text-xs font-medium uppercase tracking-wider text-text-2">{t(recentOps.length > 0 ? 'activityLast24h' : 'activityAll')}</p><p className="mt-1 text-sm text-text-1">{t('activitySummary').replace('{changes}', String(summaryOps.length)).replace('{files}', String(uniqueFiles.size))}</p></div>
      {ops.map((op) => {
        const { added, removed } = countDiff(op.diff)
        const dot = op.source === 'remote' ? 'bg-peer-1' : 'bg-primary'
        return <article key={op.hash} className="mx-6 flex h-16 items-center rounded-md hover:bg-bg-1/40"><div className="flex w-32 shrink-0 items-center gap-3"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} /><time className="font-mono text-xs text-text-2">{formatTime(op.timestamp, locale)}</time></div><div className="min-w-0 flex-1"><p className="truncate text-[15px] font-medium text-text-0">{op.filePath}</p><p className="mt-1 truncate text-xs text-text-2">{op.author} · {formatRelativeTime(op.timestamp, t)}</p></div><div className="w-20 shrink-0 pr-4 text-right font-mono text-xs"><span className="text-text-2">+{added}</span>{'  '}<span className="text-danger/70">−{removed}</span></div></article>
      })}
    </section>
  )
}
