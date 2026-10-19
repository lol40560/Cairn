import { useEffect, useState } from 'react'

/** Load the local Monaco runtime only when an editor or diff is actually visible. */
export function useMonacoReady(active = true): boolean {
  const [ready, setReady] = useState(() => typeof window === 'undefined')

  useEffect(() => {
    if (!active || ready) return
    let disposed = false
    void import('./monaco-setup').then(() => {
      if (!disposed) setReady(true)
    }).catch((error: unknown) => {
      console.error('[cairn:monaco] Unable to load the local editor runtime', error)
    })
    return () => { disposed = true }
  }, [active, ready])

  return ready
}
