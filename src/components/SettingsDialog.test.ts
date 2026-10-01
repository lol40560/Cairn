import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SettingsDialog } from './SettingsDialog'

import {
  shouldCloseDialogFromBackdrop,
  shouldCloseDialogFromKey,
  updateGeneralSettings,
} from '../lib/settingsDialog'

describe('SettingsDialog', () => {
  it('渲染 About 分组与 package.json 版本', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, {
      onClose: () => undefined,
      onConfigured: () => undefined,
      onShowOnboarding: () => undefined,
      open: true,
    }))

    expect(html).toContain('About')
    expect(html).toContain('1.0.0')
  })

  it('Esc 按下后会触发关闭条件', () => {
    const onClose = vi.fn()
    if (shouldCloseDialogFromKey('Escape')) onClose()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('点击遮罩后会触发关闭条件，点击内部不会', () => {
    const onClose = vi.fn(); const backdrop = new EventTarget(); const inside = new EventTarget()
    if (shouldCloseDialogFromBackdrop(backdrop, backdrop)) onClose()
    if (shouldCloseDialogFromBackdrop(inside, backdrop)) onClose()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('两个通用开关会立即调用 updateSettings', async () => {
    const updateSettings = vi.fn(async () => ({ data: undefined, ok: true }) as const)

    await updateGeneralSettings({ rememberLastFolder: false }, updateSettings)
    await updateGeneralSettings({ autoStartWatching: false }, updateSettings)

    expect(updateSettings).toHaveBeenNthCalledWith(1, { rememberLastFolder: false })
    expect(updateSettings).toHaveBeenNthCalledWith(2, { autoStartWatching: false })
  })
})
