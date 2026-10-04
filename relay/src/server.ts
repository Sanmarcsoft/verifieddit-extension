import type { RelayConfig } from './config'
import { InMemoryEraser, type Eraser } from './eraser'
import {
  canonicaliseErasurePayload,
  canonicaliseEventPayload,
  computeJwkThumbprint,
  createTicket,
  validateEvent,
  validatePublicJwk,
  validateTimestamp,
  validateVersion,
  verifyEcdsaSignature,
  verifyTicket
} from './protocol'
import { RateLimiter } from './rateLimiter'

export interface HandlerDependencies {
  config: RelayConfig
  rateLimiter?: RateLimiter
  eraser?: Eraser
  fetch?: typeof fetch
  now?: () => number
}

const MAX_BODY_BYTES = 8192
const FORWARD_TIMEOUT_MS = 5000
const TICKET_TTL_MS = 10 * 60 * 1000 // 10 minutes

function createJsonResponse (
  data: Record<string, unknown>,
  status: number,
  origin: string | null
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json'
  })

  if (origin != null && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type')
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  })
}

async function parseJsonBody (
  req: Request
): Promise<{ ok: true, data: Record<string, unknown> } | { ok: false, status: number, error: string }> {
  const contentLength = req.headers.get('content-length')
  if (contentLength != null) {
    const length = Number(contentLength)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return { ok: false, status: 400, error: 'payload_too_large' }
    }
  }

  let rawBytes: Uint8Array
  try {
    const buffer = await req.arrayBuffer()
    rawBytes = new Uint8Array(buffer)
  } catch {
    return { ok: false, status: 400, error: 'malformed_json' }
  }

  if (rawBytes.byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 400, error: 'payload_too_large' }
  }

  const text = new TextDecoder().decode(rawBytes)
  if (text.trim().length === 0) {
    return { ok: false, status: 400, error: 'malformed_json' }
  }

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'malformed_json' }
    }
    return { ok: true, data: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400, error: 'malformed_json' }
  }
}

