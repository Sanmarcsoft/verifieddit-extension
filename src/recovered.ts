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
  /**
   * Whether the registered original says it was made with AI. null when the
   * registered manifest could not be read: unknown, which is not the same as no.
   */
  aiGenerated: boolean | null
}

export function recoveredNote (r: RecoveredCredential): string {
  const who = r.signerCn ?? 'an unnamed signer'
  const when = r.signedAt != null ? ` on ${r.signedAt.slice(0, 10)}` : ''
  return 'This image\'s Content Credentials were removed, but a registered credential matches it. ' +
    `The original was signed by ${who}${when} (${r.similarityScore}% match, ${r.registry}). ` +
    (r.aiGenerated === true ? 'Its label says it was made with AI. ' : '') +
    'This is a lead, not proof: this copy may have been changed since it was signed.'
}

const NO_LABEL = 'No embedded content credentials were found for this image. ' +
  'The file has no C2PA manifest, so nothing cryptographic can be verified locally.'

/**
 * What to say about an image with no credentials. "We looked for a removed
 * label and found none" and "we did not look because the online check is off"
 * are different facts, and the person can only act on the second.
 */
export function noLabelNote (r: { recovered: RecoveredCredential | null | undefined, checked: boolean, detail?: string }): string {
  if (r.recovered != null) {
    // Normally the full credential opens in the panel. This note is the fallback
    // when its details could not be loaded, and it says so rather than hiding it.
    return recoveredNote(r.recovered) + (r.detail != null && r.detail !== '' ? ` Its full details could not be shown (${r.detail}).` : '')
  }
  return r.checked
    ? `${NO_LABEL} We also looked for a copy of a label that might have been removed, and found none.`
    : `${NO_LABEL} If its credentials were removed, a copy may still exist: turn on "Check durable credentials online" in the extension's Options and verify again.`
}

/**
 * The media type of a recovered credential, read from its first bytes. The
 * registry labels its answer application/c2pa but returns the whole signed file,
 * so the label cannot be trusted; the bytes can.
 */
export function sniffMediaType (b: Uint8Array): string {
  const at = (i: number, ...v: number[]): boolean => v.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'video/mp4'
  return 'application/c2pa'
}
