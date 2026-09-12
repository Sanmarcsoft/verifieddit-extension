/**
 * Tests for GA4 Measurement Protocol client.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
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
  _resetStateForTesting,
  _setCredentialsForTesting,
  _getInMemorySessionForTesting,
  _setInMemorySessionForTesting,
  type AnalyticsConsent
} from '../src/analytics'

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

let mockLocalStorage: MockStorageArea
let mockSessionStorage: MockStorageArea | undefined
let fetchCalls: Array<{ url: string, init?: RequestInit, bodyJson?: Record<string, unknown> }>
let manifestVersion: string | undefined

beforeEach(() => {
  mockLocalStorage = createMockStorageArea()
  mockSessionStorage = createMockStorageArea()
  fetchCalls = []
  manifestVersion = '1.2.6'

  _resetStateForTesting()
  _setCredentialsForTesting({
    measurementId: 'G-TEST12345',
    apiSecret: 'secret_test_xyz',
    debug: false
  })

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
    return new Response(JSON.stringify({ validationMessages: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  globalThis.fetch = mockFetch as unknown as typeof fetch

  const mockChrome = {
    storage: {
      local: mockLocalStorage,
      session: mockSessionStorage
    },
    runtime: {
      getManifest: () => (manifestVersion != null ? { version: manifestVersion } : ({} as any))
    }
  }

  ;(globalThis as any).chrome = mockChrome
})

describe('GA4 analytics client', () => {
  it('1. No-op when measurement id or api secret is empty (fetch never called)', async () => {
    _setCredentialsForTesting({ measurementId: '', apiSecret: 'secret' })
    expect(isAnalyticsConfigured()).toBe(false)
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    expect(fetchCalls.length).toBe(0)

    _setCredentialsForTesting({ measurementId: 'G-123', apiSecret: '' })
    expect(isAnalyticsConfigured()).toBe(false)
    await extension_installed()
    expect(fetchCalls.length).toBe(0)
  })

  it('2. No event sent when consent is "unset"', async () => {
    // Default consent is 'unset'
    const consent = await getAnalyticsConsent()
    expect(consent).toBe('unset')

    await extension_installed()
    expect(fetchCalls.length).toBe(0)
  })

  it('3. No event sent when consent is "denied"', async () => {
    await setAnalyticsConsent('denied')
    fetchCalls = []

    const consent = await getAnalyticsConsent()
    expect(consent).toBe('denied')

    await extension_installed()
    expect(fetchCalls.length).toBe(0)
  })

  it('4. Event IS sent when consent is "granted", and POST body matches schema', async () => {
    await setAnalyticsConsent('granted')
    await mockSessionStorage!.remove('ga4SessionData')
    fetchCalls = []

    await extension_installed()

    expect(fetchCalls.length).toBe(1)
    const call = fetchCalls[0]
    expect(call.url).toContain('https://www.google-analytics.com/mp/collect?')
    expect(call.url).toContain('measurement_id=G-TEST12345')
    expect(call.url).toContain('api_secret=secret_test_xyz')

    const body = call.bodyJson as any
    expect(typeof body.client_id).toBe('string')
    expect(body.client_id.length).toBeGreaterThan(0)
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBe(1)

    const evt = body.events[0]
    expect(evt.name).toBe('extension_installed')
    expect(typeof evt.params.engagement_time_msec).toBe('string')
    expect(evt.params.engagement_time_msec).toBe('100')
    expect(typeof evt.params.session_id).toBe('string')
    expect(evt.params.session_id.length).toBeGreaterThan(0)
    expect(evt.params.extension_version).toBe('1.2.6')
  })

  it('5. client_id is generated once and reused across two events (same value, one storage write)', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    await options_opened()

    expect(fetchCalls.length).toBe(2)
    const clientId1 = (fetchCalls[0].bodyJson as any).client_id
    const clientId2 = (fetchCalls[1].bodyJson as any).client_id
    expect(clientId1).toBe(clientId2)

    // Storage check: ga4ClientId is stored in local storage
    const stored = await mockLocalStorage.get('ga4ClientId')
    expect(stored.ga4ClientId).toBe(clientId1)

    // Clear module memory cache and read back to check persistence reuse
    _resetStateForTesting()
    _setCredentialsForTesting({
      measurementId: 'G-TEST12345',
      apiSecret: 'secret_test_xyz',
      debug: false
    })
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await badge_scan()
    expect(fetchCalls.length).toBe(1)
    const clientId3 = (fetchCalls[0].bodyJson as any).client_id
    expect(clientId3).toBe(clientId1)
  })

  it('6. A new session id is created when the stored session is older than 30 minutes', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    const oldSessionId = '1000000'
    const fortyMinutesAgo = Date.now() - 40 * 60 * 1000
    await mockSessionStorage!.set({
      ga4SessionData: {
        sessionId: oldSessionId,
        sessionLastUpdated: fortyMinutesAgo
      }
    })

    await badge_scan()

    expect(fetchCalls.length).toBe(1)
    const newSessionId = (fetchCalls[0].bodyJson as any).events[0].params.session_id
    expect(newSessionId).not.toBe(oldSessionId)

    const storedSession = (await mockSessionStorage!.get('ga4SessionData')).ga4SessionData as any
    expect(storedSession.sessionId).toBe(newSessionId)
    expect(storedSession.sessionLastUpdated).toBeGreaterThan(fortyMinutesAgo)
  })

  it('7. The same session id is reused inside the 30-minute window, and sessionLastUpdated is refreshed', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    const existingSessionId = '2000000'
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    await mockSessionStorage!.set({
      ga4SessionData: {
        sessionId: existingSessionId,
        sessionLastUpdated: tenMinutesAgo
      }
    })

    await badge_scan()

    expect(fetchCalls.length).toBe(1)
    const sessionId = (fetchCalls[0].bodyJson as any).events[0].params.session_id
    expect(sessionId).toBe(existingSessionId)

    const storedSession = (await mockSessionStorage!.get('ga4SessionData')).ga4SessionData as any
    expect(storedSession.sessionId).toBe(existingSessionId)
    expect(storedSession.sessionLastUpdated).toBeGreaterThan(tenMinutesAgo)
  })

  it('8. Firefox fallback: when chrome.storage.session is undefined, events still send and in-memory session honours 30-minute expiry', async () => {
    // Remove storage.session to simulate Firefox environment
    delete (chrome.storage as any).session
    await setAnalyticsConsent('granted')
    _setInMemorySessionForTesting(null)
    fetchCalls = []

    // First event in session: uses default engagement time
    await badge_scan()
    expect(fetchCalls.length).toBe(1)
    const session1 = (fetchCalls[0].bodyJson as any).events[0].params.session_id
    expect(typeof session1).toBe('string')
    expect((fetchCalls[0].bodyJson as any).events[0].params.engagement_time_msec).toBe('100')

    // Second event immediately after: reuses same session
    await options_opened()
    expect(fetchCalls.length).toBe(2)
    const session2 = (fetchCalls[1].bodyJson as any).events[0].params.session_id
    expect(session2).toBe(session1)

    // Age the in-memory session by 31 minutes
    const memSession = _getInMemorySessionForTesting()
    expect(memSession).toBeDefined()
    if (memSession != null) {
      _setInMemorySessionForTesting({
        sessionId: 'old_session_123',
        sessionLastUpdated: Date.now() - 31 * 60 * 1000
      })
    }

    // Next event should start a new session
    await extension_installed()
    expect(fetchCalls.length).toBe(3)
    const session3 = (fetchCalls[2].bodyJson as any).events[0].params.session_id
    expect(session3).not.toBe('old_session_123')
  })

  it('9. A rejecting fetch does not throw and does not reject out of the send call', async () => {
    await setAnalyticsConsent('granted')

    globalThis.fetch = mock(async () => {
      throw new Error('Network offline or connection failed')
    }) as unknown as typeof fetch

    // Must resolve cleanly without throwing
    await expect(extension_installed()).resolves.toBeUndefined()
    await expect(badge_scan()).resolves.toBeUndefined()
  })

  it('10. Malformed stored values (wrong type) are treated as absent rather than crashing', async () => {
    // Corrupt client_id in storage (number instead of string)
    await mockLocalStorage.set({ ga4ClientId: 12345 })
    // Corrupt session data in storage (string instead of object)
    await mockSessionStorage!.set({ ga4SessionData: 'not an object' })
    // Corrupt consent in storage (boolean instead of 'granted' | 'denied' | 'unset')
    await mockLocalStorage.set({ analyticsConsent: true })

    const consent = await getAnalyticsConsent()
    expect(consent).toBe('unset')

    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    expect(fetchCalls.length).toBe(1)

    const body = fetchCalls[0].bodyJson as any
    expect(typeof body.client_id).toBe('string')
    expect(body.client_id).not.toBe('12345')
    expect(typeof body.events[0].params.session_id).toBe('string')
  })

  it('11. Each event helper produces the correct event name and params, including extension_version', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await extension_installed()
    expect(fetchCalls[0].bodyJson).toMatchObject({
      events: [{
        name: 'extension_installed',
        params: { extension_version: '1.2.6' }
      }]
    })

    await extension_updated('1.2.5')
    expect(fetchCalls[1].bodyJson).toMatchObject({
      events: [{
        name: 'extension_updated',
        params: { previous_version: '1.2.5', extension_version: '1.2.6' }
      }]
    })

    await verify_started('context_menu')
    expect(fetchCalls[2].bodyJson).toMatchObject({
      events: [{
        name: 'verify_started',
        params: { source: 'context_menu', extension_version: '1.2.6' }
      }]
    })

    await verify_completed({
      result: 'valid',
      has_durable_binding: true,
      media_type: 'image'
    })
    expect(fetchCalls[3].bodyJson).toMatchObject({
      events: [{
        name: 'verify_completed',
        params: {
          result: 'valid',
          has_durable_binding: true,
          media_type: 'image',
          extension_version: '1.2.6'
        }
      }]
    })

    await badge_scan()
    expect(fetchCalls[4].bodyJson).toMatchObject({
      events: [{
        name: 'badge_scan',
        params: { extension_version: '1.2.6' }
      }]
    })

    await options_opened()
    expect(fetchCalls[5].bodyJson).toMatchObject({
      events: [{
        name: 'options_opened',
        params: { extension_version: '1.2.6' }
      }]
    })

    await consent_changed('granted')
    expect(fetchCalls[6].bodyJson).toMatchObject({
      events: [{
        name: 'consent_changed',
        params: { value: 'granted', extension_version: '1.2.6' }
      }]
    })
  })

  it('12. setAnalyticsConsent("denied") sends nothing; setAnalyticsConsent("granted") sends consent_changed', async () => {
    let notifiedValue: AnalyticsConsent | null = null
    const unsubscribe = addConsentChangeListener((val) => {
      notifiedValue = val
    })

    // Setting denied: persists, updates cache, notifies listeners, but sends zero network events
    await setAnalyticsConsent('denied')
    expect(notifiedValue).toBe('denied')
    expect(fetchCalls.length).toBe(0)

    const storedAfterDenied = await mockLocalStorage.get('analyticsConsent')
    expect(storedAfterDenied.analyticsConsent).toBe('denied')

    // Setting granted: persists, updates cache, notifies listeners, and sends consent_changed
    await setAnalyticsConsent('granted')
    expect(notifiedValue).toBe('granted')
    expect(fetchCalls.length).toBe(1)
    expect((fetchCalls[0].bodyJson as any).events[0].name).toBe('consent_changed')
    expect((fetchCalls[0].bodyJson as any).events[0].params.value).toBe('granted')

    unsubscribe()
  })

  it('13. The debug flag routes to the debug/mp/collect URL and logs validation response', async () => {
    _setCredentialsForTesting({
      measurementId: 'G-DEBUG001',
      apiSecret: 'secret_debug',
      debug: true
    })
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await badge_scan()

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toContain('https://www.google-analytics.com/debug/mp/collect?')
    expect(fetchCalls[0].url).toContain('measurement_id=G-DEBUG001')
    expect(fetchCalls[0].url).toContain('api_secret=secret_debug')
  })

  it('14. Missing manifest version falls back gracefully to "unknown"', async () => {
    manifestVersion = undefined
    await setAnalyticsConsent('granted')
    fetchCalls = []

    await options_opened()

    expect(fetchCalls.length).toBe(1)
    expect((fetchCalls[0].bodyJson as any).events[0].params.extension_version).toBe('unknown')
  })

  it('15. Concurrent calls for client_id share the same in-flight resolution', async () => {
    await setAnalyticsConsent('granted')
    fetchCalls = []

    // Call two events in parallel before client_id is cached
    await Promise.all([badge_scan(), options_opened()])

    expect(fetchCalls.length).toBe(2)
    const c1 = (fetchCalls[0].bodyJson as any).client_id
    const c2 = (fetchCalls[1].bodyJson as any).client_id
    expect(c1).toBe(c2)
  })
})
