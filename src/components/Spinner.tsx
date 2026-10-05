interface SpinnerProps {
  /** 小型載入提示共用同一個視覺與動畫語言。 */
  size?: 12 | 16 | 20
}

export function Spinner({ size = 16 }: SpinnerProps) {
  return <span aria-hidden="true" className="spinner" style={{ '--spinner-size': `${size}px` } as CSSProperties} />
}
import type { CSSProperties } from 'react'
