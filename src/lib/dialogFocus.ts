import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Keeps keyboard focus inside a modal and restores it to the opener on close. */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined

    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => {
      const initialTarget = initialFocusRef?.current
        ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)
        ?? dialogRef.current
      initialTarget?.focus()
    }, 0)

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [initialFocusRef, onClose, open])

  return dialogRef
}
