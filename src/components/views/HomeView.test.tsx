import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, describe, expect, it } from 'vitest'

import { HomeView } from './HomeView'
import { useAppStore } from '@/store/appStore'
import type { Op } from '@/types/cairn'

const initialState = useAppStore.getState()

afterEach(() => useAppStore.setState(initialState, true))

describe('HomeView project dashboard', () => {
  it('counts a local change made today, including on weekends', () => {
    const todayLabel = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()]
    const ops: Op[] = [{ author: 'Me', diff: '+change', filePath: 'src/app.ts', hash: 'today-change', id: 'today-change', parentHashes: [], source: 'local', timestamp: Date.now() }]
    const html = renderToStaticMarkup(<HomeView ops={ops} />)

    expect(html).toContain('aria-label="1 saved changes this week"')
    expect(html).toContain(`aria-label="${todayLabel}: 1 changes"`)
    expect(html.match(/overview-bar-column/g)).toHaveLength(7)
  })

  it('contains dashboard content but no project library', () => {
    const html = renderToStaticMarkup(<HomeView ops={[]} />)

    expect(html).toContain('Changes this week')
    expect(html).toContain('Synced changes')
    expect(html).not.toContain('project-card')
    expect(html).not.toContain('Recent projects')
  })
})
