import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectsView } from './ProjectsView'
import { useAppStore } from '@/store/appStore'

const initialState = useAppStore.getState()
const openProject = vi.fn(async () => undefined)

afterEach(() => {
  useAppStore.setState(initialState, true)
  openProject.mockClear()
})

describe('ProjectsView', () => {
  it('renders the project library independently from the dashboard', () => {
    const html = renderToStaticMarkup(<ProjectsView activeProjectPath="" onOpenProject={openProject} projects={[{
      available: true,
      id: 'project-1',
      isFavorite: true,
      lastOpenedAt: Date.now(),
      name: 'VibeSwarmTest',
      path: '/Users/test/VibeSwarmTest',
    }]} />)

    expect(html).toContain('Projects')
    expect(html).toContain('Manage your local workspaces')
    expect(html).toContain('VibeSwarmTest')
    expect(html).toContain('project-card')
    expect(html).toContain('aria-label="Project actions: VibeSwarmTest"')
    expect(html).not.toContain('Changes this week')
  })

  it('shows missing projects and an empty-library action', () => {
    const missingHtml = renderToStaticMarkup(<ProjectsView activeProjectPath="" onOpenProject={openProject} projects={[{
      available: false,
      id: 'missing-project',
      isFavorite: false,
      lastOpenedAt: Date.now(),
      name: 'Missing',
      path: '/Users/test/Missing',
    }]} />)
    const emptyHtml = renderToStaticMarkup(<ProjectsView activeProjectPath="" onOpenProject={openProject} projects={[]} />)

    expect(missingHtml).toContain('project-card missing')
    expect(missingHtml).toContain('Folder not found')
    expect(missingHtml).toContain('Relocate')
    expect(emptyHtml).toContain('No projects yet')
    expect(emptyHtml).toContain('Add project')
  })
})
