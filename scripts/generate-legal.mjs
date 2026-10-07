import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getProductionLicenseInventory,
  renderLegalContentModule,
  renderLicenseJson,
  renderPrivacyMarkdown,
  renderThirdPartyNotices,
  staleArtifactPaths,
} from './legal-utils.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const policy = JSON.parse(await readFile(path.join(projectRoot, 'legal', 'privacy-policy.json'), 'utf8'))
const inventory = await getProductionLicenseInventory(projectRoot)
const artifacts = new Map([
  [path.join(projectRoot, 'PRIVACY.md'), renderPrivacyMarkdown(policy.en)],
  [path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), renderThirdPartyNotices(inventory)],
  [path.join(projectRoot, 'build', 'licenses.json'), renderLicenseJson(inventory)],
  [path.join(projectRoot, 'src', 'lib', 'generated-legal-content.ts'), renderLegalContentModule(policy)],
])

const existingArtifacts = new Map()
for (const [filePath] of artifacts) {
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    // 缺失檔案與內容不同同樣視為過期。
  }
  existingArtifacts.set(filePath, content)
}
const stalePaths = new Set(staleArtifactPaths(artifacts, existingArtifacts))
for (const [filePath, content] of artifacts) {
  if (!stalePaths.has(filePath)) continue
  if (check) {
    console.error(`Stale legal artifact: ${path.relative(projectRoot, filePath)}. Run npm run generate:legal.`)
  } else {
    await writeFile(filePath, content, 'utf8')
    console.info(`Generated ${path.relative(projectRoot, filePath)}.`)
  }
}

if (check && stalePaths.size > 0) process.exitCode = 1
