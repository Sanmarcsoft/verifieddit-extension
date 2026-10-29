/*
 * Where a COSE signature keeps its RFC 3161 timestamp tokens.
 *
 * C2PA v1 signatures use the unprotected header `sigTst` (the token covers the
 * payload). C2PA v2 signatures use `sigTst2` (the token covers the signature).
 * The container shape is the same in both: { tstTokens: [...] }. Callers only
 * need "the tokens, wherever they are", so this is the one place that knows
 * the two names.
 */

export const TIMESTAMP_HEADER_LABELS = ['sigTst2', 'sigTst'] as const

interface TimestampContainer<T> { tstTokens?: T[] | null }

/**
 * The timestamp tokens of a decoded COSE unprotected header, or null when the
 * signature carries none. `sigTst2` wins when both headers hold tokens.
 */
export function timestampTokensOf<T = unknown> (
  unprotected: Record<string | number, unknown> | null | undefined
): T[] | null {
  if (unprotected == null) return null
  for (const label of TIMESTAMP_HEADER_LABELS) {
    const tokens = (unprotected[label] as TimestampContainer<T> | undefined)?.tstTokens
    if (Array.isArray(tokens) && tokens.length > 0) return tokens
  }
  return null
}
