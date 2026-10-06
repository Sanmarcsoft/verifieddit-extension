/*
 * What the extension will fetch on a page's say-so, and how much of it.
 *
 * The engine fetches media from the background / offscreen context, which the
 * browser exempts from cross-origin and private-network rules. A web page
 * chooses the URLs (any <img> or <video> it shows), so without a guard a public
 * page could make the extension send requests to the reader's own machine or
 * network: a router, a NAS, a cloud metadata address, a local development
 * server. The response is never handed back to the page, but the request alone
 * can change state on a service that trusts its network.
 *
 * The rule is the browser's own for pages: a public page may not reach a
 * private address; a page that is itself on the reader's machine or network
 * may. Hostnames are judged as written. A public name that resolves to a
 * private address (DNS rebinding) is not caught here; nothing in an extension
 * can see the resolved address before the request is made.
 *
 * Free of imports and side effects, so it can be tested without a browser.
 */

/** No single file the extension verifies needs more than this in memory. */
export const MEDIA_MAX_BYTES = 512 * 1024 * 1024

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet', '.corp', '.home.arpa']

function ipv4Private (a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
}

/** The hostname as the browser will read it: 2130706433 and 0x7f.1 are 127.0.0.1. */
function canonicalHost (host: string): string | null {
  try {
    const bare = host.trim().replace(/^\[|\]$/g, '')
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True for the reader's own machine and network. Unparseable hosts count as private. */
export function isPrivateHost (host: string): boolean {
  const name = canonicalHost(host)
  if (name == null || name === '') return true

  if (name.startsWith('[')) {
    const v6 = name.slice(1, -1)
    if (v6 === '::' || v6 === '::1') return true
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (mapped != null) {
      const high = parseInt(mapped[1], 16)
      return ipv4Private(high >> 8, high & 0xff)
    }
    const first = parseInt(v6.split(':')[0] === '' ? '0' : v6.split(':')[0], 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 // unique local, link-local
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (v4 != null) return ipv4Private(Number(v4[1]), Number(v4[2]))

  if (name === 'localhost' || !name.includes('.')) return true // a bare name is a machine on the local network
  return PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Whether the page asking is itself on the reader's machine or network. */
function pageIsPrivate (pageUrl: string | undefined): boolean {
  if (pageUrl == null || pageUrl === '') return false
  try {
    const page = new URL(pageUrl)
    if (page.protocol === 'file:') return true
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return false
    return isPrivateHost(page.hostname)
  } catch {
    return false
  }
}

/**
 * May the extension fetch `mediaUrl` for a page at `pageUrl`? Only http(s), and
 * a private address only for a page that is private too. `data:` is allowed: it
 * carries its own bytes and touches no network.
 */
export function mediaFetchAllowed (mediaUrl: string, pageUrl: string | undefined): { ok: true } | { ok: false, reason: string } {
  let media: URL
  try {
    media = new URL(mediaUrl)
  } catch {
    return { ok: false, reason: 'not a valid address' }
  }
  if (media.protocol === 'data:') return { ok: true }
  if (media.protocol !== 'http:' && media.protocol !== 'https:') {
    return { ok: false, reason: `${media.protocol} addresses are not fetched` }
  }
  if (isPrivateHost(media.hostname) && !pageIsPrivate(pageUrl)) {
    return { ok: false, reason: 'a public page may not make the extension fetch from a private address' }
  }
  return { ok: true }
}

/**
 * Read a response into a Blob, refusing more than `maxBytes`. The declared
 * length is checked before anything is read; the body is then counted as it
 * arrives, because a length can be wrong or missing.
 */
export async function readCapped (response: Response, maxBytes: number = MEDIA_MAX_BYTES): Promise<Blob> {
  const tooLarge = (): Error => new Error(`File too large to verify (over ${Math.round(maxBytes / (1024 * 1024))} MB)`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  if (response.body == null) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw tooLarge()
    return blob
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  return new Blob(chunks, { type })
}

/** A link that may be put in an href: http or https and nothing else. */
export function isWebLink (url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && /^https?:\/\//i.test(url)
  } catch {
    return false
  }
}
