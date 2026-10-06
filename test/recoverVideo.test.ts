/*
 *  Recovering a stripped video's credential (#195). A video's durable credential
 *  is a watermark in its frames that only the Verifieddit service can read, so
 *  the video itself is sent. That is a bigger disclosure than a fingerprint, and
 *  it has its own switch: nothing is uploaded unless BOTH the online check and
 *  the video switch are on.
 *  Run with:  bun test test/recoverVideo.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

let storage: Record<string, unknown> = {}
let calls: Array<{ url: string, init: RequestInit | undefined }> = []
let answer: unknown = null
let status = 200
const realFetch = globalThis.fetch

const recovered = {
  durable: {
    recovery: {
      status: 'recovered',
      method: 'watermark',
      algorithm: 'videoseal',
      similarityScore: 96,
      manifestId: 'urn:c2pa:474b2742-aaaa',
      signerCn: 'sign.trusteddit.com',
      signedAt: '2026-10-06 10:58:12+00:00'
    }
  }
}

beforeEach(() => {
  storage = {}
  calls = []
  answer = recovered
  status = 200
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: storage[k] }) } }
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return { ok: status >= 200 && status < 300, status, json: async () => answer }
  }) as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch })

const loadFresh = async (): Promise<typeof import('../src/manifestStore')> =>
  await import(`../src/manifestStore?t=${Date.now()}${Math.random()}`)

const mp4 = (bytes = 64): Blob => new Blob([new Uint8Array(bytes)], { type: 'video/mp4' })
const bothOn = (): void => { storage.manifestStoreProbe = true; storage.videoUploadRecovery = true }

describe('recoverVideoByUpload', () => {
  it('uploads NOTHING unless both switches are on', async () => {
    const { recoverVideoByUpload } = await loadFresh()
    expect(await recoverVideoByUpload(mp4())).toEqual({ credential: null, checked: false })

    storage.manifestStoreProbe = true // online check on, video switch off
    expect((await recoverVideoByUpload(mp4())).checked).toBe(false)

    storage.manifestStoreProbe = false // video switch on, online check off
    storage.videoUploadRecovery = true
    expect((await recoverVideoByUpload(mp4())).checked).toBe(false)

    expect(calls).toEqual([])
  })

  it('the caller\'s answers win over storage, because the offscreen page cannot read it', async () => {
    const { recoverVideoByUpload } = await loadFresh()
    expect((await recoverVideoByUpload(mp4(), { lookups: true, upload: false })).checked).toBe(false)
    expect((await recoverVideoByUpload(mp4(), { lookups: false, upload: true })).checked).toBe(false)
    expect(calls).toEqual([])
    expect((await recoverVideoByUpload(mp4(), { lookups: true, upload: true })).checked).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('sends only MP4, and only up to the size the service will look at', async () => {
    bothOn()
    const { recoverVideoByUpload, VIDEO_RECOVERY_MAX_BYTES } = await loadFresh()
    expect((await recoverVideoByUpload(new Blob([new Uint8Array(8)], { type: 'image/jpeg' }))).checked).toBe(false)
    expect((await recoverVideoByUpload(new Blob([new Uint8Array(8)], { type: 'video/webm' }))).checked).toBe(false)
    expect(VIDEO_RECOVERY_MAX_BYTES).toBe(25 * 1024 * 1024)
    const big = { type: 'video/mp4', size: VIDEO_RECOVERY_MAX_BYTES + 1 } as unknown as Blob
    const out = await recoverVideoByUpload(big)
    expect(out.checked).toBe(false)
    expect(out.detail).toMatch(/too large/i)
    expect(calls).toEqual([])
  })

  it('posts the file to the Verifieddit verify endpoint, with no cookies', async () => {
    bothOn()
    const { recoverVideoByUpload } = await loadFresh()
    await recoverVideoByUpload(mp4())
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://api.verifieddit.com/api/v1/verify')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.credentials).toBe('omit')
    const file = (calls[0].init?.body as FormData).get('file') as Blob
    expect(file.type).toBe('video/mp4')
    expect(file.size).toBe(64)
  })

  it('returns who signed the original when the service recovers the credential', async () => {
    bothOn()
    const { recoverVideoByUpload } = await loadFresh()
    const out = await recoverVideoByUpload(mp4())
    expect(out.checked).toBe(true)
    expect(out.credential).toEqual({
      registry: 'SanMarcSoft Manifest Store',
      manifestId: 'urn:c2pa:474b2742-aaaa',
      similarityScore: 96,
      signerCn: 'sign.trusteddit.com',
      signedAt: '2026-10-06 10:58:12+00:00',
      filename: null,
      aiGenerated: null,
      otherMatches: [],
      medium: 'video'
    })
  })

  it('looked and found none is not the same as the service could not answer', async () => {
    bothOn()
    const { recoverVideoByUpload } = await loadFresh()
    answer = { durable: { recovery: { status: 'not-found' } } }
    expect(await recoverVideoByUpload(mp4())).toEqual({ credential: null, checked: true })

    answer = { durable: { recovery: { status: 'unavailable' } } }
    const down = await recoverVideoByUpload(mp4())
    expect(down.checked).toBe(false)
    expect(down.detail).toMatch(/could not/i)

    status = 502
    expect((await recoverVideoByUpload(mp4())).checked).toBe(false)

    status = 200
    answer = { durable: null }
    expect((await recoverVideoByUpload(mp4())).checked).toBe(false)
  })

  it('refuses a manifest id that is not shaped like one', async () => {
    bothOn()
    const { recoverVideoByUpload } = await loadFresh()
    answer = { durable: { recovery: { status: 'recovered', manifestId: '../../etc/passwd', similarityScore: 99 } } }
    const out = await recoverVideoByUpload(mp4())
    expect(out.credential).toBeNull()
    expect(out.checked).toBe(false)
  })
})

describe('the words for a video with no credentials', () => {
  it('names the video switch when the upload was not allowed', async () => {
    const { noLabelNote } = await import('../src/recovered')
    const note = noLabelNote({ recovered: null, checked: false, medium: 'video' })
    expect(note).toMatch(/video/i)
    expect(note).toMatch(/Send videos I verify/)
    expect(note).not.toMatch(/this image/i)
  })

  it('says a recovered video is a video', async () => {
    const { recoveredNote } = await import('../src/recovered')
    const note = recoveredNote({ ...({ registry: 'SanMarcSoft Manifest Store', manifestId: 'm', similarityScore: 96, signerCn: 'sign.trusteddit.com', signedAt: '2026-10-06', filename: null, aiGenerated: null, otherMatches: [] }), medium: 'video' })
    expect(note).toMatch(/^This video's Content Credentials were removed/)
  })

  it('still says image for a picture', async () => {
    const { noLabelNote } = await import('../src/recovered')
    expect(noLabelNote({ recovered: null, checked: true })).toMatch(/for this image/)
  })
})
