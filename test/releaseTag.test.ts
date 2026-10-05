import { describe, expect, test } from 'bun:test'
import { familyTag } from '../src/releaseTag'
import { RELEASE_NOTES } from '../src/releaseNotes'

describe('the version the About tab shows', () => {
  test('an exact release tag wins', () => {
    expect(familyTag({ version: '1.3.0', tag: 'v1.3.0', tagDescribe: 'v1.3.0' })).toBe('v1.3.0')
  })
  test('a build a few commits after a tag still belongs to that release', () => {
    expect(familyTag({ version: '1.2.6', tag: '', tagDescribe: 'v1.2.6-2-g544aaa6' })).toBe('v1.2.6')
    expect(familyTag({ version: '1.0.0', tag: '', tagDescribe: 'v1.0.0-rc9-1-gdd46fd1-dirty' })).toBe('v1.0.0-rc9')
  })
  test('a build whose version is ahead of the last tag shows its own version, not the old release', () => {
    // Found 2026-10-05: the 1.3.0 packages were built before any v1.3.0 tag existed and said v1.2.6.
    expect(familyTag({ version: '1.3.0', tag: '', tagDescribe: 'v1.2.6-29-g268bff4-dirty' })).toBe('v1.3.0')
    expect(familyTag({ version: '2.0.0', tag: '', tagDescribe: 'v1.9.9-1-gabc1234' })).toBe('v2.0.0')
  })
  test('with no tag information it falls back to the package version', () => {
    expect(familyTag({ version: '1.3.0', tag: '', tagDescribe: 'unknown' })).toBe('v1.3.0')
    expect(familyTag({ version: '1.3.0', tag: '', tagDescribe: '' })).toBe('v1.3.0')
  })
})

test('the release notes lead with the version being shipped', () => {
  const pkg = require('../package.json') as { version: string }
  expect(RELEASE_NOTES[0].tag).toBe(`v${pkg.version}`)
})
