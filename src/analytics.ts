/**
 * Google Analytics 4 Measurement Protocol client for MV3.
 *
 * Implements the MV3 service worker approach per Chrome extension guidance:
 * - POST to https://www.google-analytics.com/mp/collect (or /debug/mp/collect)
 * - Persistent client_id in chrome.storage.local
 * - Session id and last updated timestamp in chrome.storage.session (30 min expiry)
 * - Firefox fallback: in-memory session object when storage.session is unavailable
 * - Consent-gated: only sends when consent is strictly 'granted'
 * - Bounded async timeouts (5000ms cap)
 * - Fire-and-forget: never throws or rejects out of the public API
 */

export type AnalyticsConsent = 'granted' | 'denied' | 'unset'

export type VerifySource = 'context_menu' | 'popup' | 'auto_scan'
export type VerifyResult = 'valid' | 'invalid' | 'none' | 'error'
export type MediaType = 'image' | 'video' | 'audio' | 'pdf'

export interface VerifyCompletedParams {
  result: VerifyResult
  has_durable_binding: boolean
  media_type: MediaType
}

interface SessionData {
  sessionId: string
  sessionLastUpdated: number
}

interface StoredSessionWrapper {
  ga4SessionData?: unknown
}

interface StoredClientIdWrapper {
  ga4ClientId?: unknown
}

interface StoredConsentWrapper {
  analyticsConsent?: unknown
}

const GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect'
const GA_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect'

const STORAGE_KEY_CLIENT_ID = 'ga4ClientId'
const STORAGE_KEY_SESSION = 'ga4SessionData'
const STORAGE_KEY_CONSENT = 'analyticsConsent'

const SESSION_EXPIRATION_IN_MIN = 30
const DEFAULT_ENGAGEMENT_TIME_MSEC = 100
const ANALYTICS_TIMEOUT_MSEC = 5000

// Injected at build time by rollup. Never read from runtime storage.
const BUILD_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID ?? ''
const BUILD_API_SECRET = process.env.GA4_API_SECRET ?? ''
const BUILD_GA_DEBUG = process.env.GA_DEBUG?.toLowerCase() === 'true'

// Mutable test overrides
let testMeasurementId: string | null = null
let testApiSecret: string | null = null
let testDebug: boolean | null = null

// Read-through cache for client_id and active in-flight resolution
let cachedClientId: string | null = null
let clientIdPromise: Promise<string> | null = null

// Read-through cache for consent
let cachedConsent: AnalyticsConsent | null = null

// In-memory fallback session for Firefox or environments without chrome.storage.session
let inMemorySession: SessionData | null = null

// Listeners observing consent changes
type ConsentChangeListener = (value: AnalyticsConsent) => void
const consentChangeListeners = new Set<ConsentChangeListener>()

function getMeasurementId (): string {
  return testMeasurementId ?? BUILD_MEASUREMENT_ID
}

function getApiSecret (): string {
  return testApiSecret ?? BUILD_API_SECRET
}

function isDebugMode (): boolean {
  return testDebug ?? BUILD_GA_DEBUG
}

/**
 * Check if the GA4 client has valid credentials configured.
 * When false, all send calls silently no-op.
 */
export function isAnalyticsConfigured (): boolean {
  const mid = getMeasurementId()
  const secret = getApiSecret()
  return mid.trim().length > 0 && secret.trim().length > 0
}

/**
 * Read the current consent state. Validates stored shape before returning.
 */
export async function getAnalyticsConsent (): Promise<AnalyticsConsent> {
  if (cachedConsent != null) {
    return cachedConsent
  }

  try {
    const stored = await chrome.storage?.local?.get(STORAGE_KEY_CONSENT) as StoredConsentWrapper | undefined
    const raw = stored?.analyticsConsent
    if (raw === 'granted' || raw === 'denied' || raw === 'unset') {
      cachedConsent = raw
    } else {
      // Treat missing or malformed value as unset
      cachedConsent = 'unset'
    }
  } catch {
    // If storage read fails, fail safe to unset
    cachedConsent = 'unset'
  }

  return cachedConsent
}

