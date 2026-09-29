import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const licensesPath = path.join(projectRoot, 'build', 'licenses.json')
const noticesPath = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md')
const licenseOrder = ['MIT', 'Apache-2.0', 'ISC', 'BSD', 'Other']

function licenseGroup(license) {
  if (/^MIT$/iu.test(license)) return 'MIT'
  if (/Apache/iu.test(license)) return 'Apache-2.0'
  if (/^ISC$/iu.test(license)) return 'ISC'
  if (/BSD/iu.test(license)) return 'BSD'
  return 'Other'
}

function repositoryOf(info) {
  if (typeof info.repository === 'string') return info.repository
  if (info.repository && typeof info.repository.url === 'string') return info.repository.url
  return 'Not specified'
}

const records = JSON.parse(await readFile(licensesPath, 'utf8'))
const groups = new Map(licenseOrder.map((group) => [group, []]))

for (const [name, info] of Object.entries(records)) {
  const license = Array.isArray(info.licenses) ? info.licenses.join(', ') : (info.licenses ?? 'Unknown')
  groups.get(licenseGroup(license)).push({ license, name, repository: repositoryOf(info) })
}

const sections = licenseOrder.flatMap((group) => {
  const entries = groups.get(group)
  if (!entries || entries.length === 0) return []
  const lines = entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `- **${entry.name}** — ${entry.license} — ${entry.repository}`)
  return [`## ${group}`, '', ...lines, '']
})

const output = [
  '# Third-Party Notices',
  '',
  'Cairn includes the production dependencies listed below. Each dependency remains subject to its own license terms.',
  '',
  ...sections,
].join('\n')

await writeFile(noticesPath, output, 'utf8')
console.info(`已生成 ${path.basename(noticesPath)}。`)
