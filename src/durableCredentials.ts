/*
 *  Durable Content Credentials — the "3 pillars" detection.
 *
 *  Hardened after the 2026-06-08 RedTeam audit (issue #113, CRITICAL-2):
 *   - Soft-binding presence is taken from the C2PA SDK's VALIDATED, claim-bound
 *     assertions (activeManifest.assertions), never from raw JUMBF box labels.
 *     A stray `c2pa.soft_binding`-labelled box added outside the signed claim
 *     can no longer light a pillar.
 *   - P3 ("manifest store / cloud-recoverable") is NOT asserted offline. We can
 *     confirm a soft binding is PRESENT (P2), but not that it is REGISTERED and
 *     recoverable without a live byBinding probe. P3 is therefore a tri-state:
 *     'verified' only after a probe, 'declared' when a soft binding is present
 *     but unprobed, 'absent' otherwise. Only 'verified' counts toward the score.
 *
 *  The pillars describe the asset's durability FEATURES. They are only a trust
 *  POSITIVE when the signer is itself verified-trusted — the overlay carries
 *  that context (see c2pa-pillars `signerTrusted`).
 *
 *  Pillars (matching the trusteddit.com verifier):
 *    P1 — Signed & timestamped : C2PA signature + RFC 3161 timestamp
 *    P2 — Durable watermark    : a signed c2pa.soft_binding assertion (TrustMark)
 *    P3 — Cloud-recoverable    : registered in the manifest store (probe-only)
 */

export type ManifestStoreState = 'verified' | 'declared' | 'absent'

export interface DurablePillars {
  /** P1 — signed AND carries an RFC 3161 timestamp. */
  signedAndTimestamped: boolean
  /** P2 — durable watermark: a signed c2pa.soft_binding assertion is present. */
  trustmark: boolean
  /**
   * P3 — manifest-store recoverability.
   *  'verified' — confirmed by a live byBinding probe (online only)
   *  'declared' — a soft binding is present but registration is unprobed
   *  'absent'   — no soft binding
   */
  manifestStore: ManifestStoreState
  /** Offline-provable durability: signed+timestamped AND a durable binding. */
  durable: boolean
  /** Pillars in a positive (green) state: P1 + P2 + (P3 only when 'verified'). */
  count: number
  /** Signed+timestamped but no durable binding — lost if re-encoded/stripped. */
  embedOnly: boolean
}

/**
 * Assertion labels that indicate a soft binding (TrustMark watermark or
 * perceptual fingerprint). Tooling has emitted both spellings.
 */
const SOFT_BINDING_PATTERN = /soft[_-]?binding/i

/**
 * True when any of the supplied (signed, claim-bound) assertion labels denotes
 * a soft binding.
 */
export function hasSoftBinding (assertionLabels: readonly string[] | null | undefined): boolean {
  if (assertionLabels == null) return false
  return assertionLabels.some((label) => SOFT_BINDING_PATTERN.test(label ?? ''))
}

/**
 * Classify the durability of a credential into the three pillars.
 */
export function detectDurablePillars (opts: {
  /** Manifest is signed (a COSE signature / cert chain is present). */
  signed: boolean
  /** An RFC 3161 timestamp token is embedded in the signature. */
  hasTimestamp: boolean
  /** SIGNED, claim-bound assertion labels (from the SDK, not raw JUMBF). */
  assertionLabels?: readonly string[] | null
  /** True only when a live manifest-store byBinding probe confirmed recovery. */
  manifestStoreVerified?: boolean
}): DurablePillars {
  const softBinding = hasSoftBinding(opts.assertionLabels)

  const signedAndTimestamped = opts.signed && opts.hasTimestamp
  const trustmark = softBinding
  const manifestStore: ManifestStoreState =
    opts.manifestStoreVerified === true
      ? 'verified'
      : softBinding ? 'declared' : 'absent'

  const count =
    (signedAndTimestamped ? 1 : 0) +
    (trustmark ? 1 : 0) +
    (manifestStore === 'verified' ? 1 : 0)

  return {
    signedAndTimestamped,
    trustmark,
    manifestStore,
    // Durability we can actually prove offline: signed+timestamped + a binding.
    durable: signedAndTimestamped && trustmark,
    count,
    embedOnly: signedAndTimestamped && !trustmark
  }
}
