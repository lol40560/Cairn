import { describe, expect, it } from 'vitest'

import { verifyReleaseDocumentation } from './verify-release-docs.mjs'

describe('release documentation verification', () => {
  it('accepts release notes and a changelog matching the package version', () => {
    expect(() => verifyReleaseDocumentation(
      '2.0.0-rc.3',
      '# Cairn v2.0.0-rc.3\n\nNotes\n',
      '# Changelog\n\n## [2.0.0-rc.3] - 2026-10-19\n',
    )).not.toThrow()
  })

  it('rejects stale release notes', () => {
    expect(() => verifyReleaseDocumentation(
      '2.0.0-rc.2',
      '# Cairn v2.0.0-rc.1\n',
      '## [2.0.0-rc.2]\n',
    )).toThrow('RELEASE_NOTES.md')
  })

  it('rejects a changelog without the package version', () => {
    expect(() => verifyReleaseDocumentation(
      '2.0.0-rc.2',
      '# Cairn v2.0.0-rc.2\n',
      '## [2.0.0-rc.1]\n',
    )).toThrow('CHANGELOG.md')
  })
})
