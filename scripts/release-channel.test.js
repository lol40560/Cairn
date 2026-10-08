import { describe, expect, it } from 'vitest'

import { classifyReleaseChannel } from './release-channel.mjs'

describe('release channel classification', () => {
  it.each([
    ['v2.0.0-rc.1', '2.0.0-rc.1'],
    ['v2.0.0-beta.1', '2.0.0-beta.1'],
  ])('makes %s a draft prerelease', (tagName, packageVersion) => {
    expect(classifyReleaseChannel(tagName, packageVersion)).toMatchObject({
      draft: true,
      prerelease: true,
      version: packageVersion,
    })
  })

  it('keeps a stable SemVer tag public and non-prerelease', () => {
    expect(classifyReleaseChannel('v2.0.0', '2.0.0')).toEqual({
      draft: false,
      prerelease: false,
      version: '2.0.0',
    })
  })

  it('blocks a tag/package version mismatch before release classification', () => {
    expect(() => classifyReleaseChannel('v2.0.0-rc.1', '2.0.0')).toThrow(
      'tag version 2.0.0-rc.1 does not match package.json version 2.0.0',
    )
  })
})
