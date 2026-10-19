import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')

export function verifyReleaseDocumentation(version, releaseNotes, changelog) {
  const releaseHeading = `# Cairn v${version}`
  const changelogHeading = `## [${version}]`

  if (!releaseNotes.startsWith(`${releaseHeading}\n`)) {
    throw new Error(`RELEASE_NOTES.md must start with ${JSON.stringify(releaseHeading)}`)
  }
  if (!changelog.includes(changelogHeading)) {
    throw new Error(`CHANGELOG.md must contain ${JSON.stringify(changelogHeading)}`)
  }
}

async function main() {
  const [packageText, releaseNotes, changelog] = await Promise.all([
    readFile(resolve(projectRoot, 'package.json'), 'utf8'),
    readFile(resolve(projectRoot, 'RELEASE_NOTES.md'), 'utf8'),
    readFile(resolve(projectRoot, 'CHANGELOG.md'), 'utf8'),
  ])
  const packageJson = JSON.parse(packageText)
  verifyReleaseDocumentation(packageJson.version, releaseNotes, changelog)
  console.log(`Release documentation matches v${packageJson.version}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
