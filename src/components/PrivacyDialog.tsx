import { useEffect } from 'react'

import { useTranslation } from '@/i18n'
import { PRIVACY_POLICY_EN, PRIVACY_POLICY_ZH } from '@/lib/legal-content'
import { shouldCloseDialogFromBackdrop, shouldCloseDialogFromKey } from '@/lib/settingsDialog'

export function PrivacyDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { locale, t } = useTranslation()

  const openOnGithub = async (): Promise<void> => {
    const result = await window.cairn.openExternal('https://github.com/lol40560/Cairn/blob/main/PRIVACY.md')
    if (!result.ok) {
      console.error('[cairn] 无法打开 GitHub 隐私政策', result.error)
    }
  }

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (shouldCloseDialogFromKey(event.key)) onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  const content = locale === 'zh' ? PRIVACY_POLICY_ZH : PRIVACY_POLICY_EN

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-dialog-title"
      onClick={(event) => {
        if (shouldCloseDialogFromBackdrop(event.target, event.currentTarget)) onClose()
      }}
    >
      <section className="modal privacy-modal">
        <header className="modal-header">
          <h2 id="privacy-dialog-title" className="modal-title">{t('privacyPolicyTitle')}</h2>
          <button aria-label={t('close')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body privacy-body">
          <pre className="privacy-content">{content}</pre>
          <footer className="modal-actions">
            <button className="btn btn-ghost" type="button" onClick={() => void openOnGithub()}>{t('openOnGithub')}</button>
            <button className="btn btn-ghost" type="button" onClick={onClose}>{t('close')}</button>
          </footer>
        </div>
      </section>
    </div>
  )
}
