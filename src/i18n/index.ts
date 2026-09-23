import { useCallback } from 'react'

import { useAppStore } from '../store/appStore'

import { t, type Locale, type TranslationKey } from './locales'

export { detectLocale, persistLocale, t } from './locales'

export function useTranslation(): {
  t: (key: TranslationKey) => string
  locale: Locale
} {
  const locale = useAppStore((state) => state.locale)
  const translate = useCallback((key: TranslationKey) => t(key, locale), [locale])

  return {
    locale,
    t: translate,
  }
}

export type { Locale, TranslationKey } from './locales'
export type TranslateFn = (key: TranslationKey) => string
