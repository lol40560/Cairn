import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { App } from './App'

describe('App startup state', () => {
  it('在会话恢复完成前立即渲染加载遮罩', () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('Loading your project...')
    expect(html).toContain('startup-overlay')
  })
})
