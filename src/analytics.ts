/**
 * Signed telemetry relay client.
 *
 * Implements privacy-preserving telemetry per issue #183:
 * - ECDSA P-256 per-install key pair generated with WebCrypto
 * - Private key is strictly non-extractable and persisted in IndexedDB
 * - Ticket-based authentication from POST /v1/installs
 * - Ticket caching in chrome.storage.session with in-memory fallback
 * - Canonical JSON payload signing with base64url IEEE P1363 signatures
 * - Consent-gated: only sends when consent is strictly 'granted'
 * - Signed erasure on consent withdrawal (DELETE /v1/installs)
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

export interface KeyStore {
  load: () => Promise<CryptoKeyPair | null>
  save: (keyPair: CryptoKeyPair) => Promise<void>
  clear: () => Promise<void>
}

interface TicketData {
  install_id: string
  ticket: string
  expires_at: number
}

interface PublicJwk {
  kty: string
  crv: string
  x: string
  y: string
}

interface StoredConsentWrapper {
  analyticsConsent?: unknown
}

const STORAGE_KEY_CONSENT = 'analyticsConsent'
const STORAGE_KEY_TICKET = 'telemetryTicketData'
const DB_NAME = 'verifieddit_telemetry'
const DB_STORE_NAME = 'keys'
const DB_KEY_PAIR = 'client_key_pair'

const TICKET_SAFETY_MARGIN_MS = 30_000
const ANALYTICS_TIMEOUT_MSEC = 5000

// Injected at build time by rollup. Never read from runtime storage.
const BUILD_RELAY_URL = process.env.TELEMETRY_RELAY_URL ?? ''

// Mutable test overrides
let testRelayUrl: string | null = null

export class IndexedDbKeyStore implements KeyStore {
  private async openDb (): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'))
        return
      }
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
          db.createObjectStore(DB_STORE_NAME)
        }
      }
      req.onsuccess = () => { resolve(req.result) }
      req.onerror = () => { reject(req.error ?? new Error('IndexedDB open error')) }
      req.onblocked = () => { reject(new Error('IndexedDB open blocked')) }
    })
  }

  async load (): Promise<CryptoKeyPair | null> {
    try {
      const db = await this.openDb()
      return await new Promise<CryptoKeyPair | null>((resolve, reject) => {
        const tx = db.transaction(DB_STORE_NAME, 'readonly')
        const store = tx.objectStore(DB_STORE_NAME)
        const req = store.get(DB_KEY_PAIR)
        req.onsuccess = () => { resolve((req.result as CryptoKeyPair) ?? null) }
        req.onerror = () => { reject(req.error ?? new Error('IndexedDB get error')) }
        tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB transaction error')) }
        tx.onabort = () => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
      })
    } catch {
      // Fire-and-forget contract: IndexedDB load errors return null so callers proceed without crashing
      return null
    }
  }

  async save (keyPair: CryptoKeyPair): Promise<void> {
    const db = await this.openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE_NAME, 'readwrite')
      const store = tx.objectStore(DB_STORE_NAME)
      const req = store.put(keyPair, DB_KEY_PAIR)
      req.onsuccess = () => { resolve() }
      req.onerror = () => { reject(req.error ?? new Error('IndexedDB put error')) }
      tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB transaction error')) }
      tx.onabort = () => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
    })
  }

  async clear (): Promise<void> {
    try {
      const db = await this.openDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_STORE_NAME, 'readwrite')
        const store = tx.objectStore(DB_STORE_NAME)
        const req = store.delete(DB_KEY_PAIR)
        req.onsuccess = () => { resolve() }
        req.onerror = () => { reject(req.error ?? new Error('IndexedDB delete error')) }
        tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB transaction error')) }
        tx.onabort = () => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
      })
    } catch {
      // Clear errors handled safely per fire-and-forget contract
    }
  }
}

const defaultKeyStore: KeyStore = new IndexedDbKeyStore()
let activeKeyStore: KeyStore = defaultKeyStore

// In-memory caches
let cachedKeyPair: CryptoKeyPair | null = null
let cachedTicketData: TicketData | null = null
let ticketPromise: Promise<TicketData | null> | null = null
let cachedConsent: AnalyticsConsent | null = null

// Listeners observing consent changes
type ConsentChangeListener = (value: AnalyticsConsent) => void
const consentChangeListeners = new Set<ConsentChangeListener>()

let keyLoadPromise: Promise<CryptoKeyPair | null> | null = null
let keyGeneratePromise: Promise<CryptoKeyPair | null> | null = null

function dropLocalStateSync (): void {
  cachedKeyPair = null
  keyLoadPromise = null
  keyGeneratePromise = null
  cachedTicketData = null
  ticketPromise = null
  void writeTicketData(null)
  void activeKeyStore.clear()
}

let isStorageListenerRegistered = false

export function _ensureStorageListener (): void {
  if (isStorageListenerRegistered) return
  try {
    if (chrome?.storage?.onChanged?.addListener != null) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !(STORAGE_KEY_CONSENT in changes)) {
          return
        }
        const raw = changes[STORAGE_KEY_CONSENT]?.newValue
        const next: AnalyticsConsent = raw === 'granted' || raw === 'denied' || raw === 'unset'
          ? raw
          : 'unset'
        cachedConsent = next
        if (next !== 'granted') {
          dropLocalStateSync()
        }
        for (const listener of consentChangeListeners) {
          try {
            listener(next)
          } catch {
            // Fire-and-forget: do not throw to caller
          }
        }
      })
      isStorageListenerRegistered = true
    }
  } catch {
    // Listener registration failure handled safely per fire-and-forget contract
  }
}

// Guarded initial storage change listener for cross-context consent staleness
_ensureStorageListener()

function getRelayUrl (): string {
  return testRelayUrl ?? BUILD_RELAY_URL
}

/**
 * Check if the telemetry client has a relay URL configured.
 * When false, all telemetry operations silently no-op.
 */
