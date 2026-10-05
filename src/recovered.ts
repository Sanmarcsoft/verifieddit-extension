/*
 * The record of a credential recovered for a stripped image (#184), and the
 * words shown for it. Free of imports and side effects on purpose: the content
 * script uses this, and must not pull the fingerprint or network code with it.
 */
export interface RecoveredCredential {
  registry: string
  manifestId: string
  similarityScore: number
  signerCn: string | null
  signedAt: string | null
  filename: string | null
}

export function recoveredNote (r: RecoveredCredential): string {
  const who = r.signerCn ?? 'an unnamed signer'
  const when = r.signedAt != null ? ` on ${r.signedAt.slice(0, 10)}` : ''
  return 'This image\'s Content Credentials were removed, but a registered credential matches it. ' +
    `The original was signed by ${who}${when} (${r.similarityScore}% match, ${r.registry}). ` +
    'This is a lead, not proof: this copy may have been changed since it was signed.'
}
