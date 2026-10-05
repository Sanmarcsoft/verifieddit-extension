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

const NO_LABEL = 'No embedded content credentials were found for this image. ' +
  'The file has no C2PA manifest, so nothing cryptographic can be verified locally.'

/**
 * What to say about an image with no credentials. "We looked for a removed
 * label and found none" and "we did not look because the online check is off"
 * are different facts, and the person can only act on the second.
 */
export function noLabelNote (r: { recovered: RecoveredCredential | null | undefined, checked: boolean }): string {
  if (r.recovered != null) return recoveredNote(r.recovered)
  return r.checked
    ? `${NO_LABEL} We also looked for a copy of a label that might have been removed, and found none.`
    : `${NO_LABEL} If its credentials were removed, a copy may still exist: turn on "Check durable credentials online" in the extension's Options and verify again.`
}
