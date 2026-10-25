import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'

import { monacoDompurifyPlugin } from './monaco-dompurify.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const projectRequire = createRequire(join(projectRoot, 'package.json'))
const monacoEntry = projectRequire.resolve('monaco-editor')
const monacoRoot = resolve(dirname(monacoEntry), '../..')
const sanitizerModule = join(monacoRoot, 'esm/vs/base/browser/domSanitize.js')
const vendoredSanitizer = join(monacoRoot, 'esm/vs/base/browser/dompurify/dompurify.js')
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(version) {
  const root = await mkdtemp(join(tmpdir(), 'cairn-sanitizer-'))
  roots.push(root)
  const monaco = join(root, 'node_modules/monaco-editor')
  const sanitizer = join(root, 'node_modules/dompurify')
  await mkdir(monaco, { recursive: true })
  await mkdir(join(sanitizer, 'dist'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'package.json'), '{}'),
    writeFile(join(monaco, 'package.json'), JSON.stringify({ name: 'monaco-editor', main: 'index.js' })),
    writeFile(join(monaco, 'index.js'), ''),
    writeFile(join(sanitizer, 'package.json'), JSON.stringify({ name: 'dompurify', version, main: 'dist/purify.cjs.js' })),
    writeFile(join(sanitizer, 'dist/purify.cjs.js'), ''),
    writeFile(join(sanitizer, 'dist/purify.es.mjs'), 'export default {};'),
  ])
  return root
}

describe('Monaco uses the patched sanitizer', () => {
  it.each(['3.4.15', '3.4.16', '3.4.17-rc.1', '2.5.8'])('rejects unpatched or incompatible DOMPurify %s', async (version) => {
    const root = await fixture(version)
    expect(() => monacoDompurifyPlugin(root)).toThrow('at least 3.4.17')
  })

  it('only redirects the vendored import from Monaco, preserving unrelated module resolution', () => {
    const plugin = monacoDompurifyPlugin(projectRoot)
    const id = plugin.resolveId('./dompurify/dompurify.js', sanitizerModule)
    expect(id.replaceAll('\\', '/')).toMatch(/\/dompurify\/dist\/purify\.es\.mjs$/)
    expect(plugin.resolveId('./dompurify/dompurify.js', '/project/src/other.js')).toBeNull()
    expect(plugin.resolveId('./unrelated.js', sanitizerModule)).toBeNull()
  })

  it('fails closed if a future import bypasses the sanitizer redirect', () => {
    const plugin = monacoDompurifyPlugin(projectRoot)
    expect(() => plugin.generateBundle.call({
      getModuleIds: () => [vendoredSanitizer],
      error: (message) => { throw new Error(message) },
    })).toThrow('vendored DOMPurify')
  })

  it('resolves and audits ordinary Windows module paths', () => {
    const plugin = monacoDompurifyPlugin(projectRoot)
    const importer = String.raw`C:\project\node_modules\monaco-editor\esm\vs\base\browser\domSanitize.js?worker`
    expect(plugin.resolveId('./dompurify/dompurify.js', importer)).not.toBeNull()
    const vendored = String.raw`C:\project\node_modules\monaco-editor\esm\vs\base\browser\dompurify\dompurify.js`
    expect(() => plugin.generateBundle.call({
      getModuleIds: () => [vendored],
      error: (message) => { throw new Error(message) },
    })).toThrow('vendored DOMPurify')
  })

  it('builds Monaco’s actual HTML sanitizer with the patched module and no vendored copy', async () => {
    const { default: electronConfig } = await import('../electron.vite.config.ts')
    const result = await build({
      configFile: false,
      root: projectRoot,
      logLevel: 'silent',
      // Use the application's configuration so removing its plugin registration also fails this regression.
      plugins: electronConfig.renderer.plugins,
      build: {
        write: false,
        minify: false,
        lib: { entry: sanitizerModule, formats: ['es'] },
      },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
    const modules = outputs.flatMap((output) => output.type === 'chunk' ? Object.keys(output.modules) : [])
    expect(modules.some((id) => id.replaceAll('\\', '/').endsWith('/dompurify/dist/purify.es.mjs'))).toBe(true)
    expect(modules).not.toContain(vendoredSanitizer)
    const output = outputs.filter((entry) => entry.type === 'chunk').map((entry) => entry.code).join('\n')
    expect(output).toContain('3.4.17')
    expect(output).not.toContain('DOMPurify 3.4.15')
  }, 20_000)
})
