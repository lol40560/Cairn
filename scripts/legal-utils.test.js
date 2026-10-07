import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  getProductionLicenseInventory,
  renderLicenseJson,
  renderLegalContentModule,
  renderPrivacyMarkdown,
  renderThirdPartyNotices,
  staleArtifactPaths,
  validateLicenseEntry,
} from './legal-utils.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('legal artifact generation', () => {
  it('includes the runtime dependency inventory, fonts, and full license text while excluding dev-only Electron', async () => {
    const inventory = await getProductionLicenseInventory(projectRoot)
    const names = new Set(inventory.map((entry) => entry.name))

    expect(names).toContain('@fontsource/inter')
    expect(names).toContain('@fontsource/jetbrains-mono')
    expect(names).toContain('@monaco-editor/react')
    expect(names).toContain('monaco-editor')
    expect(names).toContain('node-diff3')
    expect(names).toContain('ignore')
    expect(names).toContain('dompurify')
    expect(names).toContain('marked')
    expect(names).toContain('state-local')
    expect(names).toContain('lucide-react')
    expect(names).not.toContain('electron')
    expect(inventory.every((entry) => entry.licenseText.length > 0)).toBe(true)
  })

  it('preserves SPDX expressions and produces deterministic artifacts without local paths', async () => {
    const inventory = await getProductionLicenseInventory(projectRoot)
    const dompurify = inventory.find((entry) => entry.name === 'dompurify')
    const first = `${renderLicenseJson(inventory)}\n${renderThirdPartyNotices(inventory)}`
    const second = `${renderLicenseJson(inventory)}\n${renderThirdPartyNotices(inventory)}`

    expect(dompurify?.license).toBe('(MPL-2.0 OR Apache-2.0)')
    expect(first).toBe(second)
    expect(first).not.toContain(projectRoot)
  })

  it('rejects unknown licenses and reports stale generated artifacts', async () => {
    expect(() => validateLicenseEntry({ name: 'unknown-package', version: '1.0.0' }, { packages: {} })).toThrow('Unknown or unreviewed license')
    expect(staleArtifactPaths(new Map([['artifact', 'expected']]), new Map([['artifact', 'actual']]))).toEqual(['artifact'])

    const generated = JSON.parse(await readFile(path.join(projectRoot, 'build', 'licenses.json'), 'utf8'))
    const inventory = await getProductionLicenseInventory(projectRoot)
    expect(generated.packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual(inventory.map((entry) => `${entry.name}@${entry.version}`))
  })

  it('keeps repository privacy text, packaged UI text, and packaged legal resources synchronized', async () => {
    const [policy, privacyMarkdown, generatedModule, packageJson] = await Promise.all([
      readFile(path.join(projectRoot, 'legal', 'privacy-policy.json'), 'utf8').then(JSON.parse),
      readFile(path.join(projectRoot, 'PRIVACY.md'), 'utf8'),
      readFile(path.join(projectRoot, 'src', 'lib', 'generated-legal-content.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    ])
    const resources = packageJson.build.extraResources.map((resource) => resource.from)

    expect(privacyMarkdown).toBe(renderPrivacyMarkdown(policy.en))
    expect(generatedModule).toBe(renderLegalContentModule(policy))
    expect(resources).toEqual(expect.arrayContaining(['LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'build/licenses.json']))
  })
})
