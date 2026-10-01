import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, describe, expect, it } from 'vitest'

import { TopBar } from './TopBar'
import { useAppStore } from '@/store/appStore'

const initialState = useAppStore.getState()

afterEach(() => useAppStore.setState(initialState, true))

describe('TopBar', () => {
  it('将项目名称作为切换项目入口呈现', () => {
    useAppStore.setState({ locale: 'en' })

    const html = renderToStaticMarkup(
      <TopBar folder="/Users/test/Project" opCount={2} roomCode="ABC123" status="watching" />,
    )

    expect(html).toContain('Switch project')
    expect(html).toContain('Project')
    expect(html).toContain('brand-chevron')
  })
})
