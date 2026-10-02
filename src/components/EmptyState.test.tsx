import { Circle } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it, vi } from 'vitest'

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('渲染标题与说明', () => {
    const html = renderToStaticMarkup(<EmptyState description="A helpful next step." title="Nothing here yet" />)

    expect(html).toContain('Nothing here yet')
    expect(html).toContain('A helpful next step.')
  })

  it('传入图标时渲染图标容器', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Circle} title="Nothing here yet" />)

    expect(html).toContain('empty-state-icon')
  })

  it('渲染操作并保留操作回调', () => {
    const onClick = vi.fn()
    const actions = [{ label: 'Choose a folder', onClick, variant: 'primary' as const }]
    const html = renderToStaticMarkup(<EmptyState actions={actions} title="Nothing here yet" />)

    actions[0]?.onClick()

    expect(html).toContain('Choose a folder')
    expect(html).toContain('btn-primary')
    expect(onClick).toHaveBeenCalledOnce()
  })
})
