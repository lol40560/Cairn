import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SearchPalette } from '@/components/SearchPalette'

describe('SearchPalette', () => {
  const items = [
    { id: 'activity', label: 'Activity', shortcut: '⌘2' },
    { detail: 'src/components', id: 'files', label: 'Files' },
  ]

  it('does not render while closed', () => {
    expect(renderToStaticMarkup(
      <SearchPalette emptyLabel="No commands" items={items} open={false} placeholder="Search" title="Commands" onClose={() => undefined} onSelect={() => undefined} />,
    )).toBe('')
  })

  it('renders a keyboard-navigable command list when open', () => {
    const html = renderToStaticMarkup(
      <SearchPalette emptyLabel="No commands" items={items} open placeholder="Search" title="Commands" onClose={() => undefined} onSelect={() => undefined} />,
    )

    expect(html).toContain('Activity')
    expect(html).toContain('⌘2')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="option"')
  })
})