export function isAnalyticsConfigured (): boolean {
  const url = getRelayUrl()
  return url.trim().length > 0
}

/**
 * Read the current consent state. Validates stored shape before returning.
 */
export async function getAnalyticsConsent (): Promise<AnalyticsConsent> {
  _ensureStorageListener()
  if (cachedConsent != null) {
    return cachedConsent
  }

  try {
    const stored = await chrome.storage?.local?.get(STORAGE_KEY_CONSENT) as StoredConsentWrapper | undefined
    const raw = stored?.analyticsConsent
    if (raw === 'granted' || raw === 'denied' || raw === 'unset') {
      cachedConsent = raw
    } else {
      cachedConsent = 'unset'
    }
  } catch {
    cachedConsent = 'unset'
  }

  return cachedConsent
}

/**
 * Update consent state, persist to local storage, notify registered
 * change listeners, and when denied, trigger signed erasure and local credential cleanup.
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

  if (value === 'denied') {
    await handleConsentDenied()
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
 * Base64url encode a byte array without padding.
 */
function base64UrlEncode (bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Canonical JSON serializer matching the relay wire protocol.
 * Keys are sorted lexicographically, whitespace is stripped, and numbers are validated.
 */
export function canonicalise (value: unknown): string {
  if (value === null) {
    return 'null'
  }
  const valType = typeof value
  if (valType === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalise non-finite number')
    }
    return JSON.stringify(value)
  }
  if (valType === 'string' || valType === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalise(item)).join(',') + ']'
  }
  if (valType === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const k of keys) {
      if (obj[k] !== undefined) {
        parts.push(JSON.stringify(k) + ':' + canonicalise(obj[k]))
      }
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error('Unsupported value type for canonicalisation')
}

export function canonicaliseEventPayload (payload: {
  install_id: string
  ts: number
  event: {
    name: string
    params: Record<string, unknown>
  }
  version: string
}): string {
  return canonicalise({
    event: payload.event,
    install_id: payload.install_id,
    ts: payload.ts,
    version: payload.version
  })
}

export function canonicaliseErasurePayload (payload: {
  install_id: string
  ts: number
}): string {
  return canonicalise({
    action: 'erase',
    install_id: payload.install_id,
    ts: payload.ts
  })
}

/**
 * Retrieve or generate the persistent ECDSA P-256 key pair.
 * Private key is non-extractable.
 */
async function getOrCreateKeyPair (createIfMissing: boolean): Promise<CryptoKeyPair | null> {
  if (cachedKeyPair != null) {
    return cachedKeyPair
  }

  // First, check if a load from storage is already pending or needed
  if (keyLoadPromise == null) {
    keyLoadPromise = (async () => {
      try {
        const stored = await activeKeyStore.load()
        if (stored != null) {
          cachedKeyPair = stored
          return cachedKeyPair
        }
      } catch {
        // KeyStore read failure handled safely per fire-and-forget contract
      }
      return null
    })()
  }

  const loaded = await keyLoadPromise
  if (loaded != null) {
    return loaded
  }

  if (cachedKeyPair != null) {
    return cachedKeyPair
  }

  if (!createIfMissing) {
    return null
  }

  // Key is missing and needs creation. Share one keyGeneratePromise so exactly one key is generated.
  if (keyGeneratePromise == null) {
    keyGeneratePromise = (async () => {
      try {
        if (crypto?.subtle == null) {
          return null
        }

        const keyPair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign', 'verify']
        )
        cachedKeyPair = keyPair

        try {
          await activeKeyStore.save(keyPair)
        } catch {
          // KeyStore save failure handled safely per fire-and-forget contract
        }

        return keyPair
      } catch {
        // WebCrypto key generation failure handled safely per fire-and-forget contract
        return null
      }
    })()
  }

  try {
    return await keyGeneratePromise
  } finally {
    keyGeneratePromise = null
  }
}

