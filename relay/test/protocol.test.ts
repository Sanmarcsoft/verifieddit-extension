import { describe, expect, it } from 'bun:test'
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalise,
  canonicaliseErasurePayload,
  canonicaliseEventPayload,
  computeJwkThumbprint,
  createTicket,
  validateBrowser,
  validateEvent,
  validatePublicJwk,
  validateTimestamp,
  validateVersion,
  verifyEcdsaSignature,
  verifyTicket,
  type Browser,
  type PublicJwk,
  type RelayEvent,
  FORWARD_USER_AGENTS,
  umamiAccepted
} from '../src/protocol'

describe('base64url helpers', () => {
  it('encodes and decodes bytes without padding', () => {
    const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = base64UrlEncode(data)
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    const decoded = base64UrlDecode(encoded)
    expect(decoded).toEqual(data)
  })

  it('rejects invalid base64url characters', () => {
    expect(() => base64UrlDecode('abc+123')).toThrow()
    expect(() => base64UrlDecode('abc/123')).toThrow()
  })
})

describe('RFC 7638 JWK thumbprint', () => {
  it('calculates deterministic thumbprint over canonical fields', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as PublicJwk

    const thumbprint1 = await computeJwkThumbprint(exported)
    const thumbprint2 = await computeJwkThumbprint(exported)
    expect(thumbprint1).toBe(thumbprint2)
    expect(thumbprint1.length).toBeGreaterThan(20)
  })

  it('rejects private keys with a d member', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    expect(() => validatePublicJwk(privateJwk)).toThrow('Private key rejected')
  })

  it('rejects non P-256 or non EC keys', () => {
    expect(() => validatePublicJwk({ kty: 'RSA', e: 'AQAB', n: 'abc' })).toThrow()
    expect(() => validatePublicJwk({ kty: 'EC', crv: 'P-384', x: 'abc', y: 'def' })).toThrow()
    expect(() => validatePublicJwk({ kty: 'EC', crv: 'P-256' })).toThrow()
  })
})

describe('canonicalise', () => {
  it('sorts object keys lexicographically and strips whitespace', () => {
    const obj = { z: 1, a: 'hello', m: { b: 2, a: 1 } }
    const canonical = canonicalise(obj)
    expect(canonical).toBe('{"a":"hello","m":{"a":1,"b":2},"z":1}')
  })

  it('handles primitives and arrays', () => {
    expect(canonicalise('str')).toBe('"str"')
    expect(canonicalise(42)).toBe('42')
    expect(canonicalise(true)).toBe('true')
    expect(canonicalise([3, 2, 1])).toBe('[3,2,1]')
    expect(canonicalise(null)).toBe('null')
  })

  it('creates deterministic event payload with sorted signed fields', () => {
    const event: RelayEvent = {
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: true,
        media_type: 'image'
      }
    }

    const payload = {
      install_id: 'inst_123',
      ts: 1700000000000,
      event,
      version: '1.3.0',
      browser: 'chrome' as const
    }

    const canonical = canonicaliseEventPayload(payload)
    expect(canonical).toBe(
      '{"browser":"chrome","event":{"name":"verify_completed","params":{"has_durable_binding":true,"media_type":"image","result":"valid"}},"install_id":"inst_123","ts":1700000000000,"version":"1.3.0"}'
    )

    const payloadFirefox = {
      ...payload,
      browser: 'firefox' as const
    }
    expect(canonicaliseEventPayload(payloadFirefox)).toBe(
      '{"browser":"firefox","event":{"name":"verify_completed","params":{"has_durable_binding":true,"media_type":"image","result":"valid"}},"install_id":"inst_123","ts":1700000000000,"version":"1.3.0"}'
    )
  })

  it('creates deterministic erasure payload with action discriminator', () => {
    const canonical = canonicaliseErasurePayload({
      install_id: 'inst_123',
      ts: 1700000000000,
      browser: 'chrome'
    })

    expect(canonical).toBe('{"action":"erase","browser":"chrome","install_id":"inst_123","ts":1700000000000}')

    const canonicalFirefox = canonicaliseErasurePayload({
      install_id: 'inst_123',
      ts: 1700000000000,
      browser: 'firefox'
    })
    expect(canonicalFirefox).toBe('{"action":"erase","browser":"firefox","install_id":"inst_123","ts":1700000000000}')
  })
})

