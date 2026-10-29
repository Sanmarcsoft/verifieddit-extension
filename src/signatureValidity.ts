/*
 * Expired-signing-certificate reasoning, kept pure so it is testable without a
 * browser, a manifest or a network. Given dates in, a verdict out.
 *
 * WHY THIS IS ITS OWN MODULE.
 *
 * An expired certificate is the one signal in C2PA validation that is easy to
 * render as an accusation and almost never is one. A signature made on Tuesday
 * with a certificate that expired on Wednesday is exactly as intact on Friday
 * as it was on Tuesday; nothing about the bytes changed when the calendar did.
 * `NON_FATAL_VALIDATION_CODE` in inject.ts and webComponents.ts already says
 * this about the `signingCredential.expired` code, and the verifier panel
 * prints "signing certificate expired" as an expiry note rather than a failure.
 *
 * The badge disagreed with both. getC2PAStatus returned 'error' whenever the
 * leaf had expired and the timestamp authority was not one of the 21 C2PA
 * conformance TSAs the extension bundles. Red is the extension's word for "the
 * content does not match what was signed", so that told users a file had been
 * altered on the strength of a calendar date and an unfamiliar TSA.
 *
 * It stayed invisible while it only affected signers nobody trusted, because
 * the untrusted case returns 'warning' earlier in getC2PAStatus and never
 * reaches the expiry branch. #160 added the CAI known-certificate anchors in
 * v1.2.4; those carry a Truepic RootCA, so real Truepic-signed press
 * photographs started matching a trust list, fell through to the expiry branch
 * and turned red. Being recognised made them look forged.
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It answers one question: does an RFC 3161 timestamp place the signature
 * inside the certificate's validity window? That is the question expiry
 * actually poses, and `genTime` is the field that answers it. Whether the
 * timestamp authority is one we recognise is a separate question, and it
 * separates green from amber rather than amber from red.
 *
 * It does NOT verify the timestamp token's own signature. c2pa-rs does that
 * upstream and reports `timeStamp.validated`; re-deriving it here from parsed
 * ASN.1 would be a second, weaker implementation of a check that already
 * happened. A `genTime` from an unverified token is therefore treated as a
 * claim about time, not proof of it, which is why an unrecognised TSA caps the
 * verdict at amber instead of restoring green.
 *
 * The ceiling is the point: `expiryDegradesTo` cannot return 'error'. Whatever
 * the dates say, expiry alone never earns red. Red is reserved for the codes
 * that mean a hash or a signature did not match.
 */

/** Everything the expiry decision is allowed to look at. */
export interface ExpiryEvidence {
  /** Leaf signing certificate `notBefore`. Null when it could not be read. */
  validFrom: Date | null
  /** Leaf signing certificate `notAfter`. Null when it could not be read. */
  validTo: Date | null
  /** `genTime` of each RFC 3161 token carried by the signature. */
  timestampTimes: Date[]
  /** True when a timestamp authority chains to a TSA trust list we carry. */
  tsaTrusted: boolean
  /** Clock reference. Injected so the verdict is testable and deterministic. */
  now: Date
}

export type ExpiryVerdictKind =
  /** Still inside its validity window, or the window could not be read. */
  | 'not-expired'
  /** Expired, but a recognised authority timestamped it while it was valid. */
  | 'covered-trusted'
  /** Expired, timestamped inside the window by an authority we do not know. */
  | 'covered-untrusted-tsa'
  /** Expired with no timestamp placing the signature inside the window. */
  | 'uncovered'

export interface ExpiryVerdict {
  kind: ExpiryVerdictKind
}

/** A Date that survived parsing. `new Date('nonsense')` yields NaN, not a throw. */
function isRealDate (d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime())
}

/**
 * Does any timestamp place the signature inside the certificate's window?
 *
 * Both ends are checked. A `genTime` before `notBefore` is as wrong as one
 * after `notAfter`, and a backdated token is precisely the shape a forged one
 * would take, so it is not evidence of anything and is discarded.
 */
function coveringTimestamp (e: ExpiryEvidence): boolean {
  const to = e.validTo
  if (!isRealDate(to)) return false
  return e.timestampTimes.some((t) => {
    if (!isRealDate(t)) return false
    if (t.getTime() > to.getTime()) return false
    if (isRealDate(e.validFrom) && t.getTime() < e.validFrom.getTime()) return false
    return true
  })
}

