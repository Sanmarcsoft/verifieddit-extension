/**
 * Verdict parity tests.
 *
 * The extension decides a verdict locally (WASM + its own trust list); both web
 * properties POST to the Verify HUB and map the response. All three must land on
 * the same four-state vocabulary for the same asset, so the extension's decision
 * lives here as an exported pure function rather than inside a Lit component.
 */

import { describe, it, expect } from 'bun:test'
import { computeVerdict, isFatalValidationCode, timestampRedeemsExpiry, timestampEvidenceFromC2pa, durabilityApplies, invalidIsExpiryOnly, verdictFromHubState, type Verdict } from '../src/verdict'

describe('isFatalValidationCode', () => {
  it('treats an empty code as non-fatal', () => {
    expect(isFatalValidationCode('')).toBe(false)
  })

  it('treats untrusted and expired signals as non-fatal', () => {
    expect(isFatalValidationCode('signingCredential.untrusted')).toBe(false)
    expect(isFatalValidationCode('signingCredential.expired')).toBe(false)
    expect(isFatalValidationCode('timeStamp.untrusted')).toBe(false)
  })

  it('treats integrity failures as fatal', () => {
    expect(isFatalValidationCode('assertion.dataHash.mismatch')).toBe(true)
    expect(isFatalValidationCode('claimSignature.mismatch')).toBe(true)
    expect(isFatalValidationCode('assertion.missing')).toBe(true)
  })
})

describe('computeVerdict', () => {
  it('is unsigned when nothing is signed', () => {
    expect(computeVerdict({ codes: [], signed: false, trusted: false })).toBe('unsigned')
  })

  it('is unsigned even if a stray trust flag is set but nothing is signed', () => {
    expect(computeVerdict({ codes: [], signed: false, trusted: true })).toBe('unsigned')
  })

  it('is verified when signed, intact and in the trust list', () => {
    expect(computeVerdict({ codes: [], signed: true, trusted: true })).toBe('verified')
  })

  it('is authentic when signed and intact but the signer is not trusted', () => {
    expect(computeVerdict({ codes: ['signingCredential.untrusted'], signed: true, trusted: false }))
      .toBe('authentic')
  })

  it('is invalid when an integrity failure is present', () => {
    expect(computeVerdict({ codes: ['assertion.dataHash.mismatch'], signed: true, trusted: false }))
      .toBe('invalid')
  })

  it('lets an integrity failure beat trust', () => {
    expect(computeVerdict({ codes: ['assertion.dataHash.mismatch'], signed: true, trusted: true }))
      .toBe('invalid')
  })

  /**
   * Expiry semantics, corrected by M directive 2026-09-07.
   *
   * Previously these tests pinned "expired is never fatal", full stop. That was too permissive:
   * it forgave a credential that expired before it was ever used. The rule is now conditional on
   * RFC 3161 evidence (see the timestampRedeemsExpiry suite), so with no timestamp supplied an
   * expired credential is an integrity failure.
   */
  it('never turns an expiry red, however weak the timestamp evidence', () => {
    // expiryDegradesTo() in signatureValidity.ts caps expiry at 'warning' on purpose: a red badge
    // tells the reader the picture was altered, and an expired certificate says nothing of the
    // kind. Uncovered expiry is surfaced as a warning by expiryReason(), not as a verdict.
    expect(computeVerdict({ codes: ['signingCredential.expired'], signed: true, trusted: false }))
      .toBe('authentic')
    expect(computeVerdict({ codes: ['signingCredential.expired'], signed: true, trusted: true }))
      .toBe('verified')
  })

  it('handles the expired plus untrusted pair the hub emits together', () => {
    // The hub emits this pair for the sample corpus. With a trusted timestamp the file is
    // authentic; the corpus files do carry one, which is why the sites should stop saying invalid.
    expect(computeVerdict({
      codes: ['signingCredential.expired', 'signingCredential.untrusted'],
      signed: true,
      trusted: false,
      timestamp: { present: true, authorityTrusted: true, insideCertificateValidity: true }
    })).toBe('authentic')
  })
})

describe('verdict vocabulary', () => {
  it('produces only the four shared states', () => {
    const all: Verdict[] = ['verified', 'authentic', 'invalid', 'unsigned']
    const cases = [
      { codes: [], signed: false, trusted: false },
      { codes: [], signed: true, trusted: true },
      { codes: ['signingCredential.untrusted'], signed: true, trusted: false },
      { codes: ['assertion.dataHash.mismatch'], signed: true, trusted: false }
    ]
    for (const c of cases) expect(all).toContain(computeVerdict(c))
  })
})

/**
 * RFC 3161 long-term validity (M directive 2026-09-07).
 *
 * "An expired certificate should not read as invalid if the timestamp authority is in the
 * trust list and the timestamp occurred before the expiration of the signing certificate."
 *
 * Both halves are load-bearing. A timestamp from an untrusted authority proves nothing (anyone
 * can assert a time), and a trusted timestamp taken AFTER the certificate expired proves the
 * signature was made with a dead credential. Only both together redeem an expired certificate.
 */
describe('timestampRedeemsExpiry', () => {
  const good = { present: true, authorityTrusted: true, insideCertificateValidity: true }

  it('redeems expiry when the TSA is trusted and the stamp predates expiry', () => {
    expect(timestampRedeemsExpiry(good)).toBe(true)
  })

  it('does not redeem when there is no timestamp at all', () => {
    expect(timestampRedeemsExpiry({ ...good, present: false })).toBe(false)
    expect(timestampRedeemsExpiry(null)).toBe(false)
  })

  it('does not redeem when the timestamp authority is not in the trust list', () => {
    expect(timestampRedeemsExpiry({ ...good, authorityTrusted: false })).toBe(false)
  })

  it('does not redeem when the stamp was taken after the certificate expired', () => {
    expect(timestampRedeemsExpiry({ ...good, insideCertificateValidity: false })).toBe(false)
  })
})

