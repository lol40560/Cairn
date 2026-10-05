import { useEffect, useState } from 'react'

import type { NormalizedError } from '@/lib/errors'

export interface ToastMessage {
  hint?: string
  message: string
  tone?: 'error' | 'success'
}

export function Toast({ message, onDismiss }: { message: ToastMessage | NormalizedError | null; onDismiss(): void }) {
  const [leavingMessage, setLeavingMessage] = useState<ToastMessage | NormalizedError | null>(null)

  useEffect(() => {
    if (!message) {
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
  }, [message, onDismiss])

  if (!message) {
    return null
  }

  const tone = 'tone' in message ? message.tone ?? 'error' : 'error'
  const leaving = leavingMessage === message

  return (
    <aside aria-live={tone === 'error' ? 'assertive' : 'polite'} className={`toast${leaving ? ' is-leaving' : ''}`} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{message.message}</p>
      {message.hint && <p className="toast-hint">{message.hint}</p>}
    </aside>
  )
}
