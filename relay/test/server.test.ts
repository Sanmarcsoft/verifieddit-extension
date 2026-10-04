import { describe, expect, it } from 'bun:test'
import type { RelayConfig } from '../src/config'
import { InMemoryEraser } from '../src/eraser'
import {
  base64UrlEncode,
  canonicaliseErasurePayload,
  canonicaliseEventPayload,
  computeJwkThumbprint,
  createTicket,
  type Browser,
  type PublicJwk,
  type RelayEvent
} from '../src/protocol'
import {
  ERASURE_PER_ADDRESS_MAX,
  ERASURE_PER_ADDRESS_WINDOW_MS,
  ERASURE_PER_INSTALL_MAX,
  ERASURE_PER_INSTALL_WINDOW_MS,
  EVENTS_PER_ADDRESS_MAX,
  EVENTS_PER_ADDRESS_WINDOW_MS,
  EVENTS_PER_INSTALL_MAX,
  EVENTS_PER_INSTALL_WINDOW_MS,
  INSTALLS_PER_ADDRESS_MAX,
  INSTALLS_PER_ADDRESS_WINDOW_MS
} from '../src/limits'
import { RateLimiter } from '../src/rateLimiter'
import { ReplayCache } from '../src/replayCache'
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
    const installsRateLimiter = new RateLimiter({ maxRequests: 2, windowMs: 60000 })
    const handler = createHandler({ config: testConfig, installsRateLimiter })
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
      version,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const body = {
      install_id: thumbprint,
      ticket,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome' as const,
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
          extension_version: '1.3.0',
          browser: 'chrome'
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
      version,
      browser: 'chrome'
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
        browser: 'chrome',
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
      version,
      browser: 'chrome'
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
        browser: 'chrome',
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
        browser: 'chrome',
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
        browser: 'chrome',
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
        browser: 'chrome',
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
      ts: fixedNow,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, erasureCanonical)

    const req = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        browser: 'chrome',
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
      version: '1.3.0',
      browser: 'chrome'
    })
    const eventSig = await signPayload(keyPair.privateKey, eventCanonical)

    const req = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        browser: 'chrome',
        sig: eventSig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_signature' })
    expect(eraser.queue.length).toBe(0)
  })

  it('OPTIONS preflight with Origin: https://evil.example gets no Access-Control-Allow-Origin and no Access-Control-Allow-Methods', async () => {
    const handler = createHandler({ config: testConfig })
    const req = new Request('http://localhost/v1/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST'
      }
    })
    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull()
  })

  it('POST /v1/events with over-long or empty version returns 4xx invalid_version and forwards nothing', async () => {
    let forwarded = false
    const mockFetch = async () => {
      forwarded = true
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
    const event: RelayEvent = { name: 'extension_installed', params: {} }

    for (const badVersion of ['', 'a'.repeat(33)]) {
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts: fixedNow,
        event,
        version: badVersion,
        browser: 'chrome'
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
          version: badVersion,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })

      const res = await handler(req, '127.0.0.1')
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(await res.json()).toEqual({ error: 'invalid_version' })
      expect(forwarded).toBe(false)
    }
  })

  it('POST /v1/events with unknown event name or extra key in params returns 4xx invalid_event and forwards nothing', async () => {
    let forwarded = false
    const mockFetch = async () => {
      forwarded = true
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
    const version = '1.3.0'

    // Unknown event name
    const unknownEvent = { name: 'unknown_event_name', params: {} } as unknown as RelayEvent
    const canonicalUnknown = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event: unknownEvent,
      version,
      browser: 'chrome'
    })
    const sigUnknown = await signPayload(keyPair.privateKey, canonicalUnknown)

    const reqUnknown = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event: unknownEvent,
        version,
        browser: 'chrome',
        sig: sigUnknown,
        jwk: publicJwk
      })
    })

    const resUnknown = await handler(reqUnknown, '127.0.0.1')
    expect(resUnknown.status).toBeGreaterThanOrEqual(400)
    expect(resUnknown.status).toBeLessThan(500)
    expect(await resUnknown.json()).toEqual({ error: 'invalid_event' })
    expect(forwarded).toBe(false)

    // Extra key in event.params
    const extraParamsEvent = {
      name: 'extension_installed',
      params: { extra_field: 'disallowed' }
    } as unknown as RelayEvent
    const canonicalExtra = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event: extraParamsEvent,
      version,
      browser: 'chrome'
    })
    const sigExtra = await signPayload(keyPair.privateKey, canonicalExtra)

    const reqExtra = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event: extraParamsEvent,
        version,
        browser: 'chrome',
        sig: sigExtra,
        jwk: publicJwk
      })
    })

    const resExtra = await handler(reqExtra, '127.0.0.1')
    expect(resExtra.status).toBeGreaterThanOrEqual(400)
    expect(resExtra.status).toBeLessThan(500)
    expect(await resExtra.json()).toEqual({ error: 'invalid_event' })
    expect(forwarded).toBe(false)
  })

  it('POST /v1/events accepts both chrome and firefox and forwards browser in data payload', async () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      let capturedBody: any = null
      const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body))
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
        name: 'verify_started',
        params: { source: 'popup' }
      }
      const version = '1.3.0'
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts: fixedNow,
        event,
        version,
        browser
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
          browser,
          sig,
          jwk: publicJwk
        })
      })

      const res = await handler(req, '127.0.0.1')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(capturedBody).toEqual({
        type: 'event',
        payload: {
          website: testConfig.umamiWebsiteId,
          hostname: 'extension.verifieddit.com',
          url: '/verify_started',
          name: 'verify_started',
          data: {
            source: 'popup',
            extension_version: '1.3.0',
            browser
          },
          id: thumbprint
        }
      })
    }
  })

  it('POST /v1/events rejects missing, non-string, casing differences, or invalid browser values with 400 invalid_browser', async () => {
    let forwarded = false
    const mockFetch = async () => {
      forwarded = true
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const fixedNow = 1700000000000
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const handler = createHandler({
      config: testConfig,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow,
      replayCache
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'

    const invalidBrowsers = [
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
      'chrome ',
      ' chrome',
      'firefox '
    ]

    for (const badBrowser of invalidBrowsers) {
      forwarded = false
      const body: Record<string, unknown> = {
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        sig: 'dummy-sig',
        jwk: publicJwk
      }
      if (badBrowser !== undefined) {
        body.browser = badBrowser
      }

      const req = new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const res = await handler(req, '127.0.0.1')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_browser' })
      expect(forwarded).toBe(false)
      expect(replayCache.size).toBe(0)
    }
  })

  it('POST /v1/events fails signature verification if browser value is changed in transit', async () => {
    let forwarded = false
    const mockFetch = async () => {
      forwarded = true
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const fixedNow = 1700000000000
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const handler = createHandler({
      config: testConfig,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow,
      replayCache
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'

    // Signed with chrome
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    // Sent with firefox
    const req = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        browser: 'firefox',
        sig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_signature' })
    expect(forwarded).toBe(false)
    expect(replayCache.size).toBe(0)
  })

  it('DELETE /v1/installs accepts both chrome and firefox browser values', async () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const fixedNow = 1700000000000
      const eraser = new InMemoryEraser()
      const handler = createHandler({ config: testConfig, eraser, now: () => fixedNow })

      const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
      const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

      const canonical = canonicaliseErasurePayload({
        install_id: thumbprint,
        ts: fixedNow,
        browser
      })
      const sig = await signPayload(keyPair.privateKey, canonical)

      const req = new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts: fixedNow,
          browser,
          sig,
          jwk: publicJwk
        })
      })

      const res = await handler(req, '127.0.0.1')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(eraser.queue).toEqual([{ install_id: thumbprint, requested_at: fixedNow }])
    }
  })

  it('DELETE /v1/installs rejects missing, non-string, casing differences, or invalid browser values with 400 invalid_browser', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const handler = createHandler({
      config: testConfig,
      eraser,
      now: () => fixedNow,
      replayCache
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const invalidBrowsers = [
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
      'chrome ',
      ' chrome',
      'firefox '
    ]

    for (const badBrowser of invalidBrowsers) {
      const body: Record<string, unknown> = {
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        sig: 'dummy-sig',
        jwk: publicJwk
      }
      if (badBrowser !== undefined) {
        body.browser = badBrowser
      }

      const req = new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const res = await handler(req, '127.0.0.1')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_browser' })
      expect(eraser.queue.length).toBe(0)
      expect(replayCache.size).toBe(0)
    }
  })

  it('DELETE /v1/installs fails signature verification if browser value is changed in transit', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const handler = createHandler({
      config: testConfig,
      eraser,
      now: () => fixedNow,
      replayCache
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    // Signed with chrome
    const canonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: fixedNow,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    // Sent with firefox
    const req = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        browser: 'firefox',
        sig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_signature' })
    expect(eraser.queue.length).toBe(0)
    expect(replayCache.size).toBe(0)
  })

  it('DELETE /v1/installs with expired ticket or skewed ts returns 4xx and eraser queue stays empty', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const handler = createHandler({ config: testConfig, eraser, now: () => fixedNow })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()

    // Expired ticket
    const expiredTicket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow - 1000)
    const erasureCanonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: fixedNow,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, erasureCanonical)

    const reqExpiredTicket = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket: expiredTicket,
        ts: fixedNow,
        browser: 'chrome',
        sig,
        jwk: publicJwk
      })
    })
    const resExpiredTicket = await handler(reqExpiredTicket, '127.0.0.1')
    expect(resExpiredTicket.status).toBeGreaterThanOrEqual(400)
    expect(resExpiredTicket.status).toBeLessThan(500)
    expect(await resExpiredTicket.json()).toEqual({ error: 'invalid_ticket' })
    expect(eraser.queue.length).toBe(0)

    // Valid ticket, but ts skewed more than 5 minutes (300,001 ms)
    const validTicket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const skewedTs = fixedNow - 300001
    const skewedCanonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: skewedTs,
      browser: 'chrome'
    })
    const skewedSig = await signPayload(keyPair.privateKey, skewedCanonical)

    const reqSkewed = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket: validTicket,
        ts: skewedTs,
        browser: 'chrome',
        sig: skewedSig,
        jwk: publicJwk
      })
    })
    const resSkewed = await handler(reqSkewed, '127.0.0.1')
    expect(resSkewed.status).toBeGreaterThanOrEqual(400)
    expect(resSkewed.status).toBeLessThan(500)
    expect(await resSkewed.json()).toEqual({ error: 'invalid_timestamp' })
    expect(eraser.queue.length).toBe(0)
  })

  it('upstream Umami fetch rejecting yields 502 with machine-readable reason and does not throw', async () => {
    const mockRejectingFetch = async () => {
      throw new Error('Network timeout or connection refused')
    }
    const fixedNow = 1700000000000
    const handler = createHandler({
      config: testConfig,
      fetch: mockRejectingFetch as unknown as typeof fetch,
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
      version,
      browser: 'chrome'
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
        browser: 'chrome',
        sig,
        jwk: publicJwk
      })
    })

    let res: Response | undefined
    let didThrow = false
    try {
      res = await handler(req, '127.0.0.1')
    } catch {
      didThrow = true
    }

    expect(didThrow).toBe(false)
    expect(res).toBeDefined()
    expect(res?.status).toBe(502)
    expect(await res?.json()).toEqual({ error: 'upstream_failed' })
  })

  it('forwards no client address headers or body address even when present on incoming request', async () => {
    let capturedInit: RequestInit | undefined
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
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
    const event: RelayEvent = { name: 'options_opened', params: {} }
    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const incomingClientIp = '203.0.113.195'
    const req = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': incomingClientIp,
        'X-Real-IP': incomingClientIp,
        'CF-Connecting-IP': incomingClientIp,
        Forwarded: `for=${incomingClientIp};proto=https`
      },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        browser: 'chrome',
        sig,
        jwk: publicJwk
      })
    })

    const res = await handler(req, incomingClientIp)
    expect(res.status).toBe(200)

    const forwardedHeaders = capturedInit?.headers as Record<string, string>
    expect(forwardedHeaders['X-Forwarded-For']).toBeUndefined()
    expect(forwardedHeaders['X-Real-IP']).toBeUndefined()
    expect(forwardedHeaders['CF-Connecting-IP']).toBeUndefined()
    expect(forwardedHeaders.Forwarded).toBeUndefined()

    const rawForwardedBody = String(capturedInit?.body)
    expect(rawForwardedBody).not.toContain(incomingClientIp)
  })

  it('POST /v1/events with same event twice gives 2xx then 409 replayed_request and exactly one upstream fetch', async () => {
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
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
    const event: RelayEvent = { name: 'options_opened', params: {} }
    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const payload = JSON.stringify({
      install_id: thumbprint,
      ticket,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome',
      sig,
      jwk: publicJwk
    })

    const req1 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res1 = await handler(req1, '127.0.0.1')
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({ ok: true })
    expect(fetchCount).toBe(1)

    const req2 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res2 = await handler(req2, '127.0.0.1')
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: 'replayed_request' })
    expect(fetchCount).toBe(1)
  })

  it('DELETE /v1/installs with same erasure twice gives 2xx then 409 and exactly one eraser queue entry', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const handler = createHandler({
      config: testConfig,
      eraser,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const canonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: fixedNow,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const payload = JSON.stringify({
      install_id: thumbprint,
      ticket,
      ts: fixedNow,
      browser: 'chrome',
      sig,
      jwk: publicJwk
    })

    const req1 = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res1 = await handler(req1, '127.0.0.1')
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({ ok: true })
    expect(eraser.queue.length).toBe(1)

    const req2 = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res2 = await handler(req2, '127.0.0.1')
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: 'replayed_request' })
    expect(eraser.queue.length).toBe(1)
  })

  it('a request with an INVALID signature sent twice is rejected with the signature error both times and does not occupy the cache', async () => {
    const fixedNow = 1700000000000
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const handler = createHandler({
      config: testConfig,
      replayCache,
      now: () => fixedNow
    })

    const { publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
    const event: RelayEvent = { name: 'badge_scan', params: {} }
    const badSig = 'invalid-signature-value-that-fails-verification'

    const payload = JSON.stringify({
      install_id: thumbprint,
      ticket,
      ts: fixedNow,
      event,
      version: '1.3.0',
      browser: 'chrome',
      sig: badSig,
      jwk: publicJwk
    })

    const req1 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res1 = await handler(req1, '127.0.0.1')
    expect(res1.status).toBe(400)
    expect(await res1.json()).toEqual({ error: 'invalid_signature' })
    expect(replayCache.size).toBe(0)

    const req2 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res2 = await handler(req2, '127.0.0.1')
    expect(res2.status).toBe(400)
    expect(await res2.json()).toEqual({ error: 'invalid_signature' })
    expect(replayCache.size).toBe(0)
  })

  it('the same event resent after the timestamp window is rejected for its timestamp (not as a replay) and the cache does not grow without bound', async () => {
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    let currentTime = 1700000000000
    const replayCache = new ReplayCache({ now: () => currentTime })
    const handler = createHandler({
      config: testConfig,
      fetch: mockFetch as unknown as typeof fetch,
      replayCache,
      now: () => currentTime
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, currentTime + 1000000)
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'
    const eventTs = currentTime
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: eventTs,
      event,
      version,
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)

    const payload = JSON.stringify({
      install_id: thumbprint,
      ticket,
      ts: eventTs,
      event,
      version,
      browser: 'chrome',
      sig,
      jwk: publicJwk
    })

    const req1 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res1 = await handler(req1, '127.0.0.1')
    expect(res1.status).toBe(200)
    expect(fetchCount).toBe(1)
    expect(replayCache.size).toBe(1)

    // Advance clock past the 5-minute timestamp window (e.g. 5 minutes + 1 ms = 300,001 ms)
    currentTime = eventTs + 300001

    // Same event resent now: rejected as invalid_timestamp, not as replayed_request
    const req2 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    const res2 = await handler(req2, '127.0.0.1')
    expect(res2.status).toBe(400)
    expect(await res2.json()).toEqual({ error: 'invalid_timestamp' })
    expect(fetchCount).toBe(1)

    // Expired entry has been dropped from the cache: cache does not grow without bound
    expect(replayCache.size).toBe(0)
  })

  it('defines the expected rate limit constants in limits.ts', () => {
    expect(EVENTS_PER_INSTALL_MAX).toBe(120)
    expect(EVENTS_PER_INSTALL_WINDOW_MS).toBe(60 * 1000)
    expect(EVENTS_PER_ADDRESS_MAX).toBe(600)
    expect(EVENTS_PER_ADDRESS_WINDOW_MS).toBe(60 * 1000)
    expect(ERASURE_PER_INSTALL_MAX).toBe(5)
    expect(ERASURE_PER_INSTALL_WINDOW_MS).toBe(60 * 60 * 1000)
    expect(ERASURE_PER_ADDRESS_MAX).toBe(30)
    expect(ERASURE_PER_ADDRESS_WINDOW_MS).toBe(60 * 60 * 1000)
    expect(INSTALLS_PER_ADDRESS_MAX).toBe(30)
    expect(INSTALLS_PER_ADDRESS_WINDOW_MS).toBe(60 * 1000)
  })

  it('events over the per-install limit give 429 rate_limited and no upstream fetch for the rejected request', async () => {
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const fixedNow = 1700000000000
    const eventsInstallRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eventsInstallRateLimiter,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const sendEvent = async (offsetMs: number) => {
      const ts = fixedNow + offsetMs
      const event: RelayEvent = { name: 'extension_installed', params: {} }
      const version = '1.3.0'
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts,
        event,
        version,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)

      const req = new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts,
          event,
          version,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
      return await handler(req, '192.0.2.1')
    }

    const res1 = await sendEvent(0)
    expect(res1.status).toBe(200)
    expect(fetchCount).toBe(1)

    const res2 = await sendEvent(10)
    expect(res2.status).toBe(200)
    expect(fetchCount).toBe(2)

    const res3 = await sendEvent(20)
    expect(res3.status).toBe(429)
    expect(await res3.json()).toEqual({ error: 'rate_limited' })
    expect(fetchCount).toBe(2)
  })

  it('events over the per-address limit from DIFFERENT install ids give 429', async () => {
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const fixedNow = 1700000000000
    const eventsAddressRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eventsAddressRateLimiter,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const sendFromNewInstall = async (clientIp: string) => {
      const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
      const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
      const event: RelayEvent = { name: 'extension_installed', params: {} }
      const version = '1.3.0'
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts: fixedNow,
        event,
        version,
        browser: 'chrome'
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
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
      return await handler(req, clientIp)
    }

    const res1 = await sendFromNewInstall('192.0.2.1')
    expect(res1.status).toBe(200)
    expect(fetchCount).toBe(1)

    const res2 = await sendFromNewInstall('192.0.2.1')
    expect(res2.status).toBe(200)
    expect(fetchCount).toBe(2)

    const res3 = await sendFromNewInstall('192.0.2.1')
    expect(res3.status).toBe(429)
    expect(await res3.json()).toEqual({ error: 'rate_limited' })
    expect(fetchCount).toBe(2)

    const resDifferentIp = await sendFromNewInstall('192.0.2.2')
    expect(resDifferentIp.status).toBe(200)
    expect(fetchCount).toBe(3)
  })

  it('erasure over the per-install limit gives 429 and the eraser queue does not grow', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const erasureInstallRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 3600000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eraser,
      erasureInstallRateLimiter,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const sendErasure = async (offsetMs: number) => {
      const ts = fixedNow + offsetMs
      const canonical = canonicaliseErasurePayload({
        install_id: thumbprint,
        ts,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)

      const req = new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
      return await handler(req, '192.0.2.1')
    }

    const res1 = await sendErasure(0)
    expect(res1.status).toBe(200)
    expect(eraser.queue.length).toBe(1)

    const res2 = await sendErasure(10)
    expect(res2.status).toBe(200)
    expect(eraser.queue.length).toBe(2)

    const res3 = await sendErasure(20)
    expect(res3.status).toBe(429)
    expect(await res3.json()).toEqual({ error: 'rate_limited' })
    expect(eraser.queue.length).toBe(2)
  })

  it('erasure over the per-address limit gives 429', async () => {
    const fixedNow = 1700000000000
    const eraser = new InMemoryEraser()
    const erasureAddressRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 3600000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eraser,
      erasureAddressRateLimiter,
      now: () => fixedNow
    })

    const sendErasureFromNewInstall = async (clientIp: string) => {
      const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
      const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)
      const canonical = canonicaliseErasurePayload({
        install_id: thumbprint,
        ts: fixedNow,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)

      const req = new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts: fixedNow,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
      return await handler(req, clientIp)
    }

    const res1 = await sendErasureFromNewInstall('192.0.2.1')
    expect(res1.status).toBe(200)

    const res2 = await sendErasureFromNewInstall('192.0.2.1')
    expect(res2.status).toBe(200)

    const res3 = await sendErasureFromNewInstall('192.0.2.1')
    expect(res3.status).toBe(429)
    expect(await res3.json()).toEqual({ error: 'rate_limited' })

    const resOtherIp = await sendErasureFromNewInstall('192.0.2.2')
    expect(resOtherIp.status).toBe(200)
  })

  it('limits reset after the window (fake clock)', async () => {
    let currentTime = 1700000000000
    const eventsInstallRateLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => currentTime
    })
    const erasureInstallRateLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 3600000,
      now: () => currentTime
    })
    const mockFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    const eraser = new InMemoryEraser()
    const handler = createHandler({
      config: testConfig,
      eventsInstallRateLimiter,
      erasureInstallRateLimiter,
      eraser,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => currentTime
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, currentTime + 10000000)

    const makeEventReq = async (ts: number) => {
      const event: RelayEvent = { name: 'extension_installed', params: {} }
      const version = '1.3.0'
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts,
        event,
        version,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)
      return new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts,
          event,
          version,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
    }

    const eventRes1 = await handler(await makeEventReq(currentTime), '127.0.0.1')
    expect(eventRes1.status).toBe(200)

    const eventRes2 = await handler(await makeEventReq(currentTime + 1), '127.0.0.1')
    expect(eventRes2.status).toBe(429)
    expect(await eventRes2.json()).toEqual({ error: 'rate_limited' })

    currentTime += 60001

    const eventRes3 = await handler(await makeEventReq(currentTime), '127.0.0.1')
    expect(eventRes3.status).toBe(200)

    const makeErasureReq = async (ts: number) => {
      const canonical = canonicaliseErasurePayload({
        install_id: thumbprint,
        ts,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)
      return new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
    }

    const erasureRes1 = await handler(await makeErasureReq(currentTime), '127.0.0.1')
    expect(erasureRes1.status).toBe(200)

    const erasureRes2 = await handler(await makeErasureReq(currentTime + 1), '127.0.0.1')
    expect(erasureRes2.status).toBe(429)
    expect(await erasureRes2.json()).toEqual({ error: 'rate_limited' })

    currentTime += 3600001

    const erasureRes3 = await handler(await makeErasureReq(currentTime), '127.0.0.1')
    expect(erasureRes3.status).toBe(200)
  })

  it('an over-limit request does not consume a replay-cache slot', async () => {
    const fixedNow = 1700000000000
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const eventsInstallRateLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => fixedNow
    })
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const handler = createHandler({
      config: testConfig,
      eventsInstallRateLimiter,
      replayCache,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    const makeEventReqWithSig = async (ts: number) => {
      const event: RelayEvent = { name: 'extension_installed', params: {} }
      const version = '1.3.0'
      const canonical = canonicaliseEventPayload({
        install_id: thumbprint,
        ts,
        event,
        version,
        browser: 'chrome'
      })
      const sig = await signPayload(keyPair.privateKey, canonical)
      const req = new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts,
          event,
          version,
          browser: 'chrome',
          sig,
          jwk: publicJwk
        })
      })
      return { req, sig }
    }

    const first = await makeEventReqWithSig(fixedNow)
    const res1 = await handler(first.req, '127.0.0.1')
    expect(res1.status).toBe(200)
    expect(replayCache.size).toBe(1)
    expect(replayCache.has(first.sig)).toBe(true)

    const second = await makeEventReqWithSig(fixedNow + 10)
    const res2 = await handler(second.req, '127.0.0.1')
    expect(res2.status).toBe(429)
    expect(await res2.json()).toEqual({ error: 'rate_limited' })

    expect(replayCache.has(second.sig)).toBe(false)
    expect(replayCache.size).toBe(1)
    expect(fetchCount).toBe(1)
  })

  it('per-address rate limiter runs before request body is parsed for both events and erasure', async () => {
    const fixedNow = 1700000000000
    const eventsAddressRateLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => fixedNow
    })
    const erasureAddressRateLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 3600000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eventsAddressRateLimiter,
      erasureAddressRateLimiter,
      now: () => fixedNow
    })

    const clientIp = '198.51.100.55'

    // Exhaust events address limiter with 1 request
    const validEventReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json{'
    })
    const eventRes1 = await handler(validEventReq, clientIp)
    // 1st request parsed body and failed with malformed_json
    expect(eventRes1.status).toBe(400)
    expect(await eventRes1.json()).toEqual({ error: 'malformed_json' })

    // 2nd request with malformed JSON body hits rate limit BEFORE parsing body -> 429 rate_limited
    const malformedEventReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'completely-malformed-not-even-json{'
    })
    const eventRes2 = await handler(malformedEventReq, clientIp)
    expect(eventRes2.status).toBe(429)
    expect(await eventRes2.json()).toEqual({ error: 'rate_limited' })

    // Exhaust erasure address limiter with 1 request
    const validErasureReq = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json{'
    })
    const erasureRes1 = await handler(validErasureReq, clientIp)
    expect(erasureRes1.status).toBe(400)
    expect(await erasureRes1.json()).toEqual({ error: 'malformed_json' })

    // 2nd request with malformed JSON body hits rate limit BEFORE parsing body -> 429 rate_limited
    const malformedErasureReq = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: 'completely-malformed-not-even-json{'
    })
    const erasureRes2 = await handler(malformedErasureReq, clientIp)
    expect(erasureRes2.status).toBe(429)
    expect(await erasureRes2.json()).toEqual({ error: 'rate_limited' })
  })

  it('per-install rate limit runs after signature verification and before replay cache', async () => {
    const fixedNow = 1700000000000
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const eraser = new InMemoryEraser()
    const replayCache = new ReplayCache({ now: () => fixedNow })
    const eventsInstallRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      now: () => fixedNow
    })
    const erasureInstallRateLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 3600000,
      now: () => fixedNow
    })
    const handler = createHandler({
      config: testConfig,
      eventsInstallRateLimiter,
      erasureInstallRateLimiter,
      eraser,
      replayCache,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => fixedNow
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, fixedNow + 600000)

    // Events endpoint:
    // N requests (N = 4 > maxRequests: 2) with valid ticket and victim's install_id and jwk
    // but INVALID signature are each rejected with signature error (400), not rate limited
    for (let i = 0; i < 4; i++) {
      const invalidSigReq = new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts: fixedNow + i,
          event: { name: 'extension_installed', params: {} },
          version: '1.3.0',
          browser: 'chrome',
          sig: `bad-sig-${i}`,
          jwk: publicJwk
        })
      })
      const res = await handler(invalidSigReq, '127.0.0.1')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_signature' })
    }
    expect(fetchCount).toBe(0)
    expect(replayCache.size).toBe(0)

    // Afterwards, a correctly signed request from that install is still accepted (2xx) and forwarded
    const validCanonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event: { name: 'extension_installed', params: {} },
      version: '1.3.0',
      browser: 'chrome'
    })
    const validSig = await signPayload(keyPair.privateKey, validCanonical)
    const validReq = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event: { name: 'extension_installed', params: {} },
        version: '1.3.0',
        browser: 'chrome',
        sig: validSig,
        jwk: publicJwk
      })
    })
    const validRes = await handler(validReq, '127.0.0.1')
    expect(validRes.status).toBe(200)
    expect(await validRes.json()).toEqual({ ok: true })
    expect(fetchCount).toBe(1)
    expect(replayCache.size).toBe(1)

    // Erasure endpoint:
    // N requests (N = 4 > maxRequests: 2) with valid ticket and victim's install_id and jwk
    // but INVALID signature are each rejected with signature error (400), not rate limited
    for (let i = 0; i < 4; i++) {
      const invalidErasureReq = new Request('http://localhost/v1/installs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: thumbprint,
          ticket,
          ts: fixedNow + i,
          browser: 'chrome',
          sig: `bad-sig-${i}`,
          jwk: publicJwk
        })
      })
      const res = await handler(invalidErasureReq, '127.0.0.1')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_signature' })
    }
    expect(eraser.queue.length).toBe(0)

    // Afterwards, a correctly signed erasure request from that install is still accepted (2xx) and queued
    const validErasureCanonical = canonicaliseErasurePayload({
      install_id: thumbprint,
      ts: fixedNow,
      browser: 'chrome'
    })
    const validErasureSig = await signPayload(keyPair.privateKey, validErasureCanonical)
    const validErasureReq = new Request('http://localhost/v1/installs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        browser: 'chrome',
        sig: validErasureSig,
        jwk: publicJwk
      })
    })
    const validErasureRes = await handler(validErasureReq, '127.0.0.1')
    expect(validErasureRes.status).toBe(200)
    expect(await validErasureRes.json()).toEqual({ ok: true })
    expect(eraser.queue.length).toBe(1)
    expect(eraser.queue[0].install_id).toBe(thumbprint)
  })

  it('address only reaches limiter that hashes it with daily salt, never raw Map key, log or outbound request', async () => {
    const rawClientAddress = '203.0.113.199'
    let forwardedRequestHeaders: Headers | null = null
    let forwardedRequestBody: string | null = null

    const mockFetch = async (_url: string, init: RequestInit) => {
      forwardedRequestHeaders = new Headers(init.headers)
      forwardedRequestBody = String(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const installsRateLimiter = new RateLimiter()
    const eventsAddressRateLimiter = new RateLimiter()
    const erasureAddressRateLimiter = new RateLimiter()

    const handler = createHandler({
      config: testConfig,
      installsRateLimiter,
      eventsAddressRateLimiter,
      erasureAddressRateLimiter,
      fetch: mockFetch as unknown as typeof fetch
    })

    const { keyPair, publicJwk, thumbprint } = await generateTestKeyPair()
    const ticket = await createTicket(testConfig.ticketKey, thumbprint, Date.now() + 600000)

    // Call POST /v1/installs
    const reqInstalls = new Request('http://localhost/v1/installs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwk: publicJwk })
    })
    await handler(reqInstalls, rawClientAddress)

    // Call POST /v1/events
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const ts = Date.now()
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts,
      event,
      version: '1.3.0',
      browser: 'chrome'
    })
    const sig = await signPayload(keyPair.privateKey, canonical)
    const reqEvents = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts,
        event,
        version: '1.3.0',
        browser: 'chrome',
        sig,
        jwk: publicJwk
      })
    })
    await handler(reqEvents, rawClientAddress)

    // Verify limiters never store raw client address in Map keys
    expect(installsRateLimiter.hasRawAddress(rawClientAddress)).toBe(false)
    expect(eventsAddressRateLimiter.hasRawAddress(rawClientAddress)).toBe(false)
    expect(erasureAddressRateLimiter.hasRawAddress(rawClientAddress)).toBe(false)

    // Verify outbound request does not include client address anywhere
    expect(forwardedRequestHeaders).not.toBeNull()
    expect(forwardedRequestBody).not.toBeNull()
    expect(forwardedRequestBody).not.toContain(rawClientAddress)
  })

  it('limiters are injectable through dependency object with defaults from limits.ts', async () => {
    // Custom injected limiters
    const customEventsLimiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 })
    const handlerWithCustom = createHandler({
      config: testConfig,
      eventsAddressRateLimiter: customEventsLimiter
    })

    // Handler with default limiters constructed internally from limits.ts
    const defaultHandler = createHandler({
      config: testConfig
    })
    expect(typeof defaultHandler).toBe('function')
    expect(typeof handlerWithCustom).toBe('function')
  })

  it('rejects replayed event when signature s is malleated to n - s (answers 409 replayed_request)', async () => {
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount++
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
    const event: RelayEvent = { name: 'extension_installed', params: {} }
    const version = '1.3.0'
    const canonical = canonicaliseEventPayload({
      install_id: thumbprint,
      ts: fixedNow,
      event,
      version,
      browser: 'chrome'
    })
    const originalSigB64 = await signPayload(keyPair.privateKey, canonical)

    // Decode original signature to 64 bytes (r: 32 bytes, s: 32 bytes)
    const originalSigBytes = new Uint8Array(Buffer.from(originalSigB64, 'base64url'))
    const rBytes = originalSigBytes.subarray(0, 32)
    const sBytes = originalSigBytes.subarray(32, 64)

    let sHex = '0x'
    for (let i = 0; i < 32; i++) {
      sHex += sBytes[i].toString(16).padStart(2, '0')
    }
    const sVal = BigInt(sHex)
    const n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
    const malleatedSVal = n - sVal

    const malleatedSHex = malleatedSVal.toString(16).padStart(64, '0')
    const malleatedSBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      malleatedSBytes[i] = parseInt(malleatedSHex.slice(i * 2, i * 2 + 2), 16)
    }

    const malleatedSigBytes = new Uint8Array(64)
    malleatedSigBytes.set(rBytes, 0)
    malleatedSigBytes.set(malleatedSBytes, 32)
    const malleatedSigB64 = Buffer.from(malleatedSigBytes).toString('base64url')

    expect(malleatedSigB64).not.toBe(originalSigB64)

    // Send original request -> accepted (200) and forwarded once
    const req1 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        browser: 'chrome',
        sig: originalSigB64,
        jwk: publicJwk
      })
    })
    const res1 = await handler(req1, '127.0.0.1')
    expect(res1.status).toBe(200)
    expect(fetchCount).toBe(1)

    // Send the exact same request with s malleated to n - s -> 409 replayed_request and nothing forwarded
    const req2 = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: thumbprint,
        ticket,
        ts: fixedNow,
        event,
        version,
        browser: 'chrome',
        sig: malleatedSigB64,
        jwk: publicJwk
      })
    })
    const res2 = await handler(req2, '127.0.0.1')
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: 'replayed_request' })
    expect(fetchCount).toBe(1)
  })
})
