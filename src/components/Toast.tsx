import { useEffect } from 'react'

import type { NormalizedError } from '@/lib/errors'

export function Toast({ error, onDismiss }: { error: NormalizedError | null; onDismiss(): void }) {
  useEffect(() => {
    if (!error) {
      return
    }

    const timer = window.setTimeout(onDismiss, 5000)
    return () => window.clearTimeout(timer)
  }, [error, onDismiss])

  if (!error) {
    return null
  }

  return (
    <aside className="fixed bottom-4 right-4 z-30 max-w-sm rounded-md bg-destructive p-3 text-sm text-destructive-foreground shadow">
      <p>{error.message}</p>
      {error.hint && <p className="mt-1">{error.hint}</p>}
    </aside>
  )
}
