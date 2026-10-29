/**
 * A trusted signer whose stapled OCSP answer says "revoked" (#209).
 *
 * The engine only judges a stapled answer when it is given the trust anchors.
 * Given them, it does not return a report for a revoked trusted signer: the read
 * throws `C2pa(CertificateTrustError(CertificateNotTrusted))` (c2pa-web 0.11.0,
 * proven on a test-CA fixture 2026-10-28; verifieddit.com saw the same on
 * 0.12.0). An untrusted signer never fails that way. So the caller reads again
 * without anchors (structure and data hash still checked) and marks the result
 * revoked, instead of passing on an error that a page would show as "could not
 * check", or, without anchors at all, as trusted.
 */

export const REVOKED_CODE = 'signingCredential.ocsp.revoked'

/** True when a read failed because a trusted signer's certificate is revoked. */
export function isRevokedReadError (error: unknown): boolean {
  return error instanceof Error && error.message.includes('CertificateTrustError(CertificateNotTrusted)')
}

/**
 * Codes of the trust-free re-read, marked revoked. Its `untrusted` code is
 * dropped: it comes from reading without anchors, not from the signer.
 */
export function markRevoked (codes: readonly string[]): string[] {
  const kept = codes.filter((code) => code !== 'signingCredential.untrusted')
  return kept.includes(REVOKED_CODE) ? kept : [...kept, REVOKED_CODE]
}

/** Reader settings that let the engine judge trust, and so a stapled OCSP answer. */
export function trustSettings (anchorsPem: string | undefined): { trust: { userAnchors: string }, verify: { verifyTrust: boolean } } | undefined {
  if (anchorsPem == null || anchorsPem.trim() === '') return undefined
  return { trust: { userAnchors: anchorsPem }, verify: { verifyTrust: true } }
}
