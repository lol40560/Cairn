import { useEffect, useState } from 'react'

import { useTranslation } from '@/i18n'
import { redactErrorDetails, type NormalizedError } from '@/lib/errors'

export interface ToastMessage {
  hint?: string
  message: string
  tone?: 'error' | 'success'
}

export function Toast({ message, onDismiss }: { message: ToastMessage | NormalizedError | null; onDismiss(): void }) {
  const { t } = useTranslation()
  const [expandedMessage, setExpandedMessage] = useState<ToastMessage | NormalizedError | null>(null)
  const detailsOpen = message !== null && expandedMessage === message
  const [leavingMessage, setLeavingMessage] = useState<ToastMessage | NormalizedError | null>(null)

  useEffect(() => {
    if (!message || detailsOpen) {
      return
    }

    const tone = 'tone' in message ? message.tone ?? 'error' : 'error'
    // 成功訊息快速淡出；錯誤保留更久，避免使用者來不及閱讀。
    const lifetime = tone === 'success' ? 3_600 : 8_000
    const leaveTimer = window.setTimeout(() => setLeavingMessage(message), lifetime - 150)
    const dismissTimer = window.setTimeout(onDismiss, lifetime)
    return () => {
      window.clearTimeout(leaveTimer)
      window.clearTimeout(dismissTimer)
    }
  }, [message, onDismiss, detailsOpen])

  if (!message) {
    return null
  }

  const tone = 'tone' in message ? message.tone ?? 'error' : 'error'
  const leaving = !detailsOpen && leavingMessage === message
  const raw = 'raw' in message ? redactErrorDetails(message.raw) : undefined

  return (
    <aside aria-live={tone === 'error' ? 'assertive' : 'polite'} className={`toast${leaving ? ' is-leaving' : ''}`} data-tone={tone} style={raw ? { borderRadius: 12, maxWidth: 'min(520px, calc(100vw - 40px))' } : undefined} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{redactErrorDetails(message.message)}</p>
      {message.hint && <p className="toast-hint">{redactErrorDetails(message.hint)}</p>}
      {raw && (
        <>
          <details open={detailsOpen} onToggle={(event) => setExpandedMessage(event.currentTarget.open ? message : null)}>
            <summary style={{ cursor: 'pointer', marginTop: 8 }}>{t('errorDetails')}</summary>
            <pre style={{ maxHeight: 'min(220px, 35vh)', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, fontWeight: 400, marginTop: 8 }}>{raw}</pre>
          </details>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} type="button" onClick={onDismiss}>{t('close')}</button>
        </>
      )}
    </aside>
  )
}
