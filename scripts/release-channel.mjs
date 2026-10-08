import { pathToFileURL } from 'node:url'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function parseSemver(version, label) {
  const match = SEMVER_PATTERN.exec(version)
  if (!match) throw new Error(`${label} is not a valid SemVer version: ${version}`)
  return { prerelease: match[4] !== undefined, version }
}

/**
 * 將 tag 與套件版本一起驗證，再決定 GitHub Release 的可見性。
 * RC / beta 等 SemVer prerelease 一律先建立草稿，避免意外公開為正式版。
 */
export function classifyReleaseChannel(tagName, packageVersion) {
  if (!tagName.startsWith('v')) throw new Error(`release tag must start with v: ${tagName}`)
  const tagVersion = tagName.slice(1)
  const tag = parseSemver(tagVersion, 'tag version')
  parseSemver(packageVersion, 'package.json version')
  if (tagVersion !== packageVersion) {
    throw new Error(`tag version ${tagVersion} does not match package.json version ${packageVersion}`)
  }

  return {
    draft: tag.prerelease,
    prerelease: tag.prerelease,
    version: tagVersion,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tagName, packageVersion] = process.argv.slice(2)
  if (!tagName || !packageVersion) {
    throw new Error('usage: node scripts/release-channel.mjs <tag-name> <package-version>')
  }
  const channel = classifyReleaseChannel(tagName, packageVersion)
  console.log(`draft=${channel.draft}`)
  console.log(`prerelease=${channel.prerelease}`)
  console.log(`version=${channel.version}`)
}