function isValidTicketData (obj: unknown): obj is TicketData {
  if (typeof obj !== 'object' || obj == null) return false
  const candidate = obj as Record<string, unknown>
  return typeof candidate.install_id === 'string' &&
    candidate.install_id.length > 0 &&
    typeof candidate.ticket === 'string' &&
    candidate.ticket.length > 0 &&
    typeof candidate.expires_at === 'number' &&
    Number.isFinite(candidate.expires_at)
}

async function readTicketData (): Promise<TicketData | null> {
  if (cachedTicketData != null) {
    return cachedTicketData
  }

  if (chrome?.storage?.session == null) {
    return cachedTicketData
  }

  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY_TICKET) as Record<string, unknown> | undefined
    const raw = stored?.[STORAGE_KEY_TICKET]
    if (isValidTicketData(raw)) {
      cachedTicketData = raw
      return cachedTicketData
    }
  } catch {
    // Session storage read failure falls back to memory
  }

  return cachedTicketData
}

async function writeTicketData (data: TicketData | null): Promise<void> {
  cachedTicketData = data

  if (chrome?.storage?.session == null) {
    return
  }

  try {
    if (data == null) {
      await chrome.storage.session.remove(STORAGE_KEY_TICKET)
    } else {
      await chrome.storage.session.set({ [STORAGE_KEY_TICKET]: data })
    }
  } catch {
    // Session storage write failure handled safely
  }
}

async function exportCleanJwk (publicKey: CryptoKey): Promise<PublicJwk> {
  const exported = await crypto.subtle.exportKey('jwk', publicKey)
  return {
    kty: exported.kty ?? 'EC',
    crv: exported.crv ?? 'P-256',
    x: exported.x ?? '',
    y: exported.y ?? ''
  }
}

/**
 * Obtain a ticket from the relay, validating the response before caching.
 */
