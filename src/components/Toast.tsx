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

    const leaveTimer = window.setTimeout(() => setLeavingMessage(message), 5_850)
    const dismissTimer = window.setTimeout(onDismiss, 6_000)
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
    <aside className={`toast${leaving ? ' is-leaving' : ''}`} data-tone={tone} role="status">
      <p>{message.message}</p>
      {message.hint && <p className="toast-hint">{message.hint}</p>}
    </aside>
  )
}
