import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { PrivacyDialog } from './PrivacyDialog'

describe('PrivacyDialog', () => {
  it('渲染内嵌隐私政策与关闭按钮', () => {
    const html = renderToStaticMarkup(<PrivacyDialog open onClose={() => undefined} />)

    expect(html).toContain('Privacy Policy')
    expect(html).toContain('What we collect')
    expect(html).toContain('Close')
  })
})