async function getOrFetchTicket (keyPair: CryptoKeyPair, forceRefresh = false): Promise<TicketData | null> {
  if (!forceRefresh) {
    const cached = await readTicketData()
    if (cached != null && Date.now() < cached.expires_at - TICKET_SAFETY_MARGIN_MS) {
      return cached
    }
  }

  if (ticketPromise != null && !forceRefresh) {
    return await ticketPromise
  }

  const inFlight = (async () => {
    const relayUrl = getRelayUrl().replace(/\/+$/, '')
    const jwk = await exportCleanJwk(keyPair.publicKey)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, ANALYTICS_TIMEOUT_MSEC)

    try {
      const res = await fetch(`${relayUrl}/v1/installs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jwk }),
        signal: controller.signal
      })

      if (!res.ok) {
        return null
      }

      const data: unknown = await res.json()
      if (isValidTicketData(data)) {
        await writeTicketData(data)
        return data
      }
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timeoutId)
    }
  })()

  ticketPromise = inFlight

  try {
    return await inFlight
  } finally {
    if (ticketPromise === inFlight) {
      ticketPromise = null
    }
  }
}

function getExtensionVersion (): string {
  try {
    const manifest = chrome.runtime?.getManifest?.()
    if (typeof manifest?.version === 'string' && manifest.version.length > 0) {
      return manifest.version.slice(0, 32)
    }
  } catch {
    // Fall through to default
  }
  return 'unknown'
}

let inFlightErasurePromise: Promise<void> | null = null

/**
 * Handle consent withdrawal: send signed erasure to relay if a key exists,
 * then wipe all local credentials, tickets, and cached state.
 */
async function handleConsentDenied (): Promise<void> {
  if (inFlightErasurePromise != null) {
    await inFlightErasurePromise
    return
  }

  const inFlight = (async () => {
    try {
      if (isAnalyticsConfigured()) {
        const existingKeyPair = await getOrCreateKeyPair(false)
        if (existingKeyPair != null) {
          const ticketData = await getOrFetchTicket(existingKeyPair)
          if (ticketData != null) {
            const jwk = await exportCleanJwk(existingKeyPair.publicKey)
            const ts = Date.now()
            const canonical = canonicaliseErasurePayload({
              install_id: ticketData.install_id,
              ts
            })
            const sigBytes = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              existingKeyPair.privateKey,
              new TextEncoder().encode(canonical)
            )
            const sig = base64UrlEncode(new Uint8Array(sigBytes))

            const relayUrl = getRelayUrl().replace(/\/+$/, '')
            const controller = new AbortController()
            const timeoutId = setTimeout(() => {
              controller.abort()
            }, ANALYTICS_TIMEOUT_MSEC)

            try {
              await fetch(`${relayUrl}/v1/installs`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  install_id: ticketData.install_id,
                  ticket: ticketData.ticket,
                  ts,
                  sig,
                  jwk
                }),
                signal: controller.signal
              })
            } finally {
              clearTimeout(timeoutId)
            }
          }
        }
      }
    } catch {
      // Network errors during erasure must never block local state cleanup
    } finally {
      cachedKeyPair = null
      keyLoadPromise = null
      keyGeneratePromise = null
      ticketPromise = null
      await writeTicketData(null)
      try {
        await activeKeyStore.clear()
      } catch {
        // KeyStore clear failure handled safely
      }
    }
  })()

  inFlightErasurePromise = inFlight

  try {
    await inFlight
  } finally {
    if (inFlightErasurePromise === inFlight) {
      inFlightErasurePromise = null
    }
  }
}

/**
 * Core send routine for telemetry events.
 * Signs payload with non-extractable ECDSA key and handles ticket refreshing.
 */
async function sendEvent (eventName: string, eventParams: Record<string, unknown> = {}): Promise<void> {
  if (!isAnalyticsConfigured()) {
    return
  }

  const consent = await getAnalyticsConsent()
  if (consent !== 'granted') {
    return
  }

  try {
    const keyPair = await getOrCreateKeyPair(true)
    if (keyPair == null) {
      return
    }

    const ticketData = await getOrFetchTicket(keyPair)
    if (ticketData == null) {
      return
    }

    const jwk = await exportCleanJwk(keyPair.publicKey)
    const version = getExtensionVersion()
    const ts = Date.now()

    const relayEvent = {
      name: eventName,
      params: eventParams
    }

    const canonical = canonicaliseEventPayload({
      install_id: ticketData.install_id,
      ts,
      event: relayEvent,
      version
    })

    const sigBytes = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new TextEncoder().encode(canonical)
    )
    const sig = base64UrlEncode(new Uint8Array(sigBytes))

    const body = {
      install_id: ticketData.install_id,
      ticket: ticketData.ticket,
      ts,
      event: relayEvent,
      version,
      sig,
      jwk
    }

    const relayUrl = getRelayUrl().replace(/\/+$/, '')
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, ANALYTICS_TIMEOUT_MSEC)

    let res: Response
    let isInvalidTicket = false
    try {
      res = await fetch(`${relayUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (res.status === 400) {
        try {
          const errorJson = await res.json() as Record<string, unknown> | undefined
          if (errorJson?.error === 'invalid_ticket') {
            isInvalidTicket = true
          }
        } catch {
          // Response was not JSON
        }
      }
    } finally {
      clearTimeout(timeoutId)
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const shouldRefreshTicket = res.status === 401 || res.status === 403 || isInvalidTicket

      if (shouldRefreshTicket) {
        const freshTicket = await getOrFetchTicket(keyPair, true)
        if (freshTicket != null) {
          const retryTs = Date.now()
          const retryCanonical = canonicaliseEventPayload({
            install_id: freshTicket.install_id,
            ts: retryTs,
            event: relayEvent,
            version
          })
          const retrySigBytes = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keyPair.privateKey,
            new TextEncoder().encode(retryCanonical)
          )
          const retrySig = base64UrlEncode(new Uint8Array(retrySigBytes))

          const retryBody = {
            install_id: freshTicket.install_id,
            ticket: freshTicket.ticket,
            ts: retryTs,
            event: relayEvent,
            version,
            sig: retrySig,
            jwk
          }

          const retryController = new AbortController()
          const retryTimeoutId = setTimeout(() => {
            retryController.abort()
          }, ANALYTICS_TIMEOUT_MSEC)

          try {
            await fetch(`${relayUrl}/v1/events`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(retryBody),
              signal: retryController.signal
            })
          } finally {
            clearTimeout(retryTimeoutId)
          }
        }
      }
    }
  } catch {
    // Deliberate fire-and-forget catch: extension operations must never fail due to telemetry
  }
}

