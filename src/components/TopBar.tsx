import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n'
import type { WatchStatus } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'

interface TopBarProps {
  folder: string
  status: WatchStatus
  onSelectFolder(): Promise<void>
  onToggleRoom(): void
  roomCode: string
  onSettings(): void
  githubConfigured?: boolean
}

const statusKeys: Record<WatchStatus, 'statusIdle' | 'statusWatching' | 'statusStopped'> = {
  idle: 'statusIdle',
  watching: 'statusWatching',
  stopped: 'statusStopped',
}

export function TopBar({
  folder,
  status,
  onSelectFolder,
  onToggleRoom,
  roomCode,
  onSettings,
  githubConfigured = false,
}: TopBarProps) {
  const { locale, t } = useTranslation()
  const setLocale = useAppStore((state) => state.setLocale)

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border bg-bg-0 px-4">
      <div className="flex min-w-0 items-center gap-3">
      <Button className="transition-colors hover:bg-bg-2" variant="outline" onClick={() => void onSelectFolder()}>{t('selectFolder')}</Button>
      <div className="max-w-md truncate font-mono text-xs text-text-2" title={folder}>
        {folder}
      </div>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-3"><span className="inline-flex items-center gap-2 text-xs text-text-2">{status === 'watching' && <span className="size-2 rounded-full bg-primary" />}{t(statusKeys[status])}</span><span className="h-4 w-px bg-border" />
      <Button className="transition-colors hover:bg-bg-2" size="sm" variant="ghost" onClick={onToggleRoom}>
        {t('room')}
      </Button>
      <Badge variant="outline">
        {roomCode === '' ? t('noRoom') : roomCode.slice(0, 3)}
      </Badge>
      <Button className="transition-colors hover:bg-bg-2" size="sm" variant="ghost" onClick={onSettings}>{githubConfigured && <span className="mr-1 inline-block size-2 rounded-full bg-success" />}{t('settings')}</Button>
      <Button
        aria-label="Switch language"
        size="sm"
        className="transition-colors hover:bg-bg-2"
        variant="ghost"
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      >
        {t('switchLanguage')}
      </Button>
      </div>
    </header>
  )
}
