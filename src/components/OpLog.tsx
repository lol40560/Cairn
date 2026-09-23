import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { countDiff } from '@/lib/diffStats'
import { useTranslation } from '@/i18n'
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

export function OpLog({ ops, emptyMessage }: OpLogProps) {
  const { locale, t } = useTranslation()

  if (ops.length === 0) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {emptyMessage ?? t('emptyState')}
        </p>
      </section>
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto">
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 border-b border-border bg-bg-0">
          <TableRow className="border-b border-border">
            <TableHead className="h-8 w-24 px-2 pl-6 text-xs font-medium uppercase tracking-normal text-text-2">{t('headerTime')}</TableHead>
            <TableHead className="h-8 w-32 px-2 text-xs font-medium uppercase tracking-normal text-text-2">{t('headerAuthor')}</TableHead>
            <TableHead className="h-8 px-2 text-xs font-medium uppercase tracking-normal text-text-2">{t('headerFile')}</TableHead>
            <TableHead className="h-8 w-20 px-2 text-right text-xs font-medium uppercase tracking-normal text-text-2">{t('headerChanges')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ops.map((op) => {
            const { added, removed } = countDiff(op.diff)

            return (
              <TableRow key={op.hash} className="h-11 border-b border-border/30 text-sm text-text-0 last:border-b-0 hover:bg-bg-1">
                <TableCell className="px-2 pl-6 font-mono text-text-1">
                  <span
                    className={
                      op.source === 'remote'
                        ? 'mr-2 inline-block size-2 rounded-full bg-peer-1'
                        : 'mr-2 inline-block size-2 rounded-full bg-primary'
                    }
                    title={op.source === 'remote' ? 'remote' : 'local'}
                  />
                  {formatTime(op.timestamp, locale)}
                </TableCell>
                <TableCell className="truncate px-2">{op.author}</TableCell>
                <TableCell className="truncate px-2 font-mono text-text-0">{op.filePath}</TableCell>
                <TableCell className="whitespace-nowrap px-2 text-right font-mono">
                  <span className="text-success/90">+{added}</span>{' '}
                  <span className="text-danger/90">-{removed}</span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
