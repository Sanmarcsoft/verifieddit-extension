/*
 *  What a screen reader is told about a file (Forge F4). The panel shows a
 *  "recovered" banner for a credential found in a registry; the spoken summary
 *  must say the same, or a stripped, unsigned file is announced as signed and
 *  trusted to exactly the reader who cannot see the banner.
 *  Run with:  bun test test/screenReaderSummary.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { screenReaderSummary, type RecoveredCredential } from '../src/recovered'

const base = { mediaType: 'Image', signer: 'sign.trusteddit.com', trusted: true, trustList: 'Trusteddit', expiredReason: null, hasErrors: false, recovered: null }
const recovered: RecoveredCredential = { registry: 'SanMarcSoft Manifest Store', manifestId: 'm', similarityScore: 96, signerCn: 'sign.trusteddit.com', signedAt: '2026-10-06', filename: null, aiGenerated: null, otherMatches: [] }

describe('screenReaderSummary', () => {
  it('an embedded, trusted credential reads as before', () => {
    expect(screenReaderSummary(base)).toBe('Image signed by sign.trusteddit.com. Trusted: Trusteddit.')
  })

  it('an unknown signer and validation errors read as before', () => {
    expect(screenReaderSummary({ ...base, trusted: false, trustList: null, hasErrors: true })).toBe('Image signed by sign.trusteddit.com. Signer unknown to your trust list. Validation errors present.')
  })

  it('an expired certificate reads as before', () => {
    expect(screenReaderSummary({ ...base, expiredReason: 'certificate has expired' })).toBe('Image signed by sign.trusteddit.com. Signer in trust list Trusteddit, but the certificate has expired. The file itself is intact.')
  })

  it('a recovered credential is announced as recovered before anything else, and never as this file being signed', () => {
    const said = screenReaderSummary({ ...base, recovered })
    expect(said).toMatch(/^This image carries no Content Credentials\./)
    expect(said).toMatch(/recovered from SanMarcSoft Manifest Store/)
    expect(said).toMatch(/96 percent match/)
    expect(said).toMatch(/lead, not proof/)
    expect(said).not.toMatch(/^Image signed by/)
    expect(said).not.toMatch(/\bTrusted:/)
    // Who signed the ORIGINAL is still said, as a fact about the original.
    expect(said).toMatch(/The original was signed by sign\.trusteddit\.com, a signer in trust list Trusteddit\./)
  })

  it('a recovered video is called a video, and an unknown original signer is said plainly', () => {
    const said = screenReaderSummary({ ...base, mediaType: 'Video', trusted: false, trustList: null, recovered: { ...recovered, medium: 'video' } })
    expect(said).toMatch(/^This video carries no Content Credentials\./)
    expect(said).toMatch(/The original was signed by sign\.trusteddit\.com, a signer unknown to your trust list\./)
  })
})

describe('a file verified in pieces', () => {
  it('has what was done with its contents read out too', () => {
    const said = screenReaderSummary({ ...base, contents: 'Contents not checked. This file is 2.4 GB, so only its credential was read.' })
    expect(said).toBe('Image signed by sign.trusteddit.com. Trusted: Trusteddit. Contents not checked. This file is 2.4 GB, so only its credential was read.')
  })
})