describe('validateBrowser', () => {
  it('accepts exact strings "chrome" and "firefox"', () => {
    expect(validateBrowser('chrome')).toBe('chrome')
    expect(validateBrowser('firefox')).toBe('firefox')
  })

  it('rejects missing, non-string, casing differences, or invalid values with invalid_browser', () => {
    const invalidValues = [
      undefined,
      null,
      123,
      true,
      {},
      [],
      '',
      'Chrome',
      'Firefox',
      'CHROME',
      'edge',
      'safari',
      'opera',
      'chrome ',
      ' chrome',
      'firefox ',
      ' firefox'
    ]

    for (const val of invalidValues) {
      expect(() => validateBrowser(val)).toThrow()
      try {
        validateBrowser(val)
      } catch (err: any) {
        expect(err.code).toBe('invalid_browser')
      }
    }
  })
})

describe('HMAC tickets', () => {
  const ticketKey = '01234567890123456789012345678901'
  const installId = 'test-install-id-1234'

  it('creates and verifies a valid ticket', async () => {
    const now = 1700000000000
    const expiresAt = now + 600000
    const ticket = await createTicket(ticketKey, installId, expiresAt)

    const isValid = await verifyTicket(ticketKey, installId, ticket, now)
    expect(isValid).toBe(true)
  })

  it('rejects expired ticket', async () => {
    const now = 1700000000000
    const expiresAt = now - 1000
    const ticket = await createTicket(ticketKey, installId, expiresAt)

    const isValid = await verifyTicket(ticketKey, installId, ticket, now)
    expect(isValid).toBe(false)
  })

  it('rejects ticket with mismatched install_id or key', async () => {
    const now = 1700000000000
    const expiresAt = now + 600000
    const ticket = await createTicket(ticketKey, installId, expiresAt)

    const wrongId = await verifyTicket(ticketKey, 'different-id', ticket, now)
    expect(wrongId).toBe(false)

    const wrongKey = await verifyTicket('different-key-01234567890123456789', installId, ticket, now)
    expect(wrongKey).toBe(false)
  })

  it('rejects malformed ticket strings', async () => {
    const now = 1700000000000
    expect(await verifyTicket(ticketKey, installId, 'invalid', now)).toBe(false)
    expect(await verifyTicket(ticketKey, installId, 'notanumber.sig', now)).toBe(false)
  })
})

describe('ECDSA P-256 signature verification', () => {
  it('signs and verifies payload using WebCrypto IEEE P1363 raw signature', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as PublicJwk

    const message = new TextEncoder().encode('canonical-test-data')
    const rawSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      keyPair.privateKey,
      message
    )
    const sigBase64Url = base64UrlEncode(new Uint8Array(rawSig))

    const isValid = await verifyEcdsaSignature(publicJwk, sigBase64Url, message)
    expect(isValid).toBe(true)

    const corruptedMessage = new TextEncoder().encode('corrupted-data')
    const isCorruptedValid = await verifyEcdsaSignature(publicJwk, sigBase64Url, corruptedMessage)
    expect(isCorruptedValid).toBe(false)
  })
})

describe('validateTimestamp', () => {
  const now = 1700000000000

  it('accepts timestamps within 5 minutes', () => {
    expect(validateTimestamp(now, now)).toBe(true)
    expect(validateTimestamp(now - 4 * 60 * 1000, now)).toBe(true)
    expect(validateTimestamp(now + 4 * 60 * 1000, now)).toBe(true)
    expect(validateTimestamp(now - 5 * 60 * 1000, now)).toBe(true)
    expect(validateTimestamp(now + 5 * 60 * 1000, now)).toBe(true)
  })

  it('rejects timestamps skewed more than 5 minutes or invalid values', () => {
    expect(validateTimestamp(now - 300001, now)).toBe(false)
    expect(validateTimestamp(now + 300001, now)).toBe(false)
    expect(validateTimestamp('1700000000000', now)).toBe(false)
    expect(validateTimestamp(NaN, now)).toBe(false)
    expect(validateTimestamp(Infinity, now)).toBe(false)
  })
})

