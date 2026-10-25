import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const normalizeModuleId = (id) => id.split('?')[0].replaceAll('\\', '/')
const isMonacoModule = (id) => /\/node_modules\/monaco-editor\/esm\//.test(normalizeModuleId(id))
const isVendoredSanitizer = (id) => /\/node_modules\/monaco-editor\/esm\/vs\/base\/browser\/dompurify\/dompurify\.js$/.test(normalizeModuleId(id))
const isMonacoSanitizer = (id) => /\/node_modules\/monaco-editor\/esm\/vs\/base\/browser\/domSanitize\.js$/.test(normalizeModuleId(id))

/** Monaco 0.57 embeds DOMPurify separately from its npm dependency. */
export function monacoDompurifyPlugin(projectRoot) {
  const projectRequire = createRequire(join(resolve(projectRoot), 'package.json'))
  const monacoRequire = createRequire(projectRequire.resolve('monaco-editor'))
  const installedEntry = monacoRequire.resolve('dompurify')
  const packageRoot = dirname(dirname(installedEntry))
  const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const stableVersion = /^3\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?$/.exec(version)
  if (!stableVersion || Number(stableVersion[1]) < 4 ||
    Number(stableVersion[1]) === 4 && Number(stableVersion[2]) < 17) {
    throw new Error(`Monaco requires a patched stable DOMPurify 3.x version (at least 3.4.17); installed: ${version}`)
  }
  // The public package exports do not expose the ESM distribution subpath.
  // Resolve its directory through the dependency, including nested npm installs.
  const patchedModule = join(packageRoot, 'dist', 'purify.es.mjs')
  if (!existsSync(patchedModule)) throw new Error('The patched DOMPurify ESM distribution is missing')
  const normalizedPatchedModule = normalizeModuleId(patchedModule)

  return {
    name: 'cairn-monaco-patched-dompurify',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './dompurify/dompurify.js' && importer && isMonacoModule(importer)) {
        return patchedModule
      }
      return null
    },
    generateBundle() {
      const moduleIds = [...this.getModuleIds()]
      if (moduleIds.some(isVendoredSanitizer)) {
        this.error('The renderer includes Monaco\'s vendored DOMPurify. Resolve it to the patched npm sanitizer instead.')
      }
      if (moduleIds.some(isMonacoSanitizer) &&
        !moduleIds.some((id) => normalizeModuleId(id) === normalizedPatchedModule)) {
        this.error('Monaco sanitization was bundled without the patched npm DOMPurify module')
      }
    },
  }
}
