/**
 * The verifieddit verdict vocabulary and the extension's decision rule.
 *
 * Extracted from webComponents.ts on 2026-09-07. The logic used to live inside a
 * private method of a Lit component, which meant nothing could test it and nothing
 * could compare it against the two websites. It is a pure function of three inputs,
 * so it belongs here; the component now reads from this one definition.
 *
 * The same four states are produced by verifieddit-www (verdictFromHub) and
 * trusteddit-www (mapHubResponse), both of which map a Verify HUB response.
 */

export type Verdict = 'verified' | 'authentic' | 'invalid' | 'unsigned'

// A C2PA validation_status code is a real INTEGRITY failure (→ "invalid"/red)
// unless it is merely a trust/expiry signal. signingCredential.untrusted just
// means the signer is not in the trust list (shown separately as the trust
// state); signingCredential.expired / timeStamp.untrusted are expiry/trust, not
// tampering. Treating those as "invalid" wrongly implies the content was
// altered. Everything else in the list (hash/signature mismatch, missing
// assertions, malformed claims, …) is a genuine failure.
const NON_FATAL_VALIDATION_CODE = /\.(untrusted|expired|outsideValidity)$/i

export function isFatalValidationCode (code: string): boolean {
  return code !== '' && !NON_FATAL_VALIDATION_CODE.test(code)
}

/** Codes that describe the credential's lifetime or trust, never the content's integrity. */
export const EXPIRY_OR_TRUST_CODE = /\.(expired|untrusted|outsideValidity)$/i

/**
 * Whether a hub verdict of "Invalid" was caused ONLY by expiry/trust signals.
 *
 * This is the hook for M's directive on the hub-backed surfaces: if the sole complaints are
 * expiry and trust, and a timestamp redeems the expiry, the file is not invalid.
 */
export function invalidIsExpiryOnly (codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every((c) => EXPIRY_OR_TRUST_CODE.test(c))
}

/**
 * Evidence that an RFC 3161 timestamp can vouch for a signature made with a
 * certificate that has since expired.
 *
 * Field names match the hub contract exactly (`signer.timestamp` in
 * verifieddit-www-hub/api/lib/c2pa-validator.js), so a hub response can be fed
 * to these predicates without translation. Keep the two in step.
 */
export interface TimestampEvidence {
  /** A timestamp token is present on the signature. */
  present: boolean
  /** The timestamp authority chained to a root in the trust list. */
  authorityTrusted: boolean
  /** The stamped time is at or before the signing certificate's notAfter. */
  insideCertificateValidity: boolean
}

/**
 * M directive 2026-09-07: an expired certificate is not an integrity failure when the timestamp
 * authority is in the trust list AND the timestamp occurred before the certificate expired.
 *
 * Both conditions are required. An untrusted authority's time is just an assertion, and a stamp
 * taken after expiry proves the opposite of what we need: that a dead credential was used.
 */
export function timestampRedeemsExpiry (ts: TimestampEvidence | null | undefined): boolean {
  if (ts == null) return false
  return ts.present && ts.authorityTrusted && ts.insideCertificateValidity
}

/**
 * Read timestamp evidence out of a C2PA reader result.
 *
 * c2pa-rs has no positive "TSA trusted" flag; it reports the negative as a timeStamp.* code and
 * only populates signature_info.time from an accepted token. So: a time with no timeStamp.*
 * complaint is an accepted timestamp. Verified 2026-09-07 with c2patool 0.26.7 against the
 * sample corpus, where the expired-certificate files carry a time and no timeStamp.* code.
 */
export function timestampEvidenceFromC2pa (
  { codes, signatureTime }: { codes: readonly string[], signatureTime: string | null | undefined }
): TimestampEvidence {
  const present = signatureTime != null && signatureTime !== ''
  if (!present) {
    return { present: false, authorityTrusted: false, insideCertificateValidity: false }
  }
  const has = (suffix: string): boolean =>
    codes.some((c) => c.toLowerCase() === `timestamp.${suffix}`.toLowerCase())
  return {
    present: true,
    authorityTrusted: !has('untrusted') && !has('mismatch') && !has('invalid'),
    insideCertificateValidity: !has('outsideValidity')
  }
}

/**
 * Whether the durability panel says anything meaningful about this file.
 *
 * On an invalid verdict the credential does not describe these bytes, so its durability
 * assertions describe nothing; showing them next to an integrity failure invites the reader to
 * weigh claims that have already been voided. On unsigned there is no credential to discuss.
 */
export function durabilityApplies (verdict: Verdict): boolean {
  return verdict === 'verified' || verdict === 'authentic'
}

export interface VerdictInput {
  /** C2PA validation_status codes from the manifest store. */
  codes: readonly string[]
  /** Whether the asset carries a signature at all (cert chain or manifests). */
  signed: boolean
  /** Whether the signer resolved against a trust list. */
  trusted: boolean
  /** RFC 3161 evidence, used only to decide whether an expired credential is forgiven. */
  timestamp?: TimestampEvidence | null
}

/**
 * Decide the verdict. Precedence: integrity failure, then absence of a signature,
 * then trust. An expired credential is deliberately NOT an integrity failure.
 */
export function computeVerdict ({ codes, signed, trusted }: VerdictInput): Verdict {
  if (codes.some(isFatalValidationCode)) return 'invalid'
  if (!signed) return 'unsigned'
  return trusted ? 'verified' : 'authentic'
}

/**
 * Map a Verify HUB response to the shared verdict vocabulary, applying M's expiry directive.
 *
 * The hub evaluates certificate expiry against "now" rather than against the RFC 3161 timestamp,
 * so it returns validationState "Invalid" for files whose signature was demonstrably made while
 * the certificate was valid. Measured 2026-09-07: six of the thirteen corpus samples. c2patool
 * 0.26.7 reading the same bytes raises no expiry complaint at all.
 *
 * Until the hub is corrected, the websites apply the rule here: an "Invalid" whose only
 * complaints are expiry/trust, with a timestamp that redeems the expiry, is not invalid.
 */
export interface HubVerdictInput {
  validationState: 'Valid' | 'Invalid' | 'Unsigned'
  codes: readonly string[]
  trusted: boolean
  timestamp?: TimestampEvidence | null
}

export function verdictFromHubState (
  { validationState, codes, trusted, timestamp }: HubVerdictInput
): Verdict {
  if (validationState === 'Unsigned') return 'unsigned'
  if (validationState === 'Invalid') {
    const redeemed = invalidIsExpiryOnly(codes) && timestampRedeemsExpiry(timestamp)
    if (!redeemed) return 'invalid'
  }
  return computeVerdict({ codes, signed: true, trusted })
}
