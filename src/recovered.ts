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
  /**
   * Other registered records that match the same picture (#191). The same pixels
   * signed twice give two records, and nothing in a stripped file says which one
   * it carried, so the reader is told this credential is one of several.
   */
  otherMatches: OtherMatch[]
  /** Set for a video (#197), whose credential is found from the fingerprint of one frame. Absent means an image. */
  medium?: 'video'
}

export interface OtherMatch {
  manifestId: string
  similarityScore: number
  signedAt: string | null
  filename: string | null
}

export function recoveredNote (r: RecoveredCredential): string {
  const who = r.signerCn ?? 'an unnamed signer'
  const when = r.signedAt != null ? ` on ${r.signedAt.slice(0, 10)}` : ''
  // A result recovered by an older build, or relayed from one, has no list.
  const others = r.otherMatches?.length ?? 0
  return `This ${r.medium ?? 'image'}'s Content Credentials were removed, but a registered credential matches it. ` +
    (r.medium === 'video' ? 'The match was made on one frame from the middle of the video, compared in your browser. ' : '') +
    `The original was signed by ${who}${when} (${r.similarityScore}% match, ${r.registry}). ` +
    (r.aiGenerated === true ? 'Its label says it was made with AI. ' : '') +
    (others > 0
      ? `${others} other registered record${others === 1 ? ' also matches' : 's also match'} this picture, so this may not be the exact credential that was removed. `
      : '') +
    'This is a lead, not proof: this copy may have been changed since it was signed.'
}

const noLabel = (medium: string): string => `No embedded content credentials were found for this ${medium}. ` +
  'The file has no C2PA manifest, so nothing cryptographic can be verified locally.'

/**
 * What to say about a file with no credentials. "We looked for a removed
 * label and found none" and "we did not look because the online check is off"
 * are different facts, and the person can only act on the second. A video is
 * looked up from one frame's fingerprint (#197); its words say the video stays
 * in the browser, and say when the browser could not read it.
 */
export function noLabelNote (r: { recovered: RecoveredCredential | null | undefined, checked: boolean, detail?: string, medium?: 'video' }): string {
  if (r.recovered != null) {
    // Normally the full credential opens in the panel. This note is the fallback
    // when its details could not be loaded, and it says so rather than hiding it.
    return recoveredNote(r.recovered) + (r.detail != null && r.detail !== '' ? ` Its full details could not be shown (${r.detail}).` : '')
  }
  const base = noLabel(r.medium ?? 'image')
  if (r.checked) return `${base} We also looked for a copy of a label that might have been removed, and found none.`
  if (r.medium === 'video') {
    return r.detail != null && r.detail !== ''
      ? `${base} We tried to look for a removed label and could not: ${r.detail}`
      : `${base} If its credentials were removed, a copy may still exist: turn on "Check durable credentials online" in the extension's Options and verify again. One frame is fingerprinted in your browser and only that fingerprint is sent, never the video.`
  }
  return `${base} If its credentials were removed, a copy may still exist: turn on "Check durable credentials online" in the extension's Options and verify again.`
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
