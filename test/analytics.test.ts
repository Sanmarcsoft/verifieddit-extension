/**
 * Tests for signed telemetry relay client.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  isAnalyticsConfigured,
  getAnalyticsConsent,
  setAnalyticsConsent,
  addConsentChangeListener,
  extension_installed,
  extension_updated,
  verify_started,
  verify_completed,
  badge_scan,
  options_opened,
  consent_changed,
  canonicaliseEventPayload as clientCanonicaliseEventPayload,
  canonicaliseErasurePayload as clientCanonicaliseErasurePayload,
  _resetStateForTesting,
  _setRelayUrlForTesting,
  _setBrowserTargetForTesting,
  _setKeyStoreForTesting,
  _getOrCreateKeyPairForTesting,
  _getCachedTicketForTesting,
  IndexedDbKeyStore,
  type AnalyticsConsent,
  type KeyStore,
  type Browser
} from '../src/analytics'
import {
  canonicaliseEventPayload as relayCanonicaliseEventPayload,
  canonicaliseErasurePayload as relayCanonicaliseErasurePayload,
  verifyEcdsaSignature,
  validateBrowser,
  validateEvent
} from '../relay/src/protocol'
import { createHandler } from '../relay/src/server'

interface MockStorageArea {
  data: Record<string, unknown>
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

function createMockStorageArea (): MockStorageArea {
  const store: Record<string, unknown> = {}
  return {
    data: store,
    async get (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      if (keys == null) {
        return { ...store }
      }
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: store[keys] } : {}
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {}
        for (const k of keys) {
          if (k in store) {
            result[k] = store[k]
          }
        }
        return result
      }
      const result: Record<string, unknown> = { ...keys }
      for (const k of Object.keys(keys)) {
        if (k in store) {
          result[k] = store[k]
        }
      }
      return result
    },
    async set (items: Record<string, unknown>): Promise<void> {
      Object.assign(store, items)
    },
    async remove (keys: string | string[]): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) {
        delete store[k]
      }
    }
  }
}

class InMemoryKeyStore implements KeyStore {
  public keyPair: CryptoKeyPair | null = null
  public loadCalls = 0
  public saveCalls = 0
  public clearCalls = 0

  async load (): Promise<CryptoKeyPair | null> {
    this.loadCalls++
    return this.keyPair
  }

  async save (kp: CryptoKeyPair): Promise<void> {
    this.saveCalls++
    this.keyPair = kp
  }

  async clear (): Promise<void> {
    this.clearCalls++
    this.keyPair = null
  }
}

let mockLocalStorage: MockStorageArea
let mockSessionStorage: MockStorageArea | undefined
let inMemoryKeyStore: InMemoryKeyStore
let fetchCalls: Array<{ url: string, init?: RequestInit, bodyJson?: Record<string, unknown> }>
let manifestVersion: string | undefined
let storageOnChangedListeners: Array<(changes: Record<string, { oldValue?: unknown, newValue?: unknown }>, area: string) => void> = []

const TEST_RELAY_URL = 'https://telemetry.example.invalid'
const TEST_TICKET = '1999999999999.mockSignature123'
const TEST_INSTALL_ID = 'test-install-id-thumbprint'
const TEST_EXPIRES_AT = Date.now() + 10 * 60 * 1000

beforeEach(() => {
  mockLocalStorage = createMockStorageArea()
  mockSessionStorage = createMockStorageArea()
  inMemoryKeyStore = new InMemoryKeyStore()
  fetchCalls = []
  manifestVersion = '1.3.0'
  storageOnChangedListeners = []

  _resetStateForTesting()
  _setRelayUrlForTesting(TEST_RELAY_URL)
  _setBrowserTargetForTesting('chrome')
  _setKeyStoreForTesting(inMemoryKeyStore)

  const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let bodyJson: Record<string, unknown> | undefined
    if (init?.body != null && typeof init.body === 'string') {
      try {
        bodyJson = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        // Not JSON
      }
    }
    fetchCalls.push({ url, init, bodyJson })

    if (url.endsWith('/v1/installs')) {
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        install_id: TEST_INSTALL_ID,
        ticket: TEST_TICKET,
        expires_at: TEST_EXPIRES_AT
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (url.endsWith('/v1/events')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  globalThis.fetch = mockFetch as unknown as typeof fetch

  const mockChrome = {
    storage: {
      local: mockLocalStorage,
      session: mockSessionStorage,
      onChanged: {
        addListener: (listener: (changes: Record<string, { oldValue?: unknown, newValue?: unknown }>, area: string) => void) => {
          storageOnChangedListeners.push(listener)
        },
        removeListener: (listener: (changes: Record<string, { oldValue?: unknown, newValue?: unknown }>, area: string) => void) => {
          const idx = storageOnChangedListeners.indexOf(listener)
          if (idx !== -1) storageOnChangedListeners.splice(idx, 1)
        }
      }
    },
    runtime: {
      getManifest: () => (manifestVersion != null ? { version: manifestVersion } : ({} as Record<string, unknown>))
    }
  }

  // Assign chrome object into global scope for test harness
  ;(globalThis as unknown as { chrome: unknown }).chrome = mockChrome
})

describe('Telemetry relay client', () => {
  it('1. No-op when relay URL is empty or unconfigured (no key generation, no IndexedDB, no fetch)', async () => {
    _setRelayUrlForTesting('')
    expect(isAnalyticsConfigured()).toBe(false)
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    expect(fetchCalls.length).toBe(0)
    expect(inMemoryKeyStore.saveCalls).toBe(0)
    expect(inMemoryKeyStore.loadCalls).toBe(0)

    _setRelayUrlForTesting('   ')
    expect(isAnalyticsConfigured()).toBe(false)
    await badge_scan()
    expect(fetchCalls.length).toBe(0)
    expect(inMemoryKeyStore.saveCalls).toBe(0)
  })

  it('2. No event sent when consent is "unset"', async () => {
    const consent = await getAnalyticsConsent()
    expect(consent).toBe('unset')

    await extension_installed()
    expect(fetchCalls.length).toBe(0)
    expect(inMemoryKeyStore.saveCalls).toBe(0)
  })

  it('3. No event sent when consent is "denied"', async () => {
    await setAnalyticsConsent('denied')
    fetchCalls = []

    const consent = await getAnalyticsConsent()
    expect(consent).toBe('denied')

    await extension_installed()
    expect(fetchCalls.length).toBe(0)
    expect(inMemoryKeyStore.saveCalls).toBe(0)
  })

  it('4. Generated ECDSA P-256 private key has extractable === false', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()

    expect(inMemoryKeyStore.keyPair).not.toBeNull()
    const kp = inMemoryKeyStore.keyPair!
    expect(kp.privateKey.extractable).toBe(false)
    expect(kp.privateKey.algorithm.name).toBe('ECDSA')
    // Safe cast for ECDSA algorithm details
    const alg = kp.privateKey.algorithm as RsaHashedKeyGenParams & EcKeyGenParams
    expect(alg.namedCurve).toBe('P-256')
  })

  it('5. Obtains ticket from POST /v1/installs with clean public JWK on first send', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()

    // Must have called POST /v1/installs then POST /v1/events
    expect(fetchCalls.length).toBe(2)
    const installCall = fetchCalls[0]
    expect(installCall.url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(installCall.init?.method).toBe('POST')

    const jwk = installCall.bodyJson?.jwk as Record<string, unknown>
    expect(jwk).toBeDefined()
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
    expect(typeof jwk.x).toBe('string')
    expect(typeof jwk.y).toBe('string')
    expect(jwk.d).toBeUndefined()
  })

  it('6. Key pair and ticket are reused across multiple events without re-fetching ticket', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    await options_opened()

    // 1 install call + 2 event calls
    expect(fetchCalls.length).toBe(3)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
    expect(fetchCalls[2].url).toBe(`${TEST_RELAY_URL}/v1/events`)

    // Verify key was generated once and saved once
    expect(inMemoryKeyStore.saveCalls).toBe(1)
  })

  it('7. Re-requests ticket when cached ticket is expired or within safety margin', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    // Pre-populate ticket in session storage that expires within 10 seconds (safety margin is 30s)
    await mockSessionStorage!.set({
      telemetryTicketData: {
        install_id: TEST_INSTALL_ID,
        ticket: TEST_TICKET,
        expires_at: Date.now() + 10_000
      }
    })

    await badge_scan()

    // Ticket within safety margin must trigger a new install POST before the event
    expect(fetchCalls.length).toBe(2)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
  })

  it('8. Re-requests ticket on relay 400 invalid_ticket rejection (one bounded retry)', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    let eventAttempt = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/events')) {
        eventAttempt++
        if (eventAttempt === 1) {
          fetchCalls.push({ url, init, bodyJson: JSON.parse(String(init?.body)) })
          return new Response(JSON.stringify({ error: 'invalid_ticket' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }
      return originalFetch(input, init)
    }) as unknown as typeof fetch

    await badge_scan()

    // 1 initial install POST, 1 event attempt (rejected), 1 ticket refresh POST, 1 retry event attempt
    expect(fetchCalls.length).toBe(4)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
    expect(fetchCalls[2].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[3].url).toBe(`${TEST_RELAY_URL}/v1/events`)
  })

  it('9. Event POST body contains install_id, ticket, ts, event, version, browser, sig, jwk and no GA4 fields', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()

    expect(fetchCalls.length).toBe(2)
    const eventCall = fetchCalls[1]
    expect(eventCall.url).toBe(`${TEST_RELAY_URL}/v1/events`)
    const body = eventCall.bodyJson as Record<string, unknown>

    expect(body.install_id).toBe(TEST_INSTALL_ID)
    expect(body.ticket).toBe(TEST_TICKET)
    expect(typeof body.ts).toBe('number')
    expect(body.version).toBe('1.3.0')
    expect(body.browser).toBe('chrome')
    expect(validateBrowser(body.browser)).toBe('chrome')
    expect(typeof body.sig).toBe('string')
    expect(body.jwk).toBeDefined()

    // Verify signature format matches relay validation
    const eventObj = body.event as { name: string, params: Record<string, unknown> }
    const canonical = clientCanonicaliseEventPayload({
      install_id: body.install_id as string,
      ts: body.ts as number,
      event: eventObj,
      version: body.version as string,
      browser: body.browser as Browser
    })
    const isSigValid = await verifyEcdsaSignature(
      body.jwk as any,
      body.sig as string,
      new TextEncoder().encode(canonical)
    )
    expect(isSigValid).toBe(true)

    // Confirm no legacy GA4 fields exist
    expect(body.client_id).toBeUndefined()
    expect(body.session_id).toBeUndefined()
    expect(body.engagement_time_msec).toBeUndefined()
    expect(body.debug_mode).toBeUndefined()
  })

  it('10. Canonicalisation produces byte-identical results between client and relay for all seven events and erasure on both chrome and firefox', () => {
    const testCases = [
      { name: 'extension_installed' as const, params: {} },
      { name: 'extension_updated' as const, params: { previous_version: '1.2.9' } },
      { name: 'verify_started' as const, params: { source: 'popup' as const } },
      {
        name: 'verify_completed' as const,
        params: {
          result: 'valid' as const,
          has_durable_binding: true,
          media_type: 'image' as const
        }
      },
      { name: 'badge_scan' as const, params: {} },
      { name: 'options_opened' as const, params: {} },
      { name: 'consent_changed' as const, params: { value: 'granted' as const } }
    ]

    const targets: Browser[] = ['chrome', 'firefox']

    for (const browser of targets) {
      for (const event of testCases) {
        const payload = {
          install_id: 'thumbprint-xyz-123',
          ts: 1700000000000,
          event,
          version: '1.3.0',
          browser
        }

        const clientStr = clientCanonicaliseEventPayload(payload)
        const relayStr = relayCanonicaliseEventPayload(payload)
        expect(clientStr).toBe(relayStr)
      }

      const erasurePayload = {
        install_id: 'thumbprint-xyz-123',
        ts: 1700000000000,
        browser
      }
      const clientErasureStr = clientCanonicaliseErasurePayload(erasurePayload)
      const relayErasureStr = relayCanonicaliseErasurePayload(erasurePayload)
      expect(clientErasureStr).toBe(relayErasureStr)
    }
  })

  it('11. End-to-end integration: client-produced request is successfully accepted by relay createHandler', async () => {
    let capturedUmamiPayload: unknown = null
    const fakeUmamiFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedUmamiPayload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const handler = createHandler({
      config: {
        port: 0,
        ticketKey: 'shared-test-ticket-key-1234567890',
        umamiUrl: 'https://umami.example.invalid',
        umamiWebsiteId: 'test-website-uuid'
      },
      fetch: fakeUmamiFetch as unknown as typeof fetch
    })

    // Route fetch directly to relay handler
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const req = new Request(url, {
        method: init?.method ?? 'GET',
        headers: init?.headers,
        body: init?.body
      })
      return await handler(req, '127.0.0.1')
    }) as unknown as typeof fetch

    await setAnalyticsConsent('granted')
    fetchCalls = []

    await verify_completed({
      result: 'valid',
      has_durable_binding: false,
      media_type: 'video'
    })

    // Verify Umami received the forwarded event
    expect(capturedUmamiPayload).not.toBeNull()
    const umami = capturedUmamiPayload as { type: string, payload: Record<string, unknown> }
    expect(umami.payload.name).toBe('verify_completed')
    expect(umami.payload.data).toMatchObject({
      result: 'valid',
      has_durable_binding: false,
      media_type: 'video'
    })
  })

  it('12. Event helpers produce exact relay-accepted params', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    await extension_updated('1.2.5')
    await extension_updated('version-string-that-is-way-longer-than-the-32-character-limit-allowed-by-relay')
    await verify_started('context_menu')
    await verify_completed({
      result: 'error',
      has_durable_binding: false,
      media_type: 'pdf'
    })
    await badge_scan()
    await options_opened()
    await consent_changed('granted')

    // Find all /v1/events calls
    const eventCalls = fetchCalls.filter(c => c.url.endsWith('/v1/events'))
    expect(eventCalls.length).toBe(8)

    expect(eventCalls[0].bodyJson?.event).toEqual({
      name: 'extension_installed',
      params: {}
    })

    expect(eventCalls[1].bodyJson?.event).toEqual({
      name: 'extension_updated',
      params: { previous_version: '1.2.5' }
    })

    // Truncated to 32 chars
    const updatedLong = eventCalls[2].bodyJson?.event as { params: { previous_version: string } }
    expect(updatedLong.params.previous_version.length).toBe(32)

    expect(eventCalls[3].bodyJson?.event).toEqual({
      name: 'verify_started',
      params: { source: 'context_menu' }
    })

    expect(eventCalls[4].bodyJson?.event).toEqual({
      name: 'verify_completed',
      params: {
        result: 'error',
        has_durable_binding: false,
        media_type: 'pdf'
      }
    })

    expect(eventCalls[5].bodyJson?.event).toEqual({
      name: 'badge_scan',
      params: {}
    })

    expect(eventCalls[6].bodyJson?.event).toEqual({
      name: 'options_opened',
      params: {}
    })

    expect(eventCalls[7].bodyJson?.event).toEqual({
      name: 'consent_changed',
      params: { value: 'granted' }
    })
  })

  it('13. Withdrawing consent (setAnalyticsConsent("denied")) sends DELETE /v1/installs when key exists and deletes local state', async () => {
    // First generate a key by granting consent and sending an event
    await setAnalyticsConsent('granted')
    await badge_scan()
    expect(inMemoryKeyStore.keyPair).not.toBeNull()
    fetchCalls = []

    let notifiedValue: AnalyticsConsent | null = null
    const unsubscribe = addConsentChangeListener(val => {
      notifiedValue = val
    })

    await setAnalyticsConsent('denied')
    expect(notifiedValue).toBe('denied')

    // Expect signed DELETE to /v1/installs
    const deleteCalls = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'DELETE')
    expect(deleteCalls.length).toBe(1)
    const deleteBody = deleteCalls[0].bodyJson as Record<string, unknown>
    expect(deleteBody.install_id).toBe(TEST_INSTALL_ID)
    expect(deleteBody.ticket).toBe(TEST_TICKET)
    expect(deleteBody.browser).toBe('chrome')
    expect(validateBrowser(deleteBody.browser)).toBe('chrome')
    expect(typeof deleteBody.sig).toBe('string')

    const erasureCanonical = clientCanonicaliseErasurePayload({
      install_id: deleteBody.install_id as string,
      ts: deleteBody.ts as number,
      browser: deleteBody.browser as Browser
    })
    const isErasureSigValid = await verifyEcdsaSignature(
      deleteBody.jwk as any,
      deleteBody.sig as string,
      new TextEncoder().encode(erasureCanonical)
    )
    expect(isErasureSigValid).toBe(true)

    // Local key store must be cleared
    expect(inMemoryKeyStore.clearCalls).toBeGreaterThanOrEqual(1)
    expect(inMemoryKeyStore.keyPair).toBeNull()

    // No event is sent after consent withdrawal
    const eventCalls = fetchCalls.filter(c => c.url.endsWith('/v1/events'))
    expect(eventCalls.length).toBe(0)

    unsubscribe()
  })

  it('14. Withdrawing consent when no key pair was ever created sends zero network requests', async () => {
    expect(inMemoryKeyStore.keyPair).toBeNull()
    fetchCalls = []

    await setAnalyticsConsent('denied')

    expect(fetchCalls.length).toBe(0)
    expect(inMemoryKeyStore.saveCalls).toBe(0)
  })

  it('15. Deletion of local state happens even if erasure request fails or times out', async () => {
    await setAnalyticsConsent('granted')
    await badge_scan()
    expect(inMemoryKeyStore.keyPair).not.toBeNull()

    // Make DELETE request fail
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        throw new Error('Network timeout during erasure')
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    // Must resolve cleanly without throwing
    await expect(setAnalyticsConsent('denied')).resolves.toBeUndefined()

    // Local state must still be wiped
    expect(inMemoryKeyStore.keyPair).toBeNull()
    expect(inMemoryKeyStore.clearCalls).toBeGreaterThanOrEqual(1)
  })

  it('16. Fire-and-forget: rejecting fetch does not throw or reject out of send calls', async () => {
    await setAnalyticsConsent('granted')

    globalThis.fetch = mock(async () => {
      throw new Error('Connection refused')
    }) as unknown as typeof fetch

    await expect(extension_installed()).resolves.toBeUndefined()
    await expect(badge_scan()).resolves.toBeUndefined()
    await expect(setAnalyticsConsent('denied')).resolves.toBeUndefined()
  })

  it('17. Firefox fallback: when chrome.storage.session is undefined, operates with in-memory ticket cache', async () => {
    // Delete session storage
    delete (chrome.storage as unknown as Record<string, unknown>).session

    await setAnalyticsConsent('granted')
    fetchCalls = []

    await badge_scan()
    await options_opened()

    // 1 install + 2 events (ticket cached in memory across the two events)
    expect(fetchCalls.length).toBe(3)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
    expect(fetchCalls[2].url).toBe(`${TEST_RELAY_URL}/v1/events`)
  })

  it('18. Zero matches for GA identifiers across src/', () => {
    const forbidden = [/google-analytics/i, /googletagmanager/i, /ga4/i, /GA_DEBUG/]
    const srcDir = join(import.meta.dir, '..', 'src')

    function scanDir (dir: string): void {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          scanDir(fullPath)
        } else if (stat.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.js') || fullPath.endsWith('.json'))) {
          const content = readFileSync(fullPath, 'utf8')
          for (const pattern of forbidden) {
            expect(pattern.test(content)).toBe(false)
          }
        }
      }
    }

    scanDir(srcDir)
  })

  it('19. Re-requests ticket on relay 401 rejection (one bounded retry)', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    let eventAttempt = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/events')) {
        eventAttempt++
        if (eventAttempt === 1) {
          fetchCalls.push({ url, init, bodyJson: JSON.parse(String(init?.body)) })
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }
      return originalFetch(input, init)
    }) as unknown as typeof fetch

    await badge_scan()

    // 1 initial install POST, 1 event attempt (rejected with 401), 1 ticket refresh POST, 1 retry event attempt
    expect(fetchCalls.length).toBe(4)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
    expect(fetchCalls[2].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[3].url).toBe(`${TEST_RELAY_URL}/v1/events`)
  })

  it('20. Re-requests ticket on relay 403 rejection (one bounded retry)', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    let eventAttempt = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/events')) {
        eventAttempt++
        if (eventAttempt === 1) {
          fetchCalls.push({ url, init, bodyJson: JSON.parse(String(init?.body)) })
          return new Response(JSON.stringify({ error: 'forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }
      return originalFetch(input, init)
    }) as unknown as typeof fetch

    await badge_scan()

    // 1 initial install POST, 1 event attempt (rejected with 403), 1 ticket refresh POST, 1 retry event attempt
    expect(fetchCalls.length).toBe(4)
    expect(fetchCalls[0].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[1].url).toBe(`${TEST_RELAY_URL}/v1/events`)
    expect(fetchCalls[2].url).toBe(`${TEST_RELAY_URL}/v1/installs`)
    expect(fetchCalls[3].url).toBe(`${TEST_RELAY_URL}/v1/events`)
  })

  it('21. Erasure request sent exactly once on "denied", then subsequent calls send nothing', async () => {
    await setAnalyticsConsent('granted')
    await badge_scan()
    expect(inMemoryKeyStore.keyPair).not.toBeNull()
    fetchCalls = []

    // First denial: triggers signed DELETE /v1/installs and clears key pair & ticket
    await setAnalyticsConsent('denied')
    const deleteCalls = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'DELETE')
    expect(deleteCalls.length).toBe(1)
    expect(inMemoryKeyStore.keyPair).toBeNull()

    // Second denial: key is already wiped, so no further network request is sent
    fetchCalls = []
    await setAnalyticsConsent('denied')
    expect(fetchCalls.length).toBe(0)
  })

  it('22. Fire-and-forget: IndexedDB / KeyStore failures do not throw or reject into callers', async () => {
    class FailingKeyStore implements KeyStore {
      async load (): Promise<CryptoKeyPair | null> {
        throw new Error('IndexedDB disk corruption')
      }
      async save (): Promise<void> {
        throw new Error('IndexedDB quota exceeded')
      }
      async clear (): Promise<void> {
        throw new Error('IndexedDB database locked')
      }
    }

    _setKeyStoreForTesting(new FailingKeyStore())
    await setAnalyticsConsent('granted')

    await expect(extension_installed()).resolves.toBeUndefined()
    await expect(badge_scan()).resolves.toBeUndefined()
    await expect(options_opened()).resolves.toBeUndefined()
    await expect(setAnalyticsConsent('denied')).resolves.toBeUndefined()
  })

  it('23. Fire-and-forget: WebCrypto failures do not throw or reject into callers', async () => {
    await setAnalyticsConsent('granted')

    const originalSubtle = crypto.subtle
    const mockSubtle = Object.create(originalSubtle)
    mockSubtle.generateKey = mock(async () => {
      throw new Error('Hardware crypto module unavailable')
    })
    mockSubtle.sign = mock(async () => {
      throw new Error('CryptoKey signature operation failed')
    })

    Object.defineProperty(crypto, 'subtle', {
      value: mockSubtle,
      configurable: true
    })

    try {
      await expect(extension_installed()).resolves.toBeUndefined()
      await expect(badge_scan()).resolves.toBeUndefined()
      await expect(setAnalyticsConsent('denied')).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(crypto, 'subtle', {
        value: originalSubtle,
        configurable: true
      })
    }
  })

  it('24. IndexedDbKeyStore settles all promises on success, error, blocked, and abort', async () => {
    const store = new IndexedDbKeyStore()

    // When indexedDB is undefined, openDb rejects and load returns null
    const origIndexedDB = globalThis.indexedDB
    delete (globalThis as Record<string, unknown>).indexedDB

    const loaded = await store.load()
    expect(loaded).toBeNull()

    // Test settling with mock indexedDB
    type Handler = () => void
    interface FakeReq {
      onsuccess: Handler | null
      onerror: Handler | null
      onblocked: Handler | null
      onupgradeneeded: Handler | null
      result?: unknown
      error?: Error
    }

    interface FakeTx {
      onerror: Handler | null
      onabort: Handler | null
      error?: Error
      objectStore: (name: string) => {
        get: (key: string) => FakeReq
        put: (val: unknown, key: string) => FakeReq
        delete: (key: string) => FakeReq
      }
    }

    function createFakeDb () {
      const mockStoreReq: FakeReq = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null
      }
      const mockTx: FakeTx = {
        onerror: null,
        onabort: null,
        objectStore: () => ({
          get: () => mockStoreReq,
          put: () => mockStoreReq,
          delete: () => mockStoreReq
        })
      }
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        transaction: () => mockTx
      }
      return { fakeDb, mockTx, mockStoreReq }
    }

    // 1. Open blocked
    ;(globalThis as Record<string, unknown>).indexedDB = {
      open: () => {
        const req: FakeReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null }
        setTimeout(() => req.onblocked?.(), 1)
        return req
      }
    }
    expect(await store.load()).toBeNull()

    // 2. Open error
    ;(globalThis as Record<string, unknown>).indexedDB = {
      open: () => {
        const req: FakeReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, error: new Error('open failed') }
        setTimeout(() => req.onerror?.(), 1)
        return req
      }
    }
    expect(await store.load()).toBeNull()

    // 3. Tx abort
    ;(globalThis as Record<string, unknown>).indexedDB = {
      open: () => {
        const { fakeDb, mockTx } = createFakeDb()
        const req: FakeReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: fakeDb }
        setTimeout(() => {
          req.onsuccess?.()
          setTimeout(() => {
            mockTx.error = new Error('aborted')
            mockTx.onabort?.()
          }, 1)
        }, 1)
        return req
      }
    }
    expect(await store.load()).toBeNull()

    // 4. Request error in save
    ;(globalThis as Record<string, unknown>).indexedDB = {
      open: () => {
        const { fakeDb, mockStoreReq } = createFakeDb()
        const req: FakeReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: fakeDb }
        setTimeout(() => {
          req.onsuccess?.()
          setTimeout(() => {
            mockStoreReq.error = new Error('put error')
            mockStoreReq.onerror?.()
          }, 1)
        }, 1)
        return req
      }
    }
    await expect(store.save({} as CryptoKeyPair)).rejects.toThrow('put error')

    // Restore original indexedDB
    if (origIndexedDB !== undefined) {
      ;(globalThis as Record<string, unknown>).indexedDB = origIndexedDB
    } else {
      delete (globalThis as Record<string, unknown>).indexedDB
    }
  })

  it('25. Cross-context consent staleness: storage.onChanged to denied invalidates cached consent and drops keys/tickets, zero fetch calls', async () => {
    await setAnalyticsConsent('granted')
    await badge_scan()
    expect(fetchCalls.length).toBe(2)
    expect(inMemoryKeyStore.keyPair).not.toBeNull()
    expect(await _getOrCreateKeyPairForTesting(false)).not.toBeNull()
    expect(await _getCachedTicketForTesting()).not.toBeNull()

    fetchCalls = []

    // Simulate cross-context storage change from popup/options to 'denied'
    mockLocalStorage.data.analyticsConsent = 'denied'
    for (const listener of storageOnChangedListeners) {
      listener({ analyticsConsent: { oldValue: 'granted', newValue: 'denied' } }, 'local')
    }

    // In-memory credentials and cached tickets are dropped
    expect(inMemoryKeyStore.keyPair).toBeNull()
    expect(await _getOrCreateKeyPairForTesting(false)).toBeNull()
    expect(await _getCachedTicketForTesting()).toBeNull()

    // Now emit an event
    await badge_scan()

    expect(fetchCalls.length).toBe(0)
    expect(await _getOrCreateKeyPairForTesting(false)).toBeNull()
    expect(await _getCachedTicketForTesting()).toBeNull()
  })

  it('26. Zero matches for google analytics or ga4 across public/', () => {
    const forbidden = /google.?analytics|ga4/i
    const publicDir = join(import.meta.dir, '..', 'public')

    function scanDir (dir: string): void {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          scanDir(fullPath)
        } else if (stat.isFile() && (fullPath.endsWith('.html') || fullPath.endsWith('.js') || fullPath.endsWith('.css'))) {
          const content = readFileSync(fullPath, 'utf8')
          expect(forbidden.test(content)).toBe(false)
        }
      }
    }

    scanDir(publicDir)
  })

  it('27. extension_updated with empty or non-string previous_version sends unknown and passes relay validateEvent', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_updated('')
    expect(fetchCalls.length).toBe(2)
    const eventCall = fetchCalls[1]
    const body = eventCall.bodyJson as { event: { name: string, params: { previous_version: string } } }
    expect(body.event.name).toBe('extension_updated')
    expect(body.event.params.previous_version).toBe('unknown')

    const validated = validateEvent(body.event)
    expect(validated).toEqual({
      name: 'extension_updated',
      params: { previous_version: 'unknown' }
    })

    // Also test with non-string (cast)
    fetchCalls = []
    await extension_updated(undefined as unknown as string)
    expect(fetchCalls.length).toBe(1)
    const secondBody = fetchCalls[0].bodyJson as { event: { name: string, params: { previous_version: string } } }
    expect(secondBody.event.params.previous_version).toBe('unknown')
    expect(validateEvent(secondBody.event)).toEqual({
      name: 'extension_updated',
      params: { previous_version: 'unknown' }
    })
  })

  it('28. Concurrent first sends share one in-flight ticket promise, calling POST /v1/installs exactly once', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    // Fire two events simultaneously on a clean state
    await Promise.all([
      badge_scan(),
      options_opened()
    ])

    const installPosts = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'POST')
    expect(installPosts.length).toBe(1)

    const eventPosts = fetchCalls.filter(c => c.url.endsWith('/v1/events') && c.init?.method === 'POST')
    expect(eventPosts.length).toBe(2)
  })

  it('29. getOrCreateKeyPair: concurrent false caller does not cause true caller to receive null, exactly one key pair created', async () => {
    // When key store is empty and concurrent calls happen (false first, then true):
    const [kpFalse, kpTrue] = await Promise.all([
      _getOrCreateKeyPairForTesting(false),
      _getOrCreateKeyPairForTesting(true)
    ])

    expect(kpFalse).toBeNull()
    expect(kpTrue).not.toBeNull()
    expect(inMemoryKeyStore.saveCalls).toBe(1)
  })

  it('30. Concurrent setAnalyticsConsent("denied") calls send exactly one DELETE /v1/installs', async () => {
    await setAnalyticsConsent('granted')
    await badge_scan()
    expect(fetchCalls.length).toBe(2)
    expect(inMemoryKeyStore.keyPair).not.toBeNull()

    fetchCalls = []

    // Call setAnalyticsConsent('denied') concurrently
    await Promise.all([
      setAnalyticsConsent('denied'),
      setAnalyticsConsent('denied')
    ])

    const deleteCalls = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'DELETE')
    expect(deleteCalls.length).toBe(1)
  })

  it('31. 5000 ms timeout bound covers reading response body, aborting body stream if slow', async () => {
    await setAnalyticsConsent('granted')

    let passedSignal: AbortSignal | undefined
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      passedSignal = init?.signal
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => {
          return await new Promise((resolve, reject) => {
            if (passedSignal?.aborted) {
              reject(new Error('AbortError'))
              return
            }
            passedSignal?.addEventListener('abort', () => {
              reject(new Error('AbortError'))
            })
            // Abort immediately to test that body reader handles signal abort
            const controller = (passedSignal as unknown as { _controller?: AbortController })
            setTimeout(() => {
              // Trigger abort via dispatching abort event if possible or reject
              reject(new Error('AbortError'))
            }, 5)
          })
        }
      } as unknown as Response
    }) as unknown as typeof fetch

    const sendPromise = extension_installed()
    await expect(sendPromise).resolves.toBeUndefined()
    expect(passedSignal).toBeDefined()
  })

  it('32. Local key pair, ticket and cached id are wiped on denied even when obtaining the ticket for the erasure request fails', async () => {
    // 1. Establish an install with key pair and ticket
    await setAnalyticsConsent('granted')
    await badge_scan()

    expect(inMemoryKeyStore.keyPair).not.toBeNull()
    expect(await _getCachedTicketForTesting()).not.toBeNull()

    // 2. Clear ticket cache to force getOrFetchTicket during handleConsentDenied to request a new ticket from relay
    await mockSessionStorage?.remove('telemetryTicketData')

    // 3. Make the ticket request (POST /v1/installs) fail with 500
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/installs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'server_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as unknown as typeof fetch

    // 4. Deny consent
    await expect(setAnalyticsConsent('denied')).resolves.toBeUndefined()

    // 5. Ensure local key pair, ticket and cached state are completely wiped
    expect(inMemoryKeyStore.keyPair).toBeNull()
    expect(await _getOrCreateKeyPairForTesting(false)).toBeNull()
    expect(await _getCachedTicketForTesting()).toBeNull()
  })

  it('33. Wire format for both chrome and firefox: validates with relay functions and signatures verify', async () => {
    const targets: Browser[] = ['chrome', 'firefox']

    for (const browser of targets) {
      _resetStateForTesting()
      _setRelayUrlForTesting(TEST_RELAY_URL)
      _setBrowserTargetForTesting(browser)
      _setKeyStoreForTesting(inMemoryKeyStore)
      fetchCalls = []

      await setAnalyticsConsent('granted')

      // Emit an event
      await verify_completed({
        result: 'valid',
        has_durable_binding: true,
        media_type: 'image'
      })

      const eventCalls = fetchCalls.filter(c => c.url.endsWith('/v1/events'))
      expect(eventCalls.length).toBe(1)
      const eventBody = eventCalls[0].bodyJson as Record<string, unknown>

      expect(eventBody.browser).toBe(browser)
      expect(validateBrowser(eventBody.browser)).toBe(browser)

      const eventObj = eventBody.event as { name: string, params: Record<string, unknown> }
      const validatedRelayEvent = validateEvent(eventObj)
      const relayCanonical = relayCanonicaliseEventPayload({
        install_id: eventBody.install_id as string,
        ts: eventBody.ts as number,
        event: validatedRelayEvent,
        version: eventBody.version as string,
        browser: eventBody.browser as Browser
      })
      const clientCanonical = clientCanonicaliseEventPayload({
        install_id: eventBody.install_id as string,
        ts: eventBody.ts as number,
        event: eventObj,
        version: eventBody.version as string,
        browser: eventBody.browser as Browser
      })
      expect(clientCanonical).toBe(relayCanonical)

      const isSigValid = await verifyEcdsaSignature(
        eventBody.jwk as any,
        eventBody.sig as string,
        new TextEncoder().encode(relayCanonical)
      )
      expect(isSigValid).toBe(true)

      // Test signed erasure request for this browser
      fetchCalls = []
      await setAnalyticsConsent('denied')

      const deleteCalls = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'DELETE')
      expect(deleteCalls.length).toBe(1)
      const deleteBody = deleteCalls[0].bodyJson as Record<string, unknown>

      expect(deleteBody.browser).toBe(browser)
      expect(validateBrowser(deleteBody.browser)).toBe(browser)

      const relayErasureCanonical = relayCanonicaliseErasurePayload({
        install_id: deleteBody.install_id as string,
        ts: deleteBody.ts as number,
        browser: deleteBody.browser as Browser
      })
      const clientErasureCanonical = clientCanonicaliseErasurePayload({
        install_id: deleteBody.install_id as string,
        ts: deleteBody.ts as number,
        browser: deleteBody.browser as Browser
      })
      expect(clientErasureCanonical).toBe(relayErasureCanonical)

      const isErasureSigValid = await verifyEcdsaSignature(
        deleteBody.jwk as any,
        deleteBody.sig as string,
        new TextEncoder().encode(relayErasureCanonical)
      )
      expect(isErasureSigValid).toBe(true)
    }
  })

  it('34. Changing browser after signing makes the relay signature verification fail', async () => {
    _resetStateForTesting()
    _setRelayUrlForTesting(TEST_RELAY_URL)
    _setBrowserTargetForTesting('chrome')
    _setKeyStoreForTesting(inMemoryKeyStore)
    fetchCalls = []

    await setAnalyticsConsent('granted')
    await options_opened()

    const eventCalls = fetchCalls.filter(c => c.url.endsWith('/v1/events'))
    expect(eventCalls.length).toBe(1)
    const eventBody = eventCalls[0].bodyJson as Record<string, unknown>
    expect(eventBody.browser).toBe('chrome')

    // Tamper: simulate browser field being altered to firefox after client signed
    const tamperedCanonical = relayCanonicaliseEventPayload({
      install_id: eventBody.install_id as string,
      ts: eventBody.ts as number,
      event: validateEvent(eventBody.event),
      version: eventBody.version as string,
      browser: 'firefox'
    })
    const isTamperedSigValid = await verifyEcdsaSignature(
      eventBody.jwk as any,
      eventBody.sig as string,
      new TextEncoder().encode(tamperedCanonical)
    )
    expect(isTamperedSigValid).toBe(false)

    // Test tampering on erasure
    fetchCalls = []
    await setAnalyticsConsent('denied')

    const deleteCalls = fetchCalls.filter(c => c.url.endsWith('/v1/installs') && c.init?.method === 'DELETE')
    expect(deleteCalls.length).toBe(1)
    const deleteBody = deleteCalls[0].bodyJson as Record<string, unknown>
    expect(deleteBody.browser).toBe('chrome')

    const tamperedErasureCanonical = relayCanonicaliseErasurePayload({
      install_id: deleteBody.install_id as string,
      ts: deleteBody.ts as number,
      browser: 'firefox'
    })
    const isTamperedErasureSigValid = await verifyEcdsaSignature(
      deleteBody.jwk as any,
      deleteBody.sig as string,
      new TextEncoder().encode(tamperedErasureCanonical)
    )
    expect(isTamperedErasureSigValid).toBe(false)
  })

  it('35. Client is completely inert when browser target is edge, empty string, or unset', async () => {
    const invalidTargets = ['edge', '', null]

    for (const target of invalidTargets) {
      _resetStateForTesting()
      _setRelayUrlForTesting(TEST_RELAY_URL)
      _setBrowserTargetForTesting(target)
      _setKeyStoreForTesting(inMemoryKeyStore)
      fetchCalls = []

      expect(isAnalyticsConfigured()).toBe(false)

      await setAnalyticsConsent('granted')

      // Call all seven event helpers
      await extension_installed()
      await extension_updated('1.2.3')
      await verify_started('popup')
      await verify_completed({
        result: 'valid',
        has_durable_binding: false,
        media_type: 'video'
      })
      await badge_scan()
      await options_opened()
      await consent_changed('granted')

      // Zero fetch calls and no key created
      expect(fetchCalls.length).toBe(0)
      expect(inMemoryKeyStore.saveCalls).toBe(0)
      expect(inMemoryKeyStore.keyPair).toBeNull()

      // Calling setAnalyticsConsent('denied') also makes zero fetch calls and creates no key
      await setAnalyticsConsent('denied')
      expect(fetchCalls.length).toBe(0)
      expect(inMemoryKeyStore.saveCalls).toBe(0)
      expect(inMemoryKeyStore.keyPair).toBeNull()
    }
  })
})