/**
 * Update consent state, persist to storage, notify observers,
 * and if granted, dispatch consent_changed event.
 */
export async function setAnalyticsConsent (value: AnalyticsConsent): Promise<void> {
  cachedConsent = value

  try {
    await chrome.storage?.local?.set({ [STORAGE_KEY_CONSENT]: value })
  } catch {
    // Storage write failure is handled safely without throwing out
  }

  for (const listener of consentChangeListeners) {
    try {
      listener(value)
    } catch {
      // Listener errors do not prevent notifying remaining listeners
    }
  }

  if (value === 'granted') {
    await sendEvent('consent_changed', { value: 'granted' })
  }
}

/**
 * Register a callback for consent changes. Returns an unsubscribe function.
 */
export function addConsentChangeListener (listener: ConsentChangeListener): () => void {
  consentChangeListeners.add(listener)
  return () => {
    consentChangeListeners.delete(listener)
  }
}

/**
 * Retrieve or generate the persistent client_id.
 * Concurrent callers share a single in-flight resolution promise.
 */
async function getOrCreateClientId (): Promise<string> {
  if (cachedClientId != null) {
    return cachedClientId
  }

  if (clientIdPromise != null) {
    return await clientIdPromise
  }

  clientIdPromise = (async () => {
    try {
      const stored = await chrome.storage?.local?.get(STORAGE_KEY_CLIENT_ID) as StoredClientIdWrapper | undefined
      const raw = stored?.ga4ClientId
      if (typeof raw === 'string' && raw.trim().length > 0) {
        cachedClientId = raw
        return cachedClientId
      }
    } catch {
      // Storage read failed, fallback to generating new id
    }

    const newId = crypto.randomUUID()
    cachedClientId = newId

    try {
      await chrome.storage?.local?.set({ [STORAGE_KEY_CLIENT_ID]: newId })
    } catch {
      // Storage write failure is handled safely
    }

    return newId
  })()

  try {
    return await clientIdPromise
  } finally {
    clientIdPromise = null
  }
}

function isValidSessionData (obj: unknown): obj is SessionData {
  if (typeof obj !== 'object' || obj == null) return false
  const candidate = obj as Record<string, unknown>
  return typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.sessionLastUpdated === 'number' &&
    !Number.isNaN(candidate.sessionLastUpdated)
}

/**
 * Read session data from chrome.storage.session, falling back to in-memory session.
 */
async function readSessionData (): Promise<SessionData | null> {
  // Firefox or older browsers might not support chrome.storage.session
  if (chrome?.storage.session == null) {
    return inMemorySession
  }

  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY_SESSION) as StoredSessionWrapper | undefined
    if (isValidSessionData(stored?.ga4SessionData)) {
      return stored.ga4SessionData
    }
    // Malformed stored session: treat as absent
    return null
  } catch {
    // Fall back to in-memory session if storage.session throws
    return inMemorySession
  }
}

/**
 * Persist session data to chrome.storage.session and update in-memory session.
 */
async function writeSessionData (session: SessionData): Promise<void> {
  inMemorySession = { ...session }

  if (chrome?.storage.session == null) {
    return
  }

  try {
    await chrome.storage.session.set({ [STORAGE_KEY_SESSION]: session })
  } catch {
    // Fall back silently to in-memory session
  }
}

interface SessionInfo {
  sessionId: string
  engagementTimeMsec: string
}

/**
 * Retrieve active session id and compute engagement time in msec.
 * Starts a new session if expired or absent.
 */
async function getOrCreateSession (): Promise<SessionInfo> {
  const now = Date.now()
  const maxAgeMs = SESSION_EXPIRATION_IN_MIN * 60 * 1000
  const session = await readSessionData()

  if (session == null || now - session.sessionLastUpdated > maxAgeMs) {
    const newSession: SessionData = {
      sessionId: String(now),
      sessionLastUpdated: now
    }
    await writeSessionData(newSession)
    return {
      sessionId: newSession.sessionId,
      engagementTimeMsec: String(DEFAULT_ENGAGEMENT_TIME_MSEC)
    }
  }

  const elapsed = Math.max(0, now - session.sessionLastUpdated)
  session.sessionLastUpdated = now
  await writeSessionData(session)

  return {
    sessionId: session.sessionId,
    engagementTimeMsec: String(elapsed)
  }
}