/**
 * Classify the expiry situation.
 *
 * An unreadable validity window returns 'not-expired' on purpose. We degrade a
 * verdict only on evidence we actually hold; "we could not parse the
 * certificate" is not evidence that it expired, and guessing in the pessimistic
 * direction would mark good assets on a parser bug.
 */
export function classifyExpiry (e: ExpiryEvidence): ExpiryVerdict {
  if (!isRealDate(e.validTo)) return { kind: 'not-expired' }
  if (e.validTo.getTime() >= e.now.getTime()) return { kind: 'not-expired' }
  if (!coveringTimestamp(e)) return { kind: 'uncovered' }
  return { kind: e.tsaTrusted ? 'covered-trusted' : 'covered-untrusted-tsa' }
}

/**
 * The worst badge state expiry alone may produce.
 *
 * Never 'error'. This function is the enforcement point for that rule, and the
 * test suite asserts it across every verdict kind, so a later edit that tries
 * to reintroduce red for an expiry has to delete a test that says why not to.
 */
export function expiryDegradesTo (v: ExpiryVerdict): 'success' | 'warning' {
  switch (v.kind) {
    case 'not-expired':
    case 'covered-trusted':
      return 'success'
    case 'covered-untrusted-tsa':
    case 'uncovered':
      return 'warning'
  }
}

/**
 * One line for the validation-status list, or null when there is nothing to add.
 *
 * Written to describe the certificate, never the content. The user is looking
 * at a photograph and deciding whether to believe it; a string here that hints
 * at alteration would do the same damage as the red badge did.
 */
export function expiryReason (v: ExpiryVerdict): string | null {
  switch (v.kind) {
    case 'not-expired':
    case 'covered-trusted':
      return null
    case 'covered-untrusted-tsa':
      return 'signing certificate has expired; a timestamp places the signature inside its validity period, but the timestamp authority is not one this extension recognises'
    case 'uncovered':
      return 'signing certificate has expired and no timestamp places the signature inside its validity period'
  }
}

/**
 * The leaf-certificate fields this module can read a validity window from.
 *
 * Both spellings are accepted on purpose. `notBefore`/`notAfter` are the ISO
 * instants added alongside the display fields; `validFrom`/`validTo` carry the
 * `isoDateString` type alias but in practice hold a LOCALISED en-US string
 * ("Apr 11, 2025"), because `certs.ts` puts them through `Intl.DateTimeFormat`
 * before any consumer sees them. The ISO pair is preferred; the display pair is
 * the fallback so a result cached before the upgrade still classifies rather
 * than silently reading as "window unknown".
 */
export interface ExpirySourceCert {
  notBefore?: string | null
  notAfter?: string | null
  validFrom?: string | null
  validTo?: string | null
}

/** The one timestamp field the decision needs. */
export interface ExpirySourceToken {
  genTime?: string | null
}

function parseInstant (...candidates: Array<string | null | undefined>): Date | null {
  for (const c of candidates) {
    if (c == null || c === '') continue
    const d = new Date(c)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

/**
 * Adapts a C2paResult's certificate chain and timestamp tokens into evidence.
 *
 * Anything unreadable becomes null or is dropped, never a guess. An unreadable
 * window classifies as 'not-expired', so a parse failure cannot manufacture an
 * expiry warning against an asset that is fine.
 */
export function buildExpiryEvidence (
  certChain: readonly ExpirySourceCert[] | null | undefined,
  tstTokens: readonly ExpirySourceToken[] | null | undefined,
  tsaTrusted: boolean,
  now: Date = new Date()
): ExpiryEvidence {
  const leaf = certChain?.[0]
  return {
    validFrom: leaf == null ? null : parseInstant(leaf.notBefore, leaf.validFrom),
    validTo: leaf == null ? null : parseInstant(leaf.notAfter, leaf.validTo),
    timestampTimes: (tstTokens ?? [])
      .map((t) => parseInstant(t?.genTime))
      .filter((d): d is Date => d != null),
    tsaTrusted,
    now
  }
}
