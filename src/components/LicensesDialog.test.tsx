import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { filterLicenses } from '@/lib/licenses'
import { LicensesDialog } from './LicensesDialog'

describe('LicensesDialog', () => {
  it('渲染开源许可证标题与生产依赖列表', () => {
    const html = renderToStaticMarkup(<LicensesDialog open onClose={() => undefined} />)

    expect(html).toContain('Open Source Licenses')
    expect(html).toContain('@octokit/rest@')
    expect(html).not.toContain('Full license text is not included in this license list.')
  })

  it('按包名过滤许可证列表', () => {
    const results = filterLicenses([
      { license: 'MIT', licenseText: 'MIT text', name: 'alpha', version: '1.0.0' },
      { license: 'ISC', licenseText: 'ISC text', name: 'bravo', version: '1.0.0' },
    ], 'bravo')

    expect(results).toEqual([{ license: 'ISC', licenseText: 'ISC text', name: 'bravo', version: '1.0.0' }])
  })
})
