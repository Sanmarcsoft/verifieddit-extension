import { describe, expect, it } from 'bun:test'
import type { RelayConfig } from '../src/config'
import { InMemoryEraser } from '../src/eraser'
import {
  base64UrlEncode,
  canonicaliseErasurePayload,
  canonicaliseEventPayload,
  computeJwkThumbprint,
  createTicket,
  type PublicJwk,
  type RelayEvent
} from '../src/protocol'
import { RateLimiter } from '../src/rateLimiter'
import { createHandler } from '../src/server'

describe('HTTP Server Handler', () => {
  const testConfig: RelayConfig = {
    ticketKey: '01234567890123456789012345678901',
    umamiUrl: 'https://umami.example.internal',
    umamiWebsiteId: '00000000-0000-0000-0000-000000000000',
    port: 3000
  }

  async function generateTestKeyPair () {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as PublicJwk
    const thumbprint = await computeJwkThumbprint(publicJwk)
    return { keyPair, publicJwk, thumbprint }
  }

  async function signPayload (privateKey: CryptoKey, canonicalJson: string): Promise<string> {
    const rawSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      privateKey,
      new TextEncoder().encode(canonicalJson)
    )
    return base64UrlEncode(new Uint8Array(rawSig))
  }

  it('GET /healthz returns 200 and no configuration secrets', async () => {
    const handler = createHandler({ config: testConfig })
    const req = new Request('http://localhost/healthz', { method: 'GET' })
    const res = await handler(req, '127.0.0.1')

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(testConfig.ticketKey)
    expect(text).not.toContain(testConfig.umamiWebsiteId)
  })

  it('applies CORS headers exclusively to extension origins', async () => {
    const handler = createHandler({ config: testConfig })

    const chromeOrigin = 'chrome-extension://abcdefghijklmnop'
    const reqChrome = new Request('http://localhost/healthz', {
      method: 'GET',
      headers: { Origin: chromeOrigin }
    })
    const resChrome = await handler(reqChrome, '127.0.0.1')
    expect(resChrome.headers.get('Access-Control-Allow-Origin')).toBe(chromeOrigin)

    const mozOrigin = 'moz-extension://12345678-1234-1234-1234-123456789abc'
    const reqMoz = new Request('http://localhost/healthz', {
      method: 'GET',
      headers: { Origin: mozOrigin }
    })
    const resMoz = await handler(reqMoz, '127.0.0.1')
    expect(resMoz.headers.get('Access-Control-Allow-Origin')).toBe(mozOrigin)

    const webOrigin = 'https://malicious-site.example'
    const reqWeb = new Request('http://localhost/healthz', {
      method: 'GET',
      headers: { Origin: webOrigin }
    })
    const resWeb = await handler(reqWeb, '127.0.0.1')
    expect(resWeb.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('handles OPTIONS preflight requests for extension origins', async () => {
    const handler = createHandler({ config: testConfig })
    const req = new Request('http://localhost/v1/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://abcdef',
        'Access-Control-Request-Method': 'POST'
      }
    })
    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://abcdef')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('rejects oversized request bodies and malformed JSON', async () => {
    const handler = createHandler({ config: testConfig })

    const bigBody = JSON.stringify({ data: 'a'.repeat(9000) })
    const reqOversized = new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody
    })
    const resOversized = await handler(reqOversized, '127.0.0.1')
    expect(resOversized.status).toBe(400)
    expect(await resOversized.json()).toEqual({ error: 'payload_too_large' })

    const reqMalformed = new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json'
    })
    const resMalformed = await handler(reqMalformed, '127.0.0.1')
    expect(resMalformed.status).toBe(400)
    expect(await resMalformed.json()).toEqual({ error: 'malformed_json' })
  })

  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    const handler = createHandler({ config: testConfig })

    const reqNotFound = new Request('http://localhost/unknown-path', { method: 'POST' })
    const resNotFound = await handler(reqNotFound, '127.0.0.1')
    expect(resNotFound.status).toBe(404)
    expect(await resNotFound.json()).toEqual({ error: 'not_found' })

    const reqMethod = new Request('http://localhost/healthz', { method: 'POST' })
    const resMethod = await handler(reqMethod, '127.0.0.1')
    expect(resMethod.status).toBe(405)
    expect(await resMethod.json()).toEqual({ error: 'method_not_allowed' })
  })

  it('POST /v1/installs issues ticket and install_id, and rejects invalid keys', async () => {
    const handler = createHandler({ config: testConfig })
    const { publicJwk, thumbprint } = await generateTestKeyPair()

    const req = new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwk: publicJwk })
    })
    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(200)
    const json = await res.json() as { install_id: string, ticket: string, expires_at: number }
    expect(json.install_id).toBe(thumbprint)
    expect(typeof json.ticket).toBe('string')
    expect(json.expires_at).toBeGreaterThan(Date.now())

    // Reject private key
    const privateKeyReq = new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwk: { ...publicJwk, d: 'secret' } })
    })
    const resPrivate = await handler(privateKeyReq, '127.0.0.1')
    expect(resPrivate.status).toBe(400)
    expect(await resPrivate.json()).toEqual({ error: 'invalid_key' })
  })

  it('POST /v1/installs rate limits excessive requests from the same address', async () => {
    const rateLimiter = new RateLimiter({ maxRequests: 2, windowMs: 60000 })
    const handler = createHandler({ config: testConfig, rateLimiter })
    const { publicJwk } = await generateTestKeyPair()

    const makeReq = () => new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwk: publicJwk })
    })

    const res1 = await handler(makeReq(), '10.0.0.1')
    expect(res1.status).toBe(200)
    const res2 = await handler(makeReq(), '10.0.0.1')
    expect(res2.status).toBe(200)
    const res3 = await handler(makeReq(), '10.0.0.1')
    expect(res3.status).toBe(429)
    expect(await res3.json()).toEqual({ error: 'rate_limited' })
  })

  it('POST /v1/events accepts signed event and forwards to Umami with correct payload', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const fixedNow = 1700000000000
    const handler = createHandler({
      config: testConfig,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const event: RelayEvent = {
      name: 'verify_completed',
      params: {
        result: 'valid',
        has_durable_binding: true,
        media_type: 'image'
      }
    }

    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const body = {
      install_id: thumbprint,
      ticket,
      ts: fixedNow,
      event,
      version,
      sig,
      jwk: publicJwk
    }

    const req = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    const res = await handler(req, '192.168.1.100')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(capturedUrl).toBe('https://umami.example.internal/api/send')
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('verifieddit-telemetry-relay/1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Forwarded-For']).toBeUndefined()

    const sentBody = JSON.parse(String(capturedInit?.body))
    expect(sentBody).toEqual({
      type: 'event',
      payload: {
        website: testConfig.umamiWebsiteId,
        hostname: 'extension.verifieddit.com',
        url: '/verify_completed',
        name: 'verify_completed',
        data: {
          result: 'valid',
          has_durable_binding: true,
          media_type: 'image',
          extension_version: '1.3.0'
        },
        id: thumbprint
      }
    })
  })

  it('POST /v1/events returns 502 if Umami upstream fails or returns non-2xx', async () => {
    const mockFetch = async () => new Response('Internal error', { status: 500 })
    const fixedNow = 1700000000000
    const handler = createHandler({
      config: testConfig,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const req = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        sig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream_failed' })
  })

  it('POST /v1/events rejects invalid signatures, tickets, skew, or event params', async () => {
    const fixedNow = 1700000000000
    const handler = createHandler({ config: testConfig, now: () => fixedNow })
    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    // Tampered signature
    const badSigReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        sig: 'bad-sig'.repeat(10),
        jwk: publicJwk
      })
    })
    const resBadSig = await handler(badSigReq, '127.0.0.1')
    expect(resBadSig.status).toBe(400)
    expect(await resBadSig.json()).toEqual({ error: 'invalid_signature' })

    // Timestamp skew > 5 minutes
    const skewedReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow - 300001,
        event,
        version,
        sig,
        jwk: publicJwk
      })
    })
    const resSkewed = await handler(skewedReq, '127.0.0.1')
    expect(resSkewed.status).toBe(400)
    expect(await resSkewed.json()).toEqual({ error: 'invalid_timestamp' })

    // Expired ticket
    const expiredTicket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow - 1000)
    const expiredTicketReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket: expiredTicket,
        ts: fixedNow,
        event,
        version,
        sig,
        jwk: publicJwk
      })
    })
    const resExpired = await handler(expiredTicketReq, '127.0.0.1')
    expect(resExpired.status).toBe(400)
    expect(await resExpired.json()).toEqual({ error: 'invalid_ticket' })

    // Mismatched install_id
    const mismatchedIdReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: 'tampered-install-id',
        ticket,
        ts: fixedNow,
        event,
        version,
        sig,
        jwk: publicJwk
      })
    })
    const resMismatched = await handler(mismatchedIdReq, '127.0.0.1')
    expect(resMismatched.status).toBe(400)
    expect(await resMismatched.json()).toEqual({ error: 'invalid_install_id' })
  })

  it('DELETE /v1/installs verifies signature and enqueues erasure in Eraser', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const handler = createHandler({ config: testConfig, eraser, now: () => fixedNow })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const erasureCanonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: fixedNow
    })
    const sig = await signPayload(keyPair.privateKey, erasureCanonical)

    const req = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        sig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(eraser.queue.length).toBe(1)
    expect(eraser.queue[0]).toEqual({
      install_id: thumbprint,
      requested_at: fixedNow
    })
  })

  it('DELETE /v1/installs rejects replayed event signatures', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const handler = createHandler({ config: testConfig, eraser, now: () => fixedNow })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    // Event signature instead of erasure signature
    const eventCanonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event: { name: 'extension_installed', params: {} },
      version: '1.3.0'
    })
    const eventSig = await signPayload(keyPair.privateKey, eventCanonical)

    const req = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        sig: eventSig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_signature' })
    expect(eraser.queue.length).toBe(0)
  })
})
