import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import { ArrowLeft, ArrowRight, X } from 'lucide-react'

import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales'
import { saveProductTourCompletion } from '@/lib/productTour'
import type { ViewType } from '@/store/appStore'

interface TourStep {
  descriptionKey: TranslationKey
  fallbackSelector: string
  selector: string
  titleKey: TranslationKey
  view: ViewType
}

const TOUR_STEPS: TourStep[] = [
  { descriptionKey: 'tourHomeDescription', fallbackSelector: '[data-tour="nav-home"]', selector: '[data-tour="home-overview"]', titleKey: 'tourHomeTitle', view: 'home' },
  { descriptionKey: 'tourActivityDescription', fallbackSelector: '[data-tour="nav-activity"]', selector: '[data-tour="activity"]', titleKey: 'tourActivityTitle', view: 'activity' },
  { descriptionKey: 'tourFilesDescription', fallbackSelector: '[data-tour="nav-files"]', selector: '[data-tour="files"]', titleKey: 'tourFilesTitle', view: 'files' },
  { descriptionKey: 'tourTeamDescription', fallbackSelector: '[data-tour="nav-room"]', selector: '[data-tour="team"]', titleKey: 'tourTeamTitle', view: 'room' },
  { descriptionKey: 'tourRecoveryDescription', fallbackSelector: '[data-tour="nav-checkpoints"]', selector: '[data-tour="checkpoints"]', titleKey: 'tourRecoveryTitle', view: 'checkpoints' },
  { descriptionKey: 'tourSearchDescription', fallbackSelector: '[data-tour="search"]', selector: '[data-tour="search"]', titleKey: 'tourSearchTitle', view: 'home' },
]

function getTargetRect(step: TourStep): DOMRect | undefined {
  return (document.querySelector(step.selector) ?? document.querySelector(step.fallbackSelector))?.getBoundingClientRect()
}

export function ProductTour({ onClose, onViewChange }: { onClose(): void; onViewChange(view: ViewType): void }) {
  const { t } = useTranslation()
  const [stepIndex, setStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<DOMRect>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const step = TOUR_STEPS[stepIndex]!

  const finish = useCallback((): void => {
    saveProductTourCompletion()
    onClose()
  }, [onClose])

  const next = useCallback((): void => {
    if (stepIndex === TOUR_STEPS.length - 1) {
      finish()
      return
    }
    setStepIndex((index) => index + 1)
  }, [finish, stepIndex])

  useLayoutEffect(() => {
    onViewChange(step.view)
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setTargetRect(getTargetRect(step))
        headingRef.current?.focus()
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [onViewChange, step])

  useEffect(() => {
    const updatePosition = (): void => setTargetRect(getTargetRect(step))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish()
      if (event.key === 'ArrowRight') next()
      if (event.key === 'ArrowLeft' && stepIndex > 0) setStepIndex((index) => index - 1)
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [finish, next, step, stepIndex])

  const spotlightStyle: CSSProperties | undefined = targetRect ? {
    height: targetRect.height + 16,
    left: targetRect.left - 8,
    top: targetRect.top - 8,
    width: targetRect.width + 16,
  } : undefined
  const popoverStyle: CSSProperties = targetRect ? {
    left: Math.min(window.innerWidth - 376, Math.max(16, targetRect.left)),
    top: targetRect.bottom + 260 < window.innerHeight
      ? targetRect.bottom + 20
      : Math.max(16, targetRect.top - 246),
  } : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div aria-label={t('tourTitle')} aria-modal="true" className="product-tour" role="dialog">
      {spotlightStyle ? <div aria-hidden="true" className="product-tour-spotlight" style={spotlightStyle} /> : <div aria-hidden="true" className="product-tour-backdrop" />}
      <section className="product-tour-popover" style={popoverStyle}>
        <div className="product-tour-topline">
          <span>{t('tourStep').replace('{current}', String(stepIndex + 1)).replace('{total}', String(TOUR_STEPS.length))}</span>
          <button aria-label={t('tourSkip')} className="product-tour-close" type="button" onClick={finish}><X aria-hidden="true" size={17} /></button>
        </div>
        <div aria-hidden="true" className="product-tour-progress"><span style={{ width: `${((stepIndex + 1) / TOUR_STEPS.length) * 100}%` }} /></div>
        <h2 ref={headingRef} tabIndex={-1}>{t(step.titleKey)}</h2>
        <p>{t(step.descriptionKey)}</p>
        <footer>
          <button className="btn btn-ghost" disabled={stepIndex === 0} type="button" onClick={() => setStepIndex((index) => Math.max(0, index - 1))}><ArrowLeft aria-hidden="true" size={15} />{t('tourBack')}</button>
          <button className="btn btn-primary" type="button" onClick={next}>{stepIndex === TOUR_STEPS.length - 1 ? t('tourFinish') : t('tourNext')}<ArrowRight aria-hidden="true" size={15} /></button>
        </footer>
      </section>
    </div>
  )
}