// Public Typed Event APIs (snake_case names preserved for backward compatibility)
/* eslint-disable @typescript-eslint/naming-convention */

export async function extension_installed (): Promise<void> {
  await sendEvent('extension_installed', {})
}

export async function extension_updated (previous_version: string): Promise<void> {
  const truncated = typeof previous_version === 'string' && previous_version.length > 0
    ? previous_version.slice(0, 32)
    : 'unknown'
  await sendEvent('extension_updated', { previous_version: truncated })
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
  await sendEvent('badge_scan', {})
}

export async function options_opened (): Promise<void> {
  await sendEvent('options_opened', {})
}

export async function consent_changed (value: 'granted' | 'denied'): Promise<void> {
  await sendEvent('consent_changed', { value })
}

/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Map an arbitrary media type string to MediaType ('image' | 'video' | 'audio' | 'pdf').
 * Defaults to 'image' for any unrecognized or missing value.
 */
export function mapMediaType (rawType?: string | null): MediaType {
  if (rawType == null) return 'image'
  const normalized = rawType.toLowerCase().trim()
  if (normalized === 'video' || normalized.startsWith('video/')) return 'video'
  if (normalized === 'audio' || normalized.startsWith('audio/')) return 'audio'
  if (normalized === 'pdf' || normalized === 'application/pdf') return 'pdf'
  return 'image'
}

/**
 * Map a verification outcome to VerifyResult ('valid' | 'invalid' | 'none' | 'error').
 * Reuses repo's verdict semantics without inventing parallel classification.
 */
export function mapVerificationResult (
  c2paResult: unknown,
  computedVerdict?: string | null
): VerifyResult {
  if (c2paResult instanceof Error) {
    const errorObj = c2paResult as { name?: string, message?: string }
    if (errorObj.name === 'No Manifest' || errorObj.message === 'No manifest found') {
      return 'none'
    }
    return 'error'
  }

  if (typeof c2paResult === 'object' && c2paResult !== null) {
    const candidate = c2paResult as { name?: string, message?: string }
    if (candidate.name === 'No Manifest' || candidate.message === 'No manifest found') {
      return 'none'
    }
  }

  if (computedVerdict != null) {
    if (computedVerdict === 'verified' || computedVerdict === 'authentic') {
      return 'valid'
    }
    if (computedVerdict === 'invalid') {
      return 'invalid'
    }
    if (computedVerdict === 'unsigned') {
      return 'none'
    }
  }

  return 'none'
}

// Auto-scan throttle state: at most one auto_scan + badge_scan per tab per window
export const SCAN_EVENT_THROTTLE_MSEC = 60_000
const UNDEFINED_TAB_KEY = -1
const lastScanEmissionByTab = new Map<number, number>()

/**
 * Gate auto-scan and badge-scan telemetry emissions to at most once per tab per window.
 * Prunes expired entries on every call to keep memory usage bounded.
 */
export function shouldEmitScanEvent (tabId: number | undefined, now: number): boolean {
  for (const [key, timestamp] of lastScanEmissionByTab) {
    if (now - timestamp >= SCAN_EVENT_THROTTLE_MSEC) {
      lastScanEmissionByTab.delete(key)
    }
  }

  const key = tabId ?? UNDEFINED_TAB_KEY
  const lastEmitted = lastScanEmissionByTab.get(key)

  if (lastEmitted != null && now - lastEmitted < SCAN_EVENT_THROTTLE_MSEC) {
    return false
  }

  lastScanEmissionByTab.set(key, now)
  return true
}

// Testing hooks for mocking and unit verification

export function _scanThrottleSizeForTesting (): number {
  return lastScanEmissionByTab.size
}

export function _resetStateForTesting (): void {
  cachedKeyPair = null
  keyLoadPromise = null
  keyGeneratePromise = null
  cachedTicketData = null
  ticketPromise = null
  cachedConsent = null
  isStorageListenerRegistered = false
  consentChangeListeners.clear()
  testRelayUrl = null
  activeKeyStore = defaultKeyStore
  lastScanEmissionByTab.clear()
}

export function _setRelayUrlForTesting (url: string | null): void {
  testRelayUrl = url
}

export function _setKeyStoreForTesting (store: KeyStore | null): void {
  activeKeyStore = store ?? defaultKeyStore
}

export async function _getOrCreateKeyPairForTesting (createIfMissing: boolean): Promise<CryptoKeyPair | null> {
  return await getOrCreateKeyPair(createIfMissing)
}

export async function _getCachedTicketForTesting (): Promise<TicketData | null> {
  return await readTicketData()
}
