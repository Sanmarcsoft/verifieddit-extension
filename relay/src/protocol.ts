export class ProtocolError extends Error {
  constructor (public readonly code: string, message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface PublicJwk {
  kty: string
  crv: string
  x: string
  y: string
  [key: string]: unknown
}

export type VerifySource = 'context_menu' | 'popup' | 'auto_scan'
export type VerifyResult = 'valid' | 'invalid' | 'none' | 'error'
export type MediaType = 'image' | 'video' | 'audio' | 'pdf'

export type RelayEvent =
  | { name: 'extension_installed', params: Record<string, never> }
  | { name: 'extension_updated', params: { previous_version: string } }
  | { name: 'verify_started', params: { source: VerifySource } }
  | {
    name: 'verify_completed'
    params: {
      result: VerifyResult
      has_durable_binding: boolean
      media_type: MediaType
    }
  }
  | { name: 'badge_scan', params: Record<string, never> }
  | { name: 'options_opened', params: Record<string, never> }
  | { name: 'consent_changed', params: { value: 'granted' | 'denied' } }

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/

export function base64UrlEncode (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function base64UrlDecode (str: string): Uint8Array {
  if (typeof str !== 'string' || str.length === 0 || !BASE64URL_REGEX.test(str)) {
    throw new Error('Invalid base64url string')
  }
  return new Uint8Array(Buffer.from(str, 'base64url'))
}

export function validatePublicJwk (jwk: unknown): PublicJwk {
  if (typeof jwk !== 'object' || jwk === null) {
    throw new ProtocolError('invalid_key', 'JWK must be an object')
  }

  const candidate = jwk as Record<string, unknown>

  if ('d' in candidate) {
    throw new ProtocolError('invalid_key', 'Private key rejected')
  }

  if (candidate.kty !== 'EC') {
    throw new ProtocolError('invalid_key', 'Key kty must be EC')
  }

  if (candidate.crv !== 'P-256') {
    throw new ProtocolError('invalid_key', 'Key crv must be P-256')
  }

  if (typeof candidate.x !== 'string' || candidate.x.length === 0) {
    throw new ProtocolError('invalid_key', 'Key x coordinate must be a non-empty string')
  }

  if (typeof candidate.y !== 'string' || candidate.y.length === 0) {
    throw new ProtocolError('invalid_key', 'Key y coordinate must be a non-empty string')
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: candidate.x,
    y: candidate.y
  }
}

export async function computeJwkThumbprint (jwk: unknown): Promise<string> {
  const valid = validatePublicJwk(jwk)
  const canonicalJwk = `{"crv":"${valid.crv}","kty":"${valid.kty}","x":"${valid.x}","y":"${valid.y}"}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk))
  return base64UrlEncode(new Uint8Array(digest))
}

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
  event: RelayEvent
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

export async function createTicket (
  key: string,
  installId: string,
  expiresAt: number
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const message = new TextEncoder().encode(`${installId}:${expiresAt}`)
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, message)
  return `${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`
}

export async function verifyTicket (
  key: string,
  installId: string,
  ticket: string,
  now: number
): Promise<boolean> {
  if (typeof ticket !== 'string') {
    return false
  }

  const dotIndex = ticket.indexOf('.')
  if (dotIndex <= 0 || dotIndex === ticket.length - 1) {
    return false
  }

  const expiresAtStr = ticket.slice(0, dotIndex)
  const sigStr = ticket.slice(dotIndex + 1)

  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt < now) {
    return false
  }

  let sigBytes: Uint8Array
  try {
    sigBytes = base64UrlDecode(sigStr)
  } catch {
    return false
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const message = new TextEncoder().encode(`${installId}:${expiresAtStr}`)
    return await crypto.subtle.verify('HMAC', cryptoKey, sigBytes, message)
  } catch {
    return false
  }
}

export async function verifyEcdsaSignature (
  jwk: PublicJwk,
  signatureBase64Url: string,
  data: Uint8Array
): Promise<boolean> {
  try {
    const sigBytes = base64UrlDecode(signatureBase64Url)
    if (sigBytes.byteLength !== 64) {
      return false
    }

    const validJwk = validatePublicJwk(jwk)
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: validJwk.kty,
        crv: validJwk.crv,
        x: validJwk.x,
        y: validJwk.y
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      sigBytes,
      data
    )
  } catch {
    return false
  }
}

export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000
export const FIVE_MINUTES_MS = TIMESTAMP_WINDOW_MS

export function validateTimestamp (ts: unknown, now: number, maxSkewMs = TIMESTAMP_WINDOW_MS): boolean {
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(now - ts) <= maxSkewMs
}

export function validateVersion (version: unknown): string {
  if (typeof version !== 'string' || version.length === 0 || version.length > 32) {
    throw new ProtocolError('invalid_version', 'Version must be a non-empty string up to 32 characters')
  }
  return version
}

function hasExactKeys (obj: Record<string, unknown>, allowedKeys: string[]): boolean {
  const keys = Object.keys(obj)
  if (keys.length !== allowedKeys.length) {
    return false
  }
  for (const k of allowedKeys) {
    if (!(k in obj)) {
      return false
    }
  }
  return true
}

export function validateEvent (raw: unknown): RelayEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolError('invalid_event', 'Event must be an object')
  }

  const candidate = raw as Record<string, unknown>
  if (!hasExactKeys(candidate, ['name', 'params'])) {
    throw new ProtocolError('invalid_event', 'Event must only have name and params')
  }

  const { name, params } = candidate
  if (typeof name !== 'string') {
    throw new ProtocolError('invalid_event', 'Event name must be a string')
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ProtocolError('invalid_event', 'Event params must be an object')
  }

  const p = params as Record<string, unknown>

  switch (name) {
    case 'extension_installed':
    case 'badge_scan':
    case 'options_opened': {
      if (!hasExactKeys(p, [])) {
        throw new ProtocolError('invalid_event', `${name} must have empty params`)
      }
      return { name, params: {} }
    }

    case 'extension_updated': {
      if (!hasExactKeys(p, ['previous_version'])) {
        throw new ProtocolError('invalid_event', 'extension_updated params must only contain previous_version')
      }
      const pv = p.previous_version
      if (typeof pv !== 'string' || pv.length === 0 || pv.length > 32) {
        throw new ProtocolError('invalid_event', 'previous_version must be a string up to 32 characters')
      }
      return { name, params: { previous_version: pv } }
    }

    case 'verify_started': {
      if (!hasExactKeys(p, ['source'])) {
        throw new ProtocolError('invalid_event', 'verify_started params must only contain source')
      }
      const source = p.source
      if (source !== 'context_menu' && source !== 'popup' && source !== 'auto_scan') {
        throw new ProtocolError('invalid_event', 'verify_started source must be context_menu, popup, or auto_scan')
      }
      return { name, params: { source } }
    }

    case 'verify_completed': {
      if (!hasExactKeys(p, ['result', 'has_durable_binding', 'media_type'])) {
        throw new ProtocolError(
          'invalid_event',
          'verify_completed params must only contain result, has_durable_binding, media_type'
        )
      }
      const { result, has_durable_binding: hasDurableBinding, media_type: mediaType } = p
      if (result !== 'valid' && result !== 'invalid' && result !== 'none' && result !== 'error') {
        throw new ProtocolError('invalid_event', 'result must be valid, invalid, none, or error')
      }
      if (typeof hasDurableBinding !== 'boolean') {
        throw new ProtocolError('invalid_event', 'has_durable_binding must be a boolean')
      }
      if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio' && mediaType !== 'pdf') {
        throw new ProtocolError('invalid_event', 'media_type must be image, video, audio, or pdf')
      }
      return {
        name,
        params: {
          result,
          has_durable_binding: hasDurableBinding,
          media_type: mediaType
        }
      }
    }

    case 'consent_changed': {
      if (!hasExactKeys(p, ['value'])) {
        throw new ProtocolError('invalid_event', 'consent_changed params must only contain value')
      }
      const value = p.value
      if (value !== 'granted' && value !== 'denied') {
        throw new ProtocolError('invalid_event', 'consent_changed value must be granted or denied')
      }
      return { name, params: { value } }
    }

    default:
      throw new ProtocolError('invalid_event', `Unknown event name: ${name}`)
  }
}
