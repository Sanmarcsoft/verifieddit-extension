/*
 *  Recovering a stripped video's credential (#197), in the browser. One frame
 *  is fingerprinted on the device and the registry is asked about the hashes,
 *  exactly as for a stripped picture. The video never leaves the browser.
 *  Run with:  bun test test/recoverVideo.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

let storage: Record<string, unknown> = {}
let calls: Array<{ url: string, init: RequestInit | undefined }> = []
let matchFor: Record<string, unknown[]> = {}
const realFetch = globalThis.fetch

const frame = (seed: number): ImageData => {
  const width = 64; const height = 48
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const v = (Math.sin(i * 0.37 + seed) * 0.5 + 0.5) * 200 + 40
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
}
const video = (): Blob => new Blob([new Uint8Array(32)], { type: 'video/mp4' })

beforeEach(() => {
  storage = {}
  calls = []
  matchFor = {}
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: storage[k] }) } }
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/matches/byBinding')) {
      const value = new URL(u).searchParams.get('value') ?? ''
      return { ok: true, json: async () => ({ matches: matchFor[value] ?? [] }) }
    }
    return { ok: true, json: async () => ({ signerCn: 'sign.trusteddit.com', signedAt: '2026-10-06 12:15:00+00:00', filename: 'clip.mp4' }) }
  }) as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch })

const loadFresh = async (): Promise<typeof import('../src/manifestStore')> =>
  await import(`../src/manifestStore?t=${Date.now()}${Math.random()}`)
const fingerprintsOf = async (f: ImageData): Promise<{ whole: { phash: string, dhash: string }, centre: { phash: string, dhash: string } }> =>
  (await import('../src/videoFrame')).frameFingerprints(f)

describe('recoverVideoByFingerprint', () => {
  it('does nothing at all unless the online check is on: no frame is read, nothing is sent', async () => {
    const { recoverVideoByFingerprint } = await loadFresh()
    let grabbed = 0
    const out = await recoverVideoByFingerprint(video(), undefined, async () => { grabbed++; return frame(1) })
    expect(out).toEqual({ credential: null, checked: false })
    expect(grabbed).toBe(0)
    expect(calls).toEqual([])
  })

  it('sends hashes of one frame to the registry, and never the video', async () => {
    storage.manifestStoreProbe = true
    const { recoverVideoByFingerprint } = await loadFresh()
    const f = frame(1)
    const fp = await fingerprintsOf(f)
    await recoverVideoByFingerprint(video(), undefined, async () => f)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe('https://manifests.sanmarcsoft.com')
      expect(c.init?.method ?? 'GET').toBe('GET')
      expect(c.init?.body).toBeUndefined()
      expect(c.init?.credentials).toBe('omit')
    }
    const first = new URL(calls[0].url).searchParams
    expect([first.get('alg'), first.get('value'), first.get('crossAlg'), first.get('crossValue')]).toEqual(['phash', fp.whole.phash, 'dhash', fp.whole.dhash])
  })

  it('returns who signed the original, marked as a video', async () => {
    storage.manifestStoreProbe = true
    const { recoverVideoByFingerprint } = await loadFresh()
    const f = frame(1)
    matchFor[(await fingerprintsOf(f)).whole.phash] = [{ manifestId: 'mid-video', similarityScore: 97, algorithm: 'phash' }]
    const out = await recoverVideoByFingerprint(video(), undefined, async () => f)
    expect(out.checked).toBe(true)
    expect(out.credential?.manifestId).toBe('mid-video')
    expect(out.credential?.medium).toBe('video')
    expect(out.credential?.signerCn).toBe('sign.trusteddit.com')
    expect(out.credential?.similarityScore).toBe(97)
  })

  it('tries the centre of the frame when the whole frame finds nothing (a logo was stamped on it)', async () => {
    storage.manifestStoreProbe = true
    const { recoverVideoByFingerprint } = await loadFresh()
    const f = frame(2)
    const fp = await fingerprintsOf(f)
    matchFor[fp.centre.phash] = [{ manifestId: 'mid-centre', similarityScore: 94, algorithm: 'phash-centre' }]
    const out = await recoverVideoByFingerprint(video(), undefined, async () => f)
    expect(out.credential?.manifestId).toBe('mid-centre')
    const asked = calls.filter((c) => c.url.includes('/matches/byBinding')).map((c) => new URL(c.url).searchParams.get('value'))
    expect(asked).toEqual([fp.whole.phash, fp.centre.phash])
  })

  it('looked and found none is a checked answer', async () => {
    storage.manifestStoreProbe = true
    const { recoverVideoByFingerprint } = await loadFresh()
    expect(await recoverVideoByFingerprint(video(), undefined, async () => frame(3))).toEqual({ credential: null, checked: true })
  })

  it('says so when the browser cannot read the video, and asks nothing', async () => {
    storage.manifestStoreProbe = true
    const { recoverVideoByFingerprint } = await loadFresh()
    const out = await recoverVideoByFingerprint(video(), undefined, async () => null)
    expect(out.checked).toBe(false)
    expect(out.detail).toMatch(/could not read/i)
    expect(calls).toEqual([])
  })

  it('the caller\'s answer wins over storage, because the offscreen page cannot read it', async () => {
    const { recoverVideoByFingerprint } = await loadFresh()
    expect((await recoverVideoByFingerprint(video(), false, async () => frame(1))).checked).toBe(false)
    expect((await recoverVideoByFingerprint(video(), true, async () => frame(1))).checked).toBe(true)
  })

  it('there is no way left to send the video itself', async () => {
    const mod = await loadFresh() as Record<string, unknown>
    expect(mod.recoverVideoByUpload).toBeUndefined()
    const constants = await import('../src/constants') as Record<string, unknown>
    expect(constants.VIDEO_UPLOAD_RECOVERY_KEY).toBeUndefined()
  })
})

describe('the words for a video with no credentials', () => {
  it('points at the one switch, and promises the video stays put', async () => {
    const { noLabelNote } = await import('../src/recovered')
    const note = noLabelNote({ recovered: null, checked: false, medium: 'video' })
    expect(note).toMatch(/for this video/)
    expect(note).toMatch(/Check durable credentials online/)
    expect(note).not.toMatch(/Send videos/)
    expect(note).toMatch(/never the video/i)
  })

  it('says when the video could not be read', async () => {
    const { noLabelNote } = await import('../src/recovered')
    expect(noLabelNote({ recovered: null, checked: false, medium: 'video', detail: 'this browser could not read the video.' })).toMatch(/could not read the video/)
  })

  it('a recovered video is called a video, and the match is called what it is', async () => {
    const { recoveredNote } = await import('../src/recovered')
    const note = recoveredNote({ registry: 'SanMarcSoft Manifest Store', manifestId: 'm', similarityScore: 96, signerCn: 'sign.trusteddit.com', signedAt: '2026-10-06', filename: null, aiGenerated: null, otherMatches: [], medium: 'video' })
    expect(note).toMatch(/^This video's Content Credentials were removed/)
    expect(note).toMatch(/one frame/i)
  })

  it('still says image for a picture', async () => {
    const { noLabelNote } = await import('../src/recovered')
    expect(noLabelNote({ recovered: null, checked: true })).toMatch(/for this image/)
  })
})
