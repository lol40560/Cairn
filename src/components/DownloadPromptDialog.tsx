import { useEffect } from 'react'

import { useTranslation } from '@/i18n'
import { shouldCloseDialogFromBackdrop, shouldCloseDialogFromKey } from '@/lib/settingsDialog'
import type { SeederInfo } from '@/types/cairn'

export interface DownloadPromptDialogProps {
  open: boolean
  seeder: SeederInfo | undefined
  defaultTargetDir: string
  onConfirm(): void
  onSkip(): void
  onChangeTarget(): void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function DownloadPromptDialog({
  open,
  seeder,
  defaultTargetDir,
  onConfirm,
  onSkip,
  onChangeTarget,
}: DownloadPromptDialogProps) {
  const { t } = useTranslation()

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (shouldCloseDialogFromKey(event.key)) onSkip()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSkip, open])

  if (!open || !seeder) return null

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-prompt-title"
      onClick={(event) => {
        if (shouldCloseDialogFromBackdrop(event.target, event.currentTarget)) onSkip()
      }}
    >
      <section className="modal modal-compact">
        <header className="modal-header">
          <h2 id="download-prompt-title" className="modal-title">{t('downloadPromptTitle')}</h2>
        </header>
        <div className="modal-body download-prompt-body">
          <div className="download-prompt-project">
            <p className="download-prompt-name">{seeder.projectName}</p>
            <p className="download-prompt-meta">{t('downloadPromptFrom').replace('{peer}', seeder.peerId.slice(0, 8))}</p>
            <p className="download-prompt-meta">{t('downloadPromptSize').replace('{size}', formatBytes(seeder.size))}</p>
          </div>
          <div className="download-prompt-target">
            <span className="field-label">{t('downloadPromptSaveTo')}</span>
            <div className="download-prompt-target-row">
              <code title={defaultTargetDir}>{defaultTargetDir}</code>
              <button className="btn btn-ghost" type="button" onClick={onChangeTarget}>{t('downloadPromptChange')}</button>
            </div>
          </div>
          <footer className="modal-actions">
            <button className="btn btn-primary" type="button" onClick={onConfirm}>{t('downloadPromptConfirm')}</button>
            <button className="btn btn-ghost" type="button" onClick={onSkip}>{t('downloadPromptSkip')}</button>
          </footer>
        </div>
      </section>
    </div>
  )
}
