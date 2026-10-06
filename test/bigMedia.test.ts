/*
 *  Reading a large video over the network in pieces (#197): only the bytes that
 *  are needed are asked for, by HTTP range request, and every request goes
 *  through the same guard as any other fetch.
 *  Run with:  bun test test/bigMedia.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { probeLarge, rangeSource, credentialStub, applyContentsCheck } from '../src/bigMedia'
import { topLevelBoxes, readCredentialBox, checkContents, blobSource } from '../src/bmffVerify'
import { parseBmffHeader } from '../src/certs/bmff'

const signed = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'durable-video', 'pattern-signed.mp4')))
const PAGE = 'https://news.example.com/story'
const URL_ = 'https://cdn.example.com/video.mp4'

/** A server holding `bytes` that honours range requests, and records them. */
function server (bytes: Uint8Array, opts: { ranges?: boolean, redirectTo?: string } = {}): { fetch: typeof fetch, calls: Array<{ range: string | null, credentials?: string, redirect?: string }> } {
  const calls: Array<{ range: string | null, credentials?: string, redirect?: string }> = []
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const range = new Headers(init?.headers).get('range')
    calls.push({ range, credentials: init?.credentials, redirect: init?.redirect })
    const made = (body: Uint8Array, status: number, headers: Record<string, string>): Response => {
      const r = new Response(body, { status, headers })
      Object.defineProperty(r, 'url', { value: opts.redirectTo ?? url })
      Object.defineProperty(r, 'redirected', { value: opts.redirectTo != null })
      return r
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (m == null || opts.ranges === false) return made(bytes, 200, { 'content-length': String(bytes.length) })
    const start = Number(m[1]); const end = Math.min(bytes.length - 1, Number(m[2]))
    return made(bytes.slice(start, end + 1), 206, { 'content-range': `bytes ${start}-${end}/${bytes.length}` })
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

describe('probeLarge', () => {
  it('learns the size of an MP4 from a 16-byte request, without cookies', async () => {
    const s = server(signed)
    expect(await probeLarge(URL_, { pageUrl: PAGE, userAsked: true, fetchImpl: s.fetch })).toEqual({ size: signed.length })
    expect(s.calls).toEqual([{ range: 'bytes=0-15', credentials: 'omit', redirect: 'follow' }])
  })

  it('says no for a server that ignores ranges, for a file that is not MP4, and for an address it may not fetch', async () => {
    expect(await probeLarge(URL_, { pageUrl: PAGE, userAsked: true, fetchImpl: server(signed, { ranges: false }).fetch })).toBeNull()
    expect(await probeLarge(URL_, { pageUrl: PAGE, userAsked: true, fetchImpl: server(new Uint8Array(4000).fill(7)).fetch })).toBeNull()
    const local = server(signed)
    expect(await probeLarge('http://192.168.1.5/video.mp4', { pageUrl: PAGE, userAsked: true, fetchImpl: local.fetch })).toBeNull()
    expect(local.calls).toEqual([])
  })

  it('does not follow redirects when nobody asked, and refuses a redirect that lands on a private address', async () => {
    const s = server(signed)
    await probeLarge(URL_, { pageUrl: PAGE, userAsked: false, fetchImpl: s.fetch })
    expect(s.calls[0].redirect).toBe('error')
    expect(await probeLarge(URL_, { pageUrl: PAGE, userAsked: true, fetchImpl: server(signed, { redirectTo: 'http://127.0.0.1/x.mp4' }).fetch })).toBeNull()
  })
})

describe('rangeSource', () => {
  it('serves exactly the bytes asked for', async () => {
    const s = server(signed)
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: s.fetch })
    expect([...await source.read(100, 132)]).toEqual([...signed.slice(100, 132)])
    expect(s.calls[0].range).toBe('bytes=100-131')
  })

  it('reads the credential out of a remote file in a few small requests', async () => {
    const s = server(signed)
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: s.fetch })
    const boxes = await topLevelBoxes(source)
    const found = await readCredentialBox(source, boxes)
    expect(found).not.toBeNull()
    expect(s.calls.length).toBeLessThan(12)
  })

  it('checks a remote file\'s contents and reaches the same answer as for a local one', async () => {
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: server(signed).fetch })
    expect((await checkContents(source, { chunkBytes: 16 * 1024 })).result).toBe('match')
  })

  it('refuses a server that answers with something other than the range asked for', async () => {
    const whole = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: server(signed, { ranges: false }).fetch })
    await expect(whole.read(0, 16)).rejects.toThrow(/range/i)
  })

  it('refuses when a later request is redirected to a private address', async () => {
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: server(signed, { redirectTo: 'http://10.0.0.5/x' }).fetch })
    await expect(source.read(0, 16)).rejects.toThrow(/private/i)
  })

  it('stops after a set number of requests, so a file of countless tiny boxes cannot make it ask forever', async () => {
    const s = server(signed)
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: s.fetch, maxRequests: 3 })
    await source.read(0, 8); await source.read(8, 16); await source.read(16, 24)
    await expect(source.read(24, 32)).rejects.toThrow(/too many/i)
  })
})

