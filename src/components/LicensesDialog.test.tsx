import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { filterLicenses } from '@/lib/licenses'
import { LicensesDialog } from './LicensesDialog'

describe('LicensesDialog', () => {
  it('渲染开源许可证标题与生产依赖列表', () => {
    const html = renderToStaticMarkup(<LicensesDialog open onClose={() => undefined} />)

    expect(html).toContain('Open Source Licenses')
    expect(html).toContain('@octokit/rest@')
  })

  it('按包名过滤许可证列表', () => {
    const results = filterLicenses([
      { license: 'MIT', name: 'alpha@1.0.0' },
      { license: 'ISC', name: 'bravo@1.0.0' },
    ], 'bravo')

    expect(results).toEqual([{ license: 'ISC', name: 'bravo@1.0.0' }])
  })
})