describe('validateVersion', () => {
  it('accepts string versions up to 32 chars', () => {
    expect(validateVersion('1.3.0')).toBe('1.3.0')
    expect(validateVersion('a'.repeat(32))).toBe('a'.repeat(32))
  })

  it('rejects empty, non-string or over-length versions', () => {
    expect(() => validateVersion('')).toThrow()
    expect(() => validateVersion('a'.repeat(33))).toThrow()
    expect(() => validateVersion(123)).toThrow()
    expect(() => validateVersion(null)).toThrow()
  })
})

describe('validateEvent', () => {
  it('validates extension_installed', () => {
    expect(validateEvent({ name: 'extension_installed', params: {} })).toEqual({
      name: 'extension_installed',
      params: {}
    })
    expect(() => validateEvent({ name: 'extension_installed', params: { extra: 1 } })).toThrow()
  })

  it('validates extension_updated', () => {
    expect(validateEvent({
      name: 'extension_updated',
      params: { previous_version: '1.2.6' }
    })).toEqual({
      name: 'extension_updated',
      params: { previous_version: '1.2.6' }
    })
    expect(() => validateEvent({
      name: 'extension_updated',
      params: { previous_version: 'a'.repeat(33) }
    })).toThrow()
    expect(() => validateEvent({
      name: 'extension_updated',
      params: { previous_version: '1.2.6', extra: true }
    })).toThrow()
  })

  it('validates verify_started', () => {
    for (const source of ['context_menu', 'popup', 'auto_scan'] as const) {
      expect(validateEvent({ name: 'verify_started', params: { source } })).toEqual({
        name: 'verify_started',
        params: { source }
      })
    }
    expect(() => validateEvent({ name: 'verify_started', params: { source: 'other' } })).toThrow()
  })

  it('validates verify_completed', () => {
    expect(validateEvent({
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: true,
        media_type: 'image'
      }
    })).toEqual({
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: true,
        media_type: 'image'
      }
    })

    expect(() => validateEvent({
      name: 'verify_completed',
      params: {
        result: 'unknown_result',
        has_durable_binding: true,
        media_type: 'image'
      }
    })).toThrow()

    expect(() => validateEvent({
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: 'true', // not boolean
        media_type: 'image'
      }
    })).toThrow()

    expect(() => validateEvent({
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: true,
        media_type: 'exe' // invalid media_type
      }
    })).toThrow()
  })

  it('validates badge_scan and options_opened', () => {
    expect(validateEvent({ name: 'badge_scan', params: {} })).toEqual({
      name: 'badge_scan',
      params: {}
    })
    expect(validateEvent({ name: 'options_opened', params: {} })).toEqual({
      name: 'options_opened',
      params: {}
    })
    expect(() => validateEvent({ name: 'badge_scan', params: { x: 1 } })).toThrow()
    expect(() => validateEvent({ name: 'options_opened', params: { x: 1 } })).toThrow()
  })

  it('validates consent_changed', () => {
    expect(validateEvent({ name: 'consent_changed', params: { value: 'granted' } })).toEqual({
      name: 'consent_changed',
      params: { value: 'granted' }
    })
    expect(validateEvent({ name: 'consent_changed', params: { value: 'denied' } })).toEqual({
      name: 'consent_changed',
      params: { value: 'denied' }
    })
    expect(() => validateEvent({ name: 'consent_changed', params: { value: 'unset' } })).toThrow()
  })

  it('rejects unknown event names', () => {
    expect(() => validateEvent({ name: 'unknown_event', params: {} })).toThrow()
  })
})

describe('forwarding to Umami', () => {
  test('each browser family is forwarded under a fixed browser user agent, never a tool name', () => {
    // Umami answers 200 {"beep":"boop"} to a sender it takes for a bot and records nothing.
    expect(FORWARD_USER_AGENTS.chrome).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/)
    expect(FORWARD_USER_AGENTS.firefox).toMatch(/^Mozilla\/5\.0 .*Firefox\/\d+/)
    expect(FORWARD_USER_AGENTS.firefox).not.toContain('Chrome')
  })

  test('a bot answer from Umami counts as not recorded', () => {
    expect(umamiAccepted('{"beep":"boop"}')).toBe(false)
    expect(umamiAccepted('{"cache":"eyJhbGciOi"}')).toBe(true)
    expect(umamiAccepted('')).toBe(true)
    expect(umamiAccepted('not json')).toBe(true)
  })
})
