import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectLocale, t } from './index'
import { en, zh } from './locales'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

let storage = new Map<string, string>()

function setLanguage(language: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language },
  })
}

beforeEach(() => {
  storage = new Map<string, string>()
  setLanguage('en-US')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
})

afterEach(() => {
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage')
  } else {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  }
  if (originalNavigator === undefined) {
    Reflect.deleteProperty(globalThis, 'navigator')
  } else {
    Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }
})

describe('i18n', () => {
  it('保持中文和英文的 key 集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('返回中文翻译', () => {
    expect(t('selectFolder', 'zh')).toBe('选择文件夹')
  })

  it('返回英文翻译', () => {
    expect(t('selectFolder', 'en')).toBe('Select Folder')
  })

  it('在系统语言为 zh-CN 时选择中文', () => {
    setLanguage('zh-CN')

    expect(detectLocale()).toBe('zh')
  })

  it('在系统语言为 en-US 时选择英文', () => {
    setLanguage('en-US')

    expect(detectLocale()).toBe('en')
  })

  it('navigator 不存在时回退英文', () => {
    Reflect.deleteProperty(globalThis, 'navigator')

    expect(detectLocale()).toBe('en')
  })

  it('优先使用 localStorage 中的语言', () => {
    setLanguage('en-US')
    globalThis.localStorage?.setItem('vibeswarm.locale', 'zh')

    expect(detectLocale()).toBe('zh')
  })

  it('在未知 key 时返回 key 本身', () => {
    expect(t('unknownKey' as never, 'zh')).toBe('unknownKey')
  })
})