describe('verdictFromHubState: the expiry directive applied to hub responses', () => {
  const expired = ['signingCredential.expired', 'signingCredential.untrusted']
  const redeeming = { present: true, authorityTrusted: true, insideCertificateValidity: true }

  it('recognises an Invalid caused only by expiry and trust', () => {
    expect(invalidIsExpiryOnly(expired)).toBe(true)
    expect(invalidIsExpiryOnly(['signingCredential.expired'])).toBe(true)
  })

  it('does not mistake an integrity failure for an expiry-only Invalid', () => {
    expect(invalidIsExpiryOnly([...expired, 'assertion.dataHash.mismatch'])).toBe(false)
    expect(invalidIsExpiryOnly([])).toBe(false)
  })

  it('downgrades an expiry-only Invalid to authentic when a timestamp redeems it', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid', codes: expired, trusted: false, timestamp: redeeming
    })).toBe('authentic')
  })

  it('downgrades to verified when the signer is also trusted', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid', codes: ['signingCredential.expired'], trusted: true, timestamp: redeeming
    })).toBe('verified')
  })

  it('keeps Invalid when no timestamp vouches for the expiry', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid', codes: expired, trusted: false, timestamp: null
    })).toBe('invalid')
  })

  it('keeps Invalid when the timestamp authority is not in the trust list', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid', codes: expired, trusted: false,
      timestamp: { ...redeeming, authorityTrusted: false }
    })).toBe('invalid')
  })

  it('keeps Invalid when the timestamp was taken after the certificate expired', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid', codes: expired, trusted: false,
      timestamp: { ...redeeming, insideCertificateValidity: false }
    })).toBe('invalid')
  })

  it('never downgrades a genuine integrity failure, whatever the timestamp', () => {
    expect(verdictFromHubState({
      validationState: 'Invalid',
      codes: [...expired, 'assertion.dataHash.mismatch'],
      trusted: true,
      timestamp: redeeming
    })).toBe('invalid')
  })

  it('passes Valid and Unsigned through unchanged', () => {
    expect(verdictFromHubState({ validationState: 'Valid', codes: [], trusted: true })).toBe('verified')
    expect(verdictFromHubState({ validationState: 'Valid', codes: ['signingCredential.untrusted'], trusted: false })).toBe('authentic')
    expect(verdictFromHubState({ validationState: 'Unsigned', codes: [], trusted: false })).toBe('unsigned')
  })
})

/**
 * Derive the timestamp evidence from what a C2PA reader actually gives us.
 *
 * c2pa-rs does not expose "the TSA is trusted" as a positive flag; it expresses the negative,
 * emitting a timeStamp.* failure code when the token is missing, untrusted, malformed or outside
 * the certificate's validity window. Measured 2026-09-07 with c2patool 0.26.7 against the sample
 * corpus: the expired-certificate files carry a signature time and NO timeStamp.* code, which is
 * exactly the redeemed case.
 */
describe('timestampEvidenceFromC2pa', () => {
  it('accepts a signature time with no timeStamp failure codes', () => {
    expect(timestampEvidenceFromC2pa({ codes: ['signingCredential.untrusted'], signatureTime: '2024-05-30T21:42:08+00:00' }))
      .toEqual({ present: true, authorityTrusted: true, insideCertificateValidity: true })
  })

  it('reports absent when there is no signature time', () => {
    expect(timestampEvidenceFromC2pa({ codes: [], signatureTime: null }))
      .toEqual({ present: false, authorityTrusted: false, insideCertificateValidity: false })
  })

  it('marks the authority untrusted on timeStamp.untrusted', () => {
    expect(timestampEvidenceFromC2pa({ codes: ['timeStamp.untrusted'], signatureTime: '2024-05-30T21:42:08+00:00' }).authorityTrusted)
      .toBe(false)
  })

  it('marks it outside validity on timeStamp.outsideValidity', () => {
    expect(timestampEvidenceFromC2pa({ codes: ['timeStamp.outsideValidity'], signatureTime: '2024-05-30T21:42:08+00:00' }).insideCertificateValidity)
      .toBe(false)
  })

  it('does not let a timeStamp.* code alone make the verdict invalid', () => {
    // timeStamp codes are trust signals, not integrity failures.
    expect(computeVerdict({ codes: ['timeStamp.untrusted'], signed: true, trusted: false, timestamp: null }))
      .toBe('authentic')
  })
})

/**
 * Durability panel applicability (M report 2026-09-07).
 *
 * "Tampered Pixels" showed the dataHash failure AND "Signer is not in a trust list - these
 * durability features are self-asserted". Both were true, but shown together they imply the
 * durability claims are worth weighing. They are not: when the content hash does not match, the
 * credential does not describe this file, so its durability assertions describe nothing.
 */
describe('durabilityApplies', () => {
  it('is false for an invalid verdict', () => {
    expect(durabilityApplies('invalid')).toBe(false)
  })

  it('is true for verdicts where the credential still describes the file', () => {
    expect(durabilityApplies('verified')).toBe(true)
    expect(durabilityApplies('authentic')).toBe(true)
  })

  it('is false when there is no credential at all', () => {
    expect(durabilityApplies('unsigned')).toBe(false)
  })
})
