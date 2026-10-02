import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  const props = {
    cancelLabel: 'Cancel',
    confirmLabel: 'Discard',
    message: 'You have unsaved changes.',
    onCancel: () => undefined,
    onConfirm: () => undefined,
    open: true,
    title: 'Discard unsaved changes?',
  }

  it('关闭时不渲染', () => {
    expect(renderToStaticMarkup(<ConfirmDialog {...props} open={false} />)).toBe('')
  })

  it('渲染标题、提示与操作按钮', () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...props} />)

    expect(html).toContain('Discard unsaved changes?')
    expect(html).toContain('You have unsaved changes.')
    expect(html).toContain('Cancel')
    expect(html).toContain('Discard')
  })

  it('危险确认使用红色按钮样式', () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...props} danger />)

    expect(html).toContain('btn-danger')
  })
})