describe('credentialStub', () => {
  it('is a tiny MP4 that carries the same credential, so the engine can read it', async () => {
    const source = blobSource(new Blob([signed]))
    const boxes = await topLevelBoxes(source)
    const stub = await credentialStub(source, boxes)
    expect(stub).not.toBeNull()
    expect(stub!.type).toBe('video/mp4')
    expect(stub!.size).toBeLessThan(20_000)
    const bytes = new Uint8Array(await stub!.arrayBuffer())
    const again = await readCredentialBox(blobSource(new Blob([bytes])))
    const original = await readCredentialBox(source, boxes)
    expect([...again!.jumbf]).toEqual([...original!.jumbf])
    expect(parseBmffHeader(bytes)).not.toBeNull()
  })

  it('is null for a file with no credential', async () => {
    const plain = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'durable-video', 'scene.mp4')))
    const source = blobSource(new Blob([plain]))
    expect(await credentialStub(source, await topLevelBoxes(source))).toBeNull()
  })
})

describe('applyContentsCheck', () => {
  const engineSaid = ['signingCredential.untrusted', 'assertion.bmffHash.mismatch']
  it('drops the engine\'s contents verdict (it only saw the stub) and puts ours in its place', () => {
    expect(applyContentsCheck(engineSaid, 'verified')).toEqual(['signingCredential.untrusted'])
    expect(applyContentsCheck(engineSaid, 'not-checked')).toEqual(['signingCredential.untrusted'])
    expect(applyContentsCheck(engineSaid, 'changed')).toEqual(['signingCredential.untrusted', 'assertion.bmffHash.mismatch'])
    expect(applyContentsCheck(['signingCredential.untrusted'], 'changed')).toEqual(['signingCredential.untrusted', 'assertion.bmffHash.mismatch'])
  })
})

describe('contentsNote', () => {
  it('says plainly what was and was not checked', async () => {
    const { contentsNote } = await import('../src/bigMedia')
    const GB = 1024 * 1024 * 1024
    expect(contentsNote({ state: 'verified', bytes: 2.4 * GB })).toBe('Contents checked: all 2.4 GB of this file match its credential.')
    const unchecked = contentsNote({ state: 'not-checked', bytes: 2.4 * GB })
    expect(unchecked).toMatch(/^Contents not checked\./)
    expect(unchecked).toMatch(/2\.4 GB/)
    expect(unchecked).toMatch(/Right-click it and choose Verify/)
    expect(unchecked).toMatch(/not that this copy is unchanged/)
    expect(contentsNote({ state: 'not-checked', bytes: 700 * 1024 * 1024, note: 'the credential uses per-fragment hashes' })).toMatch(/^Contents not checked: the credential uses per-fragment hashes\. .*not that this copy is unchanged/)
    expect(contentsNote({ state: 'changed', bytes: GB })).toMatch(/does not match its credential/)
  })
})

// Forge pass 5, FINDING-02: a server that answers a small range with a huge body.
describe('rangeSource against an oversized answer', () => {
  const lying = (declaredEnd: number, bodyBytes: number): typeof fetch => (async (url: string) => {
    const r = new Response(new Uint8Array(bodyBytes), { status: 206, headers: { 'content-range': `bytes 0-${declaredEnd}/${signed.length}` } })
    Object.defineProperty(r, 'url', { value: url })
    return r
  }) as unknown as typeof fetch

  it('refuses a header that claims more than was asked for, before reading the body', async () => {
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: lying(50_000, 50_001) })
    await expect(source.read(0, 16)).rejects.toThrow(/range/i)
  })

  it('stops reading a body that runs past what its own header promised', async () => {
    const source = rangeSource(URL_, signed.length, { pageUrl: PAGE, userAsked: true, fetchImpl: lying(15, 5_000_000) })
    await expect(source.read(0, 16)).rejects.toThrow(/range|large/i)
  })
})

// Forge pass 5, FINDING-03: the contents hash must come from the manifest the engine calls active.
describe('hashAssertionOf by label', () => {
  it('takes the named manifest, and refuses a name that is not in the store', async () => {
    const { hashAssertionOf: byLabel } = await import('../src/bmffVerify')
    const { decode } = await import('../src/certs/jumbf')
    const found = await readCredentialBox(blobSource(new Blob([signed])))
    const labels = decode(found!.jumbf).boxes.map((b) => (b as { label?: string }).label)
    expect(byLabel(found!.jumbf, labels[labels.length - 1])).not.toBeNull()
    expect(byLabel(found!.jumbf, 'urn:uuid:not-in-this-store')).toBeNull()
  })
})
