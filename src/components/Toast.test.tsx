import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Toast } from './Toast'

describe('Toast diagnostics', () => {
  it('offers accessible, expandable local details without exposing credentials', () => {
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const html = renderToStaticMarkup(<Toast message={{ category: 'network', message: 'Connection failed', raw: `Error: ECONNREFUSED 192.168.1.2:59728 invite=${secret} token=private-token` }} onDismiss={() => undefined} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('<details>')
    expect(html).toContain('Show details (credentials hidden)')
    expect(html).toContain('192.168.1.2:59728')
    expect(html).toContain('Close')
    expect(html).not.toContain(secret)
    expect(html).not.toContain('private-token')
  })

  it('keeps success notices concise', () => {
    const html = renderToStaticMarkup(<Toast message={{ message: 'Joined team', tone: 'success' }} onDismiss={() => undefined} />)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('<details>')
  })
})
