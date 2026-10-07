import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const LICENSE_FILE = /^(?:license|licence|copying|notice)(?:[-_.].*)?$/iu
const UNKNOWN_LICENSE = /^(?:unknown|unlicensed|see license in|custom|)$/iu

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository
  if (repository && typeof repository.url === 'string') return repository.url
  return undefined
}

function normalizeAttribution(packageJson) {
  const value = packageJson.author ?? packageJson.contributors
  if (Array.isArray(value)) return value.map(formatPerson).filter(Boolean).join('; ') || undefined
  return formatPerson(value)
}

function formatPerson(person) {
  if (typeof person === 'string') return person
  if (person && typeof person.name === 'string') return person.name
  return undefined
}

async function readLicenseText(directory) {
  const names = await readdir(directory)
  const candidates = names.filter((name) => LICENSE_FILE.test(name)).sort((left, right) => left.localeCompare(right))
  if (candidates.length === 0) return undefined
  const texts = await Promise.all(candidates.map(async (name) => normalizeLicenseText(await readFile(path.join(directory, name), 'utf8'))))
  return texts.filter(Boolean).join('\n\n') || undefined
}

function normalizeLicenseText(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim()
}

export function validateLicenseEntry(entry, overrides = { packages: {} }) {
  const override = overrides.packages?.[`${entry.name}@${entry.version}`]
  const license = override?.license ?? entry.license
  if (typeof license !== 'string' || UNKNOWN_LICENSE.test(license.trim())) {
    throw new Error(`Unknown or unreviewed license for ${entry.name}@${entry.version}; add an exact override in legal/license-overrides.json.`)
  }
  return { ...entry, license, licenseText: override?.licenseText ?? entry.licenseText }
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

export async function getProductionLicenseInventory(projectRoot) {
  const [lockfile, overrides] = await Promise.all([
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'legal', 'license-overrides.json'), 'utf8').then(JSON.parse),
  ])
  const entries = []
  for (const [relativePackagePath, lockEntry] of Object.entries(lockfile.packages)) {
    if (!relativePackagePath.startsWith('node_modules/') || lockEntry.dev === true || lockEntry.link === true) continue
    const directory = path.join(projectRoot, relativePackagePath)
    const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    const entry = validateLicenseEntry({
      attribution: normalizeAttribution(packageJson),
      license: packageJson.license ?? lockEntry.license,
      licenseText: await readLicenseText(directory),
      name: packageJson.name,
      repository: normalizeRepository(packageJson.repository),
      version: packageJson.version,
    }, overrides)
    if (!entry.licenseText) {
      const source = entries.find((candidate) => candidate.license === entry.license && candidate.licenseText)
      if (source) entry.licenseText = source.licenseText
    }
    if (!entry.licenseText) {
      throw new Error(`No distributable license text found for ${entry.name}@${entry.version}. Add a reviewed exact override.`)
    }
    entries.push(entry)
  }
  const unique = new Map()
  for (const entry of sortEntries(entries)) unique.set(`${entry.name}@${entry.version}`, entry)
  return [...unique.values()]
}

export function renderLicenseJson(entries) {
  return `${JSON.stringify({
    generatedBy: 'npm run generate:legal',
    packages: sortEntries(entries),
    schemaVersion: 1,
  }, null, 2)}\n`
}

export function renderThirdPartyNotices(entries) {
  const sorted = sortEntries(entries)
  const texts = new Map()
  for (const entry of sorted) {
    const key = `${entry.license}\u0000${entry.licenseText}`
    const group = texts.get(key) ?? { license: entry.license, packages: [], text: entry.licenseText }
    group.packages.push(`${entry.name}@${entry.version}`)
    texts.set(key, group)
  }
  const inventory = sorted.map((entry) => {
    const attribution = entry.attribution ? `; attribution: ${entry.attribution}` : ''
    const repository = entry.repository ? `; repository: ${entry.repository}` : ''
    return `- **${entry.name}@${entry.version}** — ${entry.license}${attribution}${repository}`
  })
  const licenseTexts = [...texts.values()]
    .sort((left, right) => `${left.license}:${left.packages[0]}`.localeCompare(`${right.license}:${right.packages[0]}`))
    .flatMap((group) => [
      `### ${group.license}`,
      '',
      `Applies to: ${group.packages.join(', ')}`,
      '',
      '```text',
      group.text,
      '```',
      '',
    ])
  return [
    '# Third-Party Notices',
    '',
    '<!-- Generated by npm run generate:legal. Do not edit manually. -->',
    '',
    'This inventory covers runtime packages in the current production dependency tree. Development-only packages are excluded.',
    '',
    '## Package Inventory',
    '',
    ...inventory,
    '',
    '## License Texts',
    '',
    ...licenseTexts,
  ].join('\n')
}

export function renderPrivacyMarkdown(policy) {
  return [
    `# ${policy.title}`,
    '',
    '<!-- Generated by npm run generate:legal from legal/privacy-policy.json. Do not edit manually. -->',
    '',
    ...policy.sections.flatMap((section) => [`## ${section.heading}`, '', section.body, '']),
  ].join('\n')
}

export function staleArtifactPaths(expected, actual) {
  return [...expected.entries()]
    .filter(([filePath, content]) => actual.get(filePath) !== content)
    .map(([filePath]) => filePath)
}

export function renderLegalContentModule(policy) {
  const en = renderPrivacyText(policy.en)
  const zh = renderPrivacyText(policy.zh)
  return `// Generated by npm run generate:legal from legal/privacy-policy.json. Do not edit manually.\nexport const PRIVACY_POLICY_EN = ${JSON.stringify(en)}\n\nexport const PRIVACY_POLICY_ZH = ${JSON.stringify(zh)}\n\nexport const PRIVACY_SUMMARY_EN = ${JSON.stringify(policy.en.summary)}\n\nexport const PRIVACY_SUMMARY_ZH = ${JSON.stringify(policy.zh.summary)}\n`
}

function renderPrivacyText(policy) {
  return [policy.title, '', ...policy.sections.flatMap((section) => [section.heading, '', section.body, ''])].join('\n').trim()
}
