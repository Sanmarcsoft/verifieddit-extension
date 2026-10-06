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
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking, used inside networks
    a >= 224 // multicast, reserved, broadcast
}

/** The hostname as the browser will read it: 2130706433 and 0x7f.1 are 127.0.0.1. */
function canonicalHost (host: string): string | null {
  try {
    const bare = host.trim().replace(/\.+$/, '').replace(/^\[|\]$/g, '')
    // A trailing dot is the same host to a resolver ("localhost.").
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return null
  }
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function expandIpv6 (text: string): number[] | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN))
    return groups.some(Number.isNaN) ? null : groups
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (head == null || tail == null) return null
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** True for the reader's own machine and network. Unparseable hosts count as private. */
export function isPrivateHost (host: string): boolean {
  const name = canonicalHost(host)
  if (name == null || name === '') return true

  if (name.startsWith('[')) {
    const h = expandIpv6(name.slice(1, -1))
    if (h == null) return true
    const v4 = (high: number, low: number): boolean => ipv4Private(high >> 8, high & 0xff) && low >= 0
    const leadingZero = h.slice(0, 5).every((x) => x === 0)
    if (leadingZero && h[5] === 0 && h[6] === 0 && h[7] <= 1) return true // :: and ::1
    if (leadingZero && (h[5] === 0 || h[5] === 0xffff)) return v4(h[6], h[7]) // IPv4-compatible, IPv4-mapped
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4(h[6], h[7]) // NAT64
    if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return v4(h[6], h[7]) // IPv4-translated
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true // NAT64 for local use
    if (h[0] === 0x2001 && h[1] === 0) return true // Teredo tunnels
    if ((h[0] & 0xff00) === 0xff00) return true // multicast
    if (h[0] === 0x2002) return v4(h[1], h[2]) // 6to4
    return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 // unique local, link-local
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
/** A download that sends nothing for this long has stalled. */
export const MEDIA_IDLE_MS = 30_000

export async function readCapped (
  response: Response,
  maxBytes: number = MEDIA_MAX_BYTES,
  userAsked = true,
  opts: { idleMs?: number, onStall?: () => void } = {}
): Promise<Blob> {
  const idleMs = opts.idleMs ?? MEDIA_IDLE_MS
  const mb = (bytes: number): string => bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`
  // Two different facts: this device cannot hold the file, or nobody asked for
  // it and automatic scanning does not fetch large files. The second has a remedy.
  const tooLarge = (size?: number): Error => new Error(userAsked
    ? `File too large to verify here${size != null ? `: it is ${mb(size)}, and` : ':'} the limit on this device is ${mb(maxBytes)}`
    : `Automatic scanning skips files over ${mb(maxBytes)}${size != null ? ` (this one is ${mb(size)})` : ''}. Right-click it and choose Verify to check it.`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared)
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  if (response.body == null) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw tooLarge()
    return blob
  }
  // Count the bytes as they pass, and let the browser build the Blob. It keeps
  // a large Blob on disk rather than in memory; collecting the chunks here would
  // hold the whole file in memory twice.
  // A server that sends headers and then nothing must not hold a place in the
  // queue forever: no bytes for `idleMs` ends the read. A slow, steady download
  // is fine; only silence counts.
  let total = 0
  let stalled: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const stall = new Promise<never>((_resolve, reject) => {
    stalled = () => { reject(new Error('Download stalled: the server stopped sending')) }
  })
  const kick = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => { opts.onStall?.(); stalled?.() }, idleMs)
  }
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start () { kick() },
    transform (chunk, controller) {
      kick()
      total += chunk.byteLength
      if (total > maxBytes) { controller.error(tooLarge()); return }
      controller.enqueue(chunk)
    }
  }))
  let blob: Blob
  try {
    blob = await Promise.race([new Response(counted).blob(), stall])
  } catch (error) {
    void response.body.cancel().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
  return type === '' || blob.type === type ? blob : new Blob([blob], { type })
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

const GB = 1024 * 1024 * 1024
/** Enough for any picture, whatever the device reports. */
export const MEDIA_FLOOR_BYTES = 64 * 1024 * 1024
/** No device is asked to hold more than this for one file. */
export const MEDIA_TOP_BYTES = 8 * GB
/** For a file nobody asked about (auto-scan): a page must not be able to make the browser pull gigabytes. */
export const MEDIA_UNASKED_BYTES = 100 * 1024 * 1024

/**
 * How large a file this device can take. The browser builds a large Blob on
 * disk, so the room that matters is what it says this extension may store. A
 * quarter of what is free leaves space for the engine's own working copy and
 * for other files in flight. When the browser will not say, the fixed
 * MEDIA_MAX_BYTES applies. A file the reader did not ask about gets a low
 * ceiling regardless.
 */
export async function mediaCeiling (opts: { userAsked: boolean, estimate?: () => Promise<{ quota?: number, usage?: number }> }): Promise<number> {
  if (!opts.userAsked) return MEDIA_UNASKED_BYTES
  try {
    const estimate = opts.estimate ?? (async () => await navigator.storage.estimate())
    const { quota, usage } = await estimate()
    if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return MEDIA_MAX_BYTES
    const free = quota - (typeof usage === 'number' ? usage : 0)
    return Math.min(MEDIA_TOP_BYTES, Math.max(MEDIA_FLOOR_BYTES, Math.floor(free / 4)))
  } catch {
    return MEDIA_MAX_BYTES
  }
}

/**
 * Run at most `max` jobs at a time, the rest in the order they came. A page
 * with twenty large files must not start twenty downloads at once.
 */
export function limiter (max: number, maxWaiting = 200): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  const next = (): void => { active--; waiting.shift()?.() }
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      // A queue that only grows is its own problem; refuse rather than hoard.
      if (waiting.length >= maxWaiting) throw new Error('Too many files waiting to be checked')
      await new Promise<void>((resolve) => { waiting.push(resolve) })
    }
    active++
    try {
      return await job()
    } finally {
      next()
    }
  }
}

/**
 * Whether a fetch follows redirects. The address check covers the address as
 * written; a redirect could lead from a public address to a private one. So a
 * fetch nobody asked for (auto-scan) does not follow redirects at all. One the
 * reader asked for does, and the address it ended at is checked before the
 * response is used (see mediaFetchAllowed on response.url).
 */
export function redirectPolicy (userAsked: boolean): 'follow' | 'error' {
  return userAsked ? 'follow' : 'error'
}
