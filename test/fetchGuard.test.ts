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