function getExtensionVersion (): string {
  try {
    const manifest = chrome.runtime?.getManifest?.()
    if (typeof manifest?.version === 'string' && manifest.version.length > 0) {
      return manifest.version
    }
  } catch {
    // Fall through to default
  }
  return 'unknown'
}

/**
 * Core send routine.
 * Guarded against unconfigured credentials, ungranted consent, and timeouts.
 * Fire-and-forget: catch all internal errors so callers are never rejected.
 */
async function sendEvent (eventName: string, eventParams: Record<string, unknown> = {}): Promise<void> {
  if (!isAnalyticsConfigured()) {
    return
  }

  const consent = await getAnalyticsConsent()
  if (consent !== 'granted') {
    return
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, ANALYTICS_TIMEOUT_MSEC)

  try {
    const clientId = await getOrCreateClientId()
    const { sessionId, engagementTimeMsec } = await getOrCreateSession()
    const extensionVersion = getExtensionVersion()

    const mid = getMeasurementId()
    const secret = getApiSecret()
    const debug = isDebugMode()

    const baseUrl = debug ? GA_DEBUG_ENDPOINT : GA_ENDPOINT
    const url = `${baseUrl}?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`

    const payload = {
      client_id: clientId,
      events: [
        {
          name: eventName,
          params: {
            ...eventParams,
            session_id: sessionId,
            engagement_time_msec: engagementTimeMsec,
            extension_version: extensionVersion
          }
        }
      ]
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    if (debug) {
      try {
        const bodyText = await response.text()
        console.log('[GA4 Debug Validation]', response.status, bodyText)
      } catch {
        // Ignore response body read failures in debug logging
      }
    }
  } catch (error) {
    // Deliberate fire-and-forget catch: extension operations must never fail due to analytics
    if (isDebugMode()) {
      console.warn('[GA4 Analytics Warning]', error)
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// Public Typed Event APIs (snake_case names per GA4 specification)
/* eslint-disable @typescript-eslint/naming-convention */

export async function extension_installed (): Promise<void> {
  await sendEvent('extension_installed')
}

export async function extension_updated (previous_version: string): Promise<void> {
  await sendEvent('extension_updated', { previous_version })
}

export async function verify_started (source: VerifySource): Promise<void> {
  await sendEvent('verify_started', { source })
}

export async function verify_completed (params: VerifyCompletedParams): Promise<void> {
  await sendEvent('verify_completed', {
    result: params.result,
    has_durable_binding: params.has_durable_binding,
    media_type: params.media_type
  })
}

export async function badge_scan (): Promise<void> {
  await sendEvent('badge_scan')
}

export async function options_opened (): Promise<void> {
  await sendEvent('options_opened')
}

export async function consent_changed (value: 'granted' | 'denied'): Promise<void> {
  await sendEvent('consent_changed', { value })
}

/* eslint-enable @typescript-eslint/naming-convention */

// Testing hooks for mocking and unit verification

export function _resetStateForTesting (): void {
  cachedClientId = null
  clientIdPromise = null
  cachedConsent = null
  inMemorySession = null
  consentChangeListeners.clear()
  testMeasurementId = null
  testApiSecret = null
  testDebug = null
}

export function _setCredentialsForTesting (creds: {
  measurementId?: string
  apiSecret?: string
  debug?: boolean
}): void {
  if (creds.measurementId !== undefined) {
    testMeasurementId = creds.measurementId
  }
  if (creds.apiSecret !== undefined) {
    testApiSecret = creds.apiSecret
  }
  if (creds.debug !== undefined) {
    testDebug = creds.debug
  }
}

export function _getInMemorySessionForTesting (): SessionData | null {
  return inMemorySession
}

export function _setInMemorySessionForTesting (session: SessionData | null): void {
  inMemorySession = session != null ? { ...session } : null
}
