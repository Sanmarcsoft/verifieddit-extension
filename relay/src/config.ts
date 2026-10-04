export interface RelayConfig {
  ticketKey: string
  umamiUrl: string
  umamiWebsiteId: string
  port: number
}

const MIN_KEY_BYTES = 32
const DEFAULT_PORT = 3000

export function loadConfig (env: Record<string, string | undefined>): RelayConfig {
  const ticketKey = env.RELAY_TICKET_KEY
  if (ticketKey == null || new TextEncoder().encode(ticketKey).byteLength < MIN_KEY_BYTES) {
    throw new Error('RELAY_TICKET_KEY is required and must be at least 32 bytes')
  }

  const rawUmamiUrl = env.UMAMI_URL
  if (rawUmamiUrl == null || rawUmamiUrl.trim().length === 0) {
    throw new Error('UMAMI_URL is required')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUmamiUrl)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('invalid protocol')
    }
  } catch {
    throw new Error('UMAMI_URL must be a valid HTTP or HTTPS URL')
  }

  const umamiUrl = parsedUrl.origin + (parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/+$/, ''))

  const umamiWebsiteId = env.UMAMI_WEBSITE_ID
  if (umamiWebsiteId == null || umamiWebsiteId.trim().length === 0) {
    throw new Error('UMAMI_WEBSITE_ID is required')
  }

  let port = DEFAULT_PORT
  if (env.PORT != null && env.PORT.trim().length > 0) {
    const parsedPort = Number(env.PORT)
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error('PORT must be a valid integer')
    }
    port = parsedPort
  }

  return {
    ticketKey,
    umamiUrl,
    umamiWebsiteId,
    port
  }
}