export function createHandler (deps: HandlerDependencies) {
  const config = deps.config
  const rateLimiter = deps.rateLimiter ?? new RateLimiter()
  const eraser = deps.eraser ?? new InMemoryEraser()
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now

  return async function handleRequest (req: Request, clientAddress: string): Promise<Response> {
    const origin = req.headers.get('Origin')
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      const headers = new Headers()
      if (origin != null && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        headers.set('Access-Control-Allow-Headers', 'Content-Type')
      }
      return new Response(null, { status: 204, headers })
    }

    if (path === '/healthz') {
      if (req.method !== 'GET') {
        return createJsonResponse({ error: 'method_not_allowed' }, 405, origin)
      }
      return createJsonResponse({ status: 'ok' }, 200, origin)
    }

    if (path === '/v1/installs') {
      if (req.method === 'POST') {
        const allowed = await rateLimiter.isAllowed(clientAddress)
        if (!allowed) {
          return createJsonResponse({ error: 'rate_limited' }, 429, origin)
        }

        const bodyResult = await parseJsonBody(req)
        if (!bodyResult.ok) {
          return createJsonResponse({ error: bodyResult.error }, bodyResult.status, origin)
        }

        const body = bodyResult.data
        if (!('jwk' in body)) {
          return createJsonResponse({ error: 'invalid_key' }, 400, origin)
        }

        let thumbprint: string
        try {
          const publicJwk = validatePublicJwk(body.jwk)
          thumbprint = await computeJwkThumbprint(publicJwk)
        } catch {
          return createJsonResponse({ error: 'invalid_key' }, 400, origin)
        }

        const expiresAt = now() + TICKET_TTL_MS
        const ticket = await createTicket(config.ticketKey, thumbprint, expiresAt)

        return createJsonResponse(
          {
            install_id: thumbprint,
            ticket,
            expires_at: expiresAt
          },
          200,
          origin
        )
      }

      if (req.method === 'DELETE') {
        const bodyResult = await parseJsonBody(req)
        if (!bodyResult.ok) {
          return createJsonResponse({ error: bodyResult.error }, bodyResult.status, origin)
        }

        const body = bodyResult.data
        const { install_id: installId, ticket, ts, sig, jwk } = body

        if (
          typeof installId !== 'string' ||
          typeof ticket !== 'string' ||
          typeof ts !== 'number' ||
          typeof sig !== 'string' ||
          jwk == null
        ) {
          return createJsonResponse({ error: 'invalid_signature' }, 400, origin)
        }

        let publicJwk
        let thumbprint: string
        try {
          publicJwk = validatePublicJwk(jwk)
          thumbprint = await computeJwkThumbprint(publicJwk)
        } catch {
          return createJsonResponse({ error: 'invalid_key' }, 400, origin)
        }

        if (thumbprint !== installId) {
          return createJsonResponse({ error: 'invalid_install_id' }, 400, origin)
        }

        const isTicketValid = await verifyTicket(config.ticketKey, installId, ticket, now())
        if (!isTicketValid) {
          return createJsonResponse({ error: 'invalid_ticket' }, 400, origin)
        }

        if (!validateTimestamp(ts, now())) {
          return createJsonResponse({ error: 'invalid_timestamp' }, 400, origin)
        }

        const canonical = canonicaliseErasurePayload({ install_id: installId, ts })
        const isSigValid = await verifyEcdsaSignature(
          publicJwk,
          sig,
          new TextEncoder().encode(canonical)
        )
        if (!isSigValid) {
          return createJsonResponse({ error: 'invalid_signature' }, 400, origin)
        }

        await eraser.erase(installId, ts)
        return createJsonResponse({ ok: true }, 200, origin)
      }

      return createJsonResponse({ error: 'method_not_allowed' }, 405, origin)
    }

    if (path === '/v1/events') {
      if (req.method !== 'POST') {
        return createJsonResponse({ error: 'method_not_allowed' }, 405, origin)
      }

      const bodyResult = await parseJsonBody(req)
      if (!bodyResult.ok) {
        return createJsonResponse({ error: bodyResult.error }, bodyResult.status, origin)
      }

      const body = bodyResult.data
      const { install_id: installId, ticket, ts, event, version, sig, jwk } = body

      if (
        typeof installId !== 'string' ||
        typeof ticket !== 'string' ||
        typeof ts !== 'number' ||
        typeof version !== 'string' ||
        typeof sig !== 'string' ||
        jwk == null ||
        event == null
      ) {
        return createJsonResponse({ error: 'invalid_event' }, 400, origin)
      }

      let publicJwk
      let thumbprint: string
      try {
        publicJwk = validatePublicJwk(jwk)
        thumbprint = await computeJwkThumbprint(publicJwk)
      } catch {
        return createJsonResponse({ error: 'invalid_key' }, 400, origin)
      }

      if (thumbprint !== installId) {
        return createJsonResponse({ error: 'invalid_install_id' }, 400, origin)
      }

      const isTicketValid = await verifyTicket(config.ticketKey, installId, ticket, now())
      if (!isTicketValid) {
        return createJsonResponse({ error: 'invalid_ticket' }, 400, origin)
      }

      if (!validateTimestamp(ts, now())) {
        return createJsonResponse({ error: 'invalid_timestamp' }, 400, origin)
      }

      let validVersion: string
      try {
        validVersion = validateVersion(version)
      } catch {
        return createJsonResponse({ error: 'invalid_version' }, 400, origin)
      }

      let validatedEvent
      try {
        validatedEvent = validateEvent(event)
      } catch {
        return createJsonResponse({ error: 'invalid_event' }, 400, origin)
      }

      const canonical = canonicaliseEventPayload({
        install_id: installId,
        ts,
        event: validatedEvent,
        version: validVersion
      })

      const isSigValid = await verifyEcdsaSignature(
        publicJwk,
        sig,
        new TextEncoder().encode(canonical)
      )
      if (!isSigValid) {
        return createJsonResponse({ error: 'invalid_signature' }, 400, origin)
      }

      const forwardUrl = `${config.umamiUrl}/api/send`
      const forwardBody = {
        type: 'event',
        payload: {
          website: config.umamiWebsiteId,
          hostname: 'extension.verifieddit.com',
          url: '/' + validatedEvent.name,
          name: validatedEvent.name,
          data: {
            ...validatedEvent.params,
            extension_version: validVersion
          },
          id: installId
        }
      }

      try {
        const response = await fetchImpl(forwardUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'verifieddit-telemetry-relay/1'
          },
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
        })

        if (!response.ok) {
          return createJsonResponse({ error: 'upstream_failed' }, 502, origin)
        }
      } catch {
        return createJsonResponse({ error: 'upstream_failed' }, 502, origin)
      }

      return createJsonResponse({ ok: true }, 200, origin)
    }

    return createJsonResponse({ error: 'not_found' }, 404, origin)
  }
}
