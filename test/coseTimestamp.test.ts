/*
 * A C2PA v1 signature carries its RFC 3161 timestamp in the COSE header
 * `sigTst`; a v2 signature (claim v2, e.g. the CAI mobile SDKs) carries it in
 * `sigTst2`. Both must count as "this signature has a timestamp", otherwise a
 * v2 file with an expired short-lived certificate is wrongly reported as
 * having no timestamp to cover the expiry.
 */
import { describe, expect, test } from 'bun:test'
import { timestampTokensOf } from '../src/certs/coseTimestamp'

const token = (serialNumber: number) => ({ serialNumber })

describe('timestampTokensOf', () => {
  test('reads a v1 sigTst header', () => {
    expect(timestampTokensOf({ sigTst: { tstTokens: [token(1)] } })).toEqual([token(1)])
  })

  test('reads a v2 sigTst2 header', () => {
    expect(timestampTokensOf({ sigTst2: { tstTokens: [token(2)] } })).toEqual([token(2)])
  })

  test('prefers sigTst2 when both are present', () => {
    expect(timestampTokensOf({
      sigTst: { tstTokens: [token(1)] },
      sigTst2: { tstTokens: [token(2)] }
    })).toEqual([token(2)])
  })

  test('falls back to sigTst when sigTst2 holds no tokens', () => {
    expect(timestampTokensOf({
      sigTst: { tstTokens: [token(1)] },
      sigTst2: { tstTokens: [] }
    })).toEqual([token(1)])
  })

  test('returns null when there is no timestamp header', () => {
    expect(timestampTokensOf({})).toBeNull()
    expect(timestampTokensOf(null)).toBeNull()
    expect(timestampTokensOf(undefined)).toBeNull()
  })
})
