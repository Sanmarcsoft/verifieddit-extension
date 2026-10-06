/*
 *  What the extension will fetch on a page's say-so (Forge F1, F2). The engine
 *  fetches media from a context that is exempt from the browser's cross-origin
 *  and private-network rules, so a public page must not be able to point it at
 *  the reader's own machine or network, and no response may be read without a
 *  ceiling.
 *  Run with:  bun test test/fetchGuard.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { isPrivateHost, mediaFetchAllowed, readCapped, MEDIA_MAX_BYTES } from '../src/fetchGuard'

describe('isPrivateHost', () => {
  it('knows the reader\'s own machine and network', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.8.9.10', '0.0.0.0', '10.0.0.12', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[::1]', '::1', '[fd12:3456::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', 'printer.local', 'nas.internal', 'router.lan', 'intranet']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
  })

  it('leaves the public internet alone', () => {
    for (const h of ['example.com', 'www.verifieddit.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '[2606:4700::1111]', 'localhost.example.com', '100.128.0.1']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
  })

  it('is not fooled by other ways of writing 127.0.0.1', () => {
    for (const h of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.1']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
  })
})

describe('mediaFetchAllowed', () => {
  const page = 'https://news.example.com/story'

  it('allows ordinary web media from an ordinary page', () => {
    expect(mediaFetchAllowed('https://cdn.example.com/a.jpg', page)).toEqual({ ok: true })
    expect(mediaFetchAllowed('http://cdn.example.com/a.mp4', page)).toEqual({ ok: true })
  })

  it('refuses anything that is not http or https', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/a.jpg', 'chrome://settings', 'chrome-extension://abc/x.png', 'javascript:alert(1)', 'blob:https://example.com/1', 'not a url', '']) {
      expect(mediaFetchAllowed(u, page).ok, u).toBe(false)
    }
  })

  it('refuses a public page pointing the extension at the reader\'s machine or network', () => {
    for (const u of ['http://127.0.0.1:11434/api/tags', 'http://localhost:8080/x.jpg', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.12:9000/api', 'http://192.168.1.1/admin.png', 'http://[::1]:3000/x.png', 'http://2130706433/x.png']) {
      const out = mediaFetchAllowed(u, page)
      expect(out.ok, u).toBe(false)
      expect(out.reason).toMatch(/private/i)
    }
  })

  it('refuses the same when the page is unknown', () => {
    expect(mediaFetchAllowed('http://localhost:8080/x.jpg', undefined).ok).toBe(false)
    expect(mediaFetchAllowed('http://localhost:8080/x.jpg', 'about:blank').ok).toBe(false)
  })

  it('lets a page on the reader\'s own machine or network use media from there, as a browser does', () => {
    expect(mediaFetchAllowed('http://localhost:8080/video.mp4', 'http://localhost:8080/video.html')).toEqual({ ok: true })
    expect(mediaFetchAllowed('http://10.0.0.12/cam.jpg', 'http://nas.local/index.html')).toEqual({ ok: true })
    expect(mediaFetchAllowed('http://localhost:3000/a.jpg', 'file:///home/matt/test.html')).toEqual({ ok: true })
  })

  it('lets embedded data: media through, which touches no network', () => {
    expect(mediaFetchAllowed('data:image/png;base64,AAAA', page)).toEqual({ ok: true })
  })
})

describe('readCapped', () => {
  const stream = (chunks: number[]): ReadableStream<Uint8Array> => new ReadableStream({
    start (controller) { for (const n of chunks) controller.enqueue(new Uint8Array(n)); controller.close() }
  })
  const response = (chunks: number[], headers: Record<string, string> = {}): Response =>
    new Response(stream(chunks), { headers: { 'content-type': 'video/mp4', ...headers } })

  it('reads a file under the ceiling and keeps its type', async () => {
    const blob = await readCapped(response([100, 200]), 1000)
    expect(blob.size).toBe(300)
    expect(blob.type).toBe('video/mp4')
  })

  it('refuses on the declared length alone, before reading a byte', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({ pull (c) { pulled++; c.enqueue(new Uint8Array(10)); c.close() } }, { highWaterMark: 0 })
    const r = new Response(body, { headers: { 'content-length': '5000' } })
    await expect(readCapped(r, 1000)).rejects.toThrow(/too large/i)
    expect(pulled).toBe(0)
  })

  it('stops a response that lies about, or does not state, its length', async () => {
    await expect(readCapped(response([400, 400, 400]), 1000)).rejects.toThrow(/too large/i)
    await expect(readCapped(response([400, 400, 400], { 'content-length': '10' }), 1000)).rejects.toThrow(/too large/i)
  })

  it('says which limit it was, and what to do about the one that has a remedy', async () => {
    const big = (): Response => new Response(new Blob([new Uint8Array(10)]).stream(), { headers: { 'content-length': String(300 * 1024 * 1024) } })
    await expect(readCapped(big(), 100 * 1024 * 1024, true)).rejects.toThrow(/it is 300 MB, and the limit on this device is 100 MB/)
    await expect(readCapped(big(), 100 * 1024 * 1024, false)).rejects.toThrow(/Automatic scanning skips files over 100 MB \(this one is 300 MB\)\. Right-click it and choose Verify/)
  })

  it('has a ceiling that still fits real video', () => {
    expect(MEDIA_MAX_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024)
    expect(MEDIA_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024)
  })
})

describe('isWebLink', () => {
  it('accepts only http and https, so a trust list cannot plant a script link', async () => {
    const { isWebLink } = await import('../src/fetchGuard')
    for (const u of ['https://c2pa.org', 'http://example.com/list', 'HTTPS://EXAMPLE.COM']) expect(isWebLink(u), u).toBe(true)
    for (const u of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', '//example.com', 'example.com', '', undefined, null]) expect(isWebLink(u as string), String(u)).toBe(false)
  })
})

// Forge pass 2, N2: spellings of a private address the first version let through.
describe('isPrivateHost, second pass', () => {
  it('is not fooled by a trailing dot', () => {
    for (const h of ['localhost.', 'printer.local.', '127.0.0.1.', 'nas.internal..']) expect(isPrivateHost(h), h).toBe(true)
    expect(isPrivateHost('example.com.')).toBe(false)
  })

  it('sees an IPv4 address carried inside an IPv6 one', () => {
    for (const h of ['[::127.0.0.1]', '[::7f00:1]', '[64:ff9b::7f00:1]', '[64:ff9b::a00:c]', '[2002:7f00:1::1]', '[2002:c0a8:101::]', '[::ffff:c0a8:101]']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['[64:ff9b::808:808]', '[2002:808:808::1]', '[2001:db8::1]']) expect(isPrivateHost(h), h).toBe(false)
  })
})

// M, 2026-10-06: the ceiling comes from the device, not from a number I picked.
describe('mediaCeiling', () => {
  const GB = 1024 * 1024 * 1024
  it('takes a quarter of what the browser says it can store, for a file the reader asked about', async () => {
    const { mediaCeiling } = await import('../src/fetchGuard')
    expect(await mediaCeiling({ userAsked: true, estimate: async () => ({ quota: 10 * GB, usage: 2 * GB }) })).toBe(2 * GB)
  })

  it('never goes below a floor that fits ordinary pictures, nor above a sane top', async () => {
    const { mediaCeiling, MEDIA_FLOOR_BYTES, MEDIA_TOP_BYTES } = await import('../src/fetchGuard')
    expect(await mediaCeiling({ userAsked: true, estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 99 * 1024 * 1024 }) })).toBe(MEDIA_FLOOR_BYTES)
    expect(await mediaCeiling({ userAsked: true, estimate: async () => ({ quota: 5000 * GB, usage: 0 }) })).toBe(MEDIA_TOP_BYTES)
  })

  it('falls back to a fixed ceiling when the browser will not say', async () => {
    const { mediaCeiling, MEDIA_MAX_BYTES } = await import('../src/fetchGuard')
    expect(await mediaCeiling({ userAsked: true, estimate: async () => { throw new Error('no') } })).toBe(MEDIA_MAX_BYTES)
    expect(await mediaCeiling({ userAsked: true, estimate: async () => ({}) })).toBe(MEDIA_MAX_BYTES)
  })

  it('is much lower for a file nobody asked about (auto-scan), whatever the device', async () => {
    const { mediaCeiling, MEDIA_UNASKED_BYTES } = await import('../src/fetchGuard')
    expect(await mediaCeiling({ userAsked: false, estimate: async () => ({ quota: 5000 * GB, usage: 0 }) })).toBe(MEDIA_UNASKED_BYTES)
    expect(MEDIA_UNASKED_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024)
  })
})

// Forge pass 2, N3: a page with twenty large files must not start twenty downloads at once.
describe('limiter', () => {
  it('runs at most N at a time and the rest in order', async () => {
    const { limiter } = await import('../src/fetchGuard')
    const run = limiter(2)
    let active = 0; let peak = 0; const order: number[] = []
    const job = (i: number) => async (): Promise<number> => {
      active++; peak = Math.max(peak, active); order.push(i)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return i
    }
    const out = await Promise.all([0, 1, 2, 3, 4, 5].map(async (i) => await run(job(i))))
    expect(out).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(2)
    expect(order).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('a job that fails frees its place', async () => {
    const { limiter } = await import('../src/fetchGuard')
    const run = limiter(1)
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run(async () => 'next')).toBe('next')
  })
})

// The redirect rule (Forge pass 2, N1).
describe('redirectPolicy', () => {
  it('a fetch nobody asked for never follows a redirect; one the reader asked for does, and is checked after', async () => {
    const { redirectPolicy } = await import('../src/fetchGuard')
    expect(redirectPolicy(false)).toBe('error')
    expect(redirectPolicy(true)).toBe('follow')
  })
})

// Forge pass 3, SEC-01: a server that sends headers and then nothing must not hold a place forever.
describe('stalls', () => {
  it('readCapped gives up when no bytes arrive for the idle time, and says so', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start (c) { c.enqueue(new Uint8Array(10)) } }) // never closes
    const started = Date.now()
    await expect(readCapped(new Response(stalled), 1000, true, { idleMs: 60 })).rejects.toThrow(/stalled/i)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a slow but steady download is not a stall', async () => {
    const steady = new ReadableStream<Uint8Array>({
      async start (c) { for (let i = 0; i < 5; i++) { await new Promise((resolve) => setTimeout(resolve, 30)); c.enqueue(new Uint8Array(10)) } c.close() }
    })
    expect((await readCapped(new Response(steady), 1000, true, { idleMs: 80 })).size).toBe(50)
  })

  it('the queue refuses more than it can sensibly hold instead of growing without end', async () => {
    const { limiter } = await import('../src/fetchGuard')
    const run = limiter(1, 2)
    const never = new Promise<void>(() => {})
    void run(async () => { await never })
    const waiting = [run(async () => 1), run(async () => 2)]
    await expect(run(async () => 3)).rejects.toThrow(/too many/i)
    expect(waiting.length).toBe(2)
  })
})

// Forge pass 3, SEC-03: more addresses that are not the public internet.
describe('isPrivateHost, third pass', () => {
  it('covers benchmark, multicast, broadcast, and more IPv4-in-IPv6 forms', () => {
    for (const h of ['198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.2.3', '255.255.255.255', '[ff02::1]', '[::ffff:0:7f00:1]', '[64:ff9b:1::7f00:1]', '[2001::7f00:1]']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['198.17.0.1', '198.20.0.1', '223.255.255.255', '[2001:4860:4860::8888]', '[2001:db8::1]']) expect(isPrivateHost(h), h).toBe(false)
  })
})

// Forge pass 4, SEC-01: a server that trickles a byte now and then is as bad as a silent one.
describe('trickles', () => {
  it('readCapped gives up on a download that stays far too slow, even though bytes keep arriving', async () => {
    let stop = false
    const trickle = new ReadableStream<Uint8Array>({
      async pull (c) { if (stop) { c.close(); return } await new Promise((resolve) => setTimeout(resolve, 15)); c.enqueue(new Uint8Array(1)) }
    })
    const started = Date.now()
    await expect(readCapped(new Response(trickle), 1_000_000, true, { idleMs: 500, graceMs: 80, minBytesPerSecond: 10_000 })).rejects.toThrow(/too slow/i)
    stop = true
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('an ordinary download is nowhere near the floor', async () => {
    const quick = new ReadableStream<Uint8Array>({
      async start (c) { for (let i = 0; i < 4; i++) { await new Promise((resolve) => setTimeout(resolve, 30)); c.enqueue(new Uint8Array(5000)) } c.close() }
    })
    expect((await readCapped(new Response(quick), 1_000_000, true, { idleMs: 500, graceMs: 50, minBytesPerSecond: 10_000 })).size).toBe(20000)
  })
})
