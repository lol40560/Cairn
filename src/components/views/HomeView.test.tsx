import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, describe, expect, it } from 'vitest'

import { HomeView } from './HomeView'
import { useAppStore } from '@/store/appStore'

const initialState = useAppStore.getState()

afterEach(() => useAppStore.setState(initialState, true))

describe('HomeView', () => {
  it('渲染可用项目卡片', () => {
    const html = renderToStaticMarkup(<HomeView projects={[{
        available: true,
        id: 'project-1',
        isFavorite: true,
        lastOpenedAt: Date.now(),
        name: 'VibeSwarmTest',
        path: '/Users/test/VibeSwarmTest',
      }]} />)

    expect(html).toContain('Home')
    expect(html).toContain('VibeSwarmTest')
    expect(html).toContain('project-card')
    expect(html).toContain('Add project')
  })

  it('缺失项目显示失效状态与操作按钮', () => {
    const html = renderToStaticMarkup(<HomeView projects={[{
        available: false,
        id: 'missing-project',
        isFavorite: false,
        lastOpenedAt: Date.now(),
        name: 'Missing',
        path: '/Users/test/Missing',
      }]} />)

    expect(html).toContain('project-card missing')
    expect(html).toContain('Folder not found')
    expect(html).toContain('Remove')
    expect(html).toContain('Relocate')
  })

  it('没有项目时显示空状态与添加入口', () => {
    const html = renderToStaticMarkup(<HomeView projects={[]} />)

    expect(html).toContain('No projects yet')
    expect(html).toContain('Add a project to get started.')
    expect(html).toContain('Add project')
  })
})
