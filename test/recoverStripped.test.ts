/*
 *  Recovering a stripped image's credential (#184). A file whose Content
 *  Credentials were removed carries no pointer to them; what survives is the
 *  picture, so its fingerprint is looked up in the registry. Same opt-in as the
 *  durable check, and only ever on an explicit Verify.
 *  Run with:  bun test test/recoverStripped.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

let storage: Record<string, unknown> = {}
let calls: string[] = []
let matches: unknown = []
let meta: unknown = null
const realFetch = globalThis.fetch

beforeEach(() => {
  storage = {}
  calls = []
  matches = [{ manifestId: 'mid-1', similarityScore: 97, algorithm: 'phash' }]
  meta = { manifestId: 'mid-1', signerCn: 'sign.trusteddit.com', signedAt: '2026-10-05 10:16:33+00:00', filename: 'durable-test.png' }
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: storage[k] }) } }
  }
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    if (String(url).includes('/matches/byBinding')) return { ok: true, json: async () => ({ matches }) }
    return { ok: meta != null, json: async () => meta }
  }) as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch })

const loadFresh = async (): Promise<typeof import('../src/manifestStore')> =>
  await import(`../src/manifestStore?t=${Date.now()}${Math.random()}`)

const fingerprints = { phash: '901e607e2dde2cdc', dhash: '7cfdfcf8fafeacd3' }

describe('recoverByFingerprint', () => {
  it('makes NO request unless the user has opted in', async () => {
    const { recoverByFingerprint } = await loadFresh()
    expect(await recoverByFingerprint(fingerprints)).toBeNull()
    expect(calls).toEqual([])
  })

  it('once opted in, asks the registry with both fingerprints and returns who signed the original', async () => {
    storage.manifestStoreProbe = true
    const { recoverByFingerprint } = await loadFresh()
    const out = await recoverByFingerprint(fingerprints)
    const u = new URL(calls[0])
    expect(u.origin + u.pathname).toBe('https://manifests.sanmarcsoft.com/v1/matches/byBinding')
    expect(u.searchParams.get('alg')).toBe('phash')
    expect(u.searchParams.get('value')).toBe(fingerprints.phash)
    expect(u.searchParams.get('crossAlg')).toBe('dhash')
    expect(u.searchParams.get('crossValue')).toBe(fingerprints.dhash)
    expect(calls[1]).toBe('https://manifests.sanmarcsoft.com/v1/manifests/mid-1?format=json')
    expect(out).toEqual({
      registry: 'SanMarcSoft Manifest Store',
      manifestId: 'mid-1',
      similarityScore: 97,
      signerCn: 'sign.trusteddit.com',
      signedAt: '2026-10-05 10:16:33+00:00',
      filename: 'durable-test.png'
    })
  })

  it('returns nothing when no credential is registered, or the record cannot be read', async () => {
    storage.manifestStoreProbe = true
    const { recoverByFingerprint } = await loadFresh()
    matches = []
    expect(await recoverByFingerprint(fingerprints)).toBeNull()
    matches = [{ manifestId: 'mid-1', similarityScore: 97 }]
    meta = null
    expect(await recoverByFingerprint(fingerprints)).toBeNull()
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await recoverByFingerprint(fingerprints)).toBeNull()
  })

  it('refuses a manifest id that is not a plain identifier', async () => {
    storage.manifestStoreProbe = true
    matches = [{ manifestId: '../../evil?x=1', similarityScore: 99 }]
    const { recoverByFingerprint } = await loadFresh()
    expect(await recoverByFingerprint(fingerprints)).toBeNull()
    expect(calls.length).toBe(1)
  })
})

describe('recoveredNote', () => {
  it('says the credentials were removed, who signed the original, and that it is a lead', async () => {
    const { recoveredNote } = await loadFresh()
    const note = recoveredNote({ registry: 'SanMarcSoft Manifest Store', manifestId: 'm', similarityScore: 97, signerCn: 'sign.trusteddit.com', signedAt: '2026-10-05 10:16:33+00:00', filename: 'durable-test.png' })
    expect(note).toContain('removed')
    expect(note).toContain('sign.trusteddit.com')
    expect(note).toContain('2026-10-05')
    expect(note).toContain('97%')
    expect(note).toContain('SanMarcSoft Manifest Store')
    expect(note).toContain('not proof')
  })
})

describe('checkRegistryRecord — does the registry agree with the file in hand?', () => {
  const sha = async (bytes: Uint8Array): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('')
  const bytes = new Uint8Array([1, 2, 3, 4])
  const blob = new Blob([bytes], { type: 'image/png' })
  const binding = [{ alg: 'trustmark', value: '4b60d881' }]

  it('makes NO request unless the user has opted in', async () => {
    const { checkRegistryRecord } = await loadFresh()
    expect(await checkRegistryRecord(blob, binding)).toBeNull()
    expect(calls).toEqual([])
  })

  it('reports the registered signer and that this is the registered file', async () => {
    storage.manifestStoreProbe = true
    meta = { manifestId: 'mid-1', signerCn: 'sign.trusteddit.com', signedAt: '2026-10-05 10:16:33+00:00', fileHash: `sha256:${await sha(bytes)}` }
    const { checkRegistryRecord } = await loadFresh()
    const out = await checkRegistryRecord(blob, binding)
    expect(new URL(calls[0]).searchParams.get('alg')).toBe('trustmark')
    expect(new URL(calls[0]).searchParams.get('value')).toBe('4b60d881')
    expect(out).toEqual({ registry: 'SanMarcSoft Manifest Store', manifestId: 'mid-1', signerCn: 'sign.trusteddit.com', signedAt: '2026-10-05 10:16:33+00:00', sameFile: true })
  })

  it('says so when the file differs from the registered original, and when the registry holds no hash', async () => {
    storage.manifestStoreProbe = true
    const { checkRegistryRecord } = await loadFresh()
    meta = { manifestId: 'mid-1', signerCn: 's', signedAt: 't', fileHash: 'sha256:' + 'f'.repeat(64) }
    expect((await checkRegistryRecord(blob, binding))?.sameFile).toBe(false)
    meta = { manifestId: 'mid-1', signerCn: 's', signedAt: 't' }
    expect((await checkRegistryRecord(blob, binding))?.sameFile).toBeNull()
  })

  it('returns nothing for a binding our registry does not hold', async () => {
    storage.manifestStoreProbe = true
    const { checkRegistryRecord } = await loadFresh()
    expect(await checkRegistryRecord(blob, [{ alg: 'ai.trufo.pawprint.watermark', value: 'AA' }])).toBeNull()
    matches = []
    expect(await checkRegistryRecord(blob, binding)).toBeNull()
  })
})

describe('the opt-in can be passed in by the caller', () => {
  // In Chrome the engine runs in an offscreen document, which has no
  // chrome.storage: reading the switch there always failed closed, so the online
  // check never ran even when it was on. The background reads the switch and
  // passes it with each request.
  it('runs when the caller says the check is on, even if storage cannot be read here', async () => {
    ;(globalThis as Record<string, unknown>).chrome = {}
    const { recoverByFingerprint, probeRegistries } = await loadFresh()
    expect(await recoverByFingerprint(fingerprints, true)).not.toBeNull()
    calls = []
    await probeRegistries([{ alg: 'trustmark', value: '4b60d881' }], true)
    expect(calls.length).toBe(1)
  })

  it('does not run when the caller says the check is off, even if storage says on', async () => {
    storage.manifestStoreProbe = true
    const { recoverByFingerprint, probeRegistries } = await loadFresh()
    expect(await recoverByFingerprint(fingerprints, false)).toBeNull()
    expect(await probeRegistries([{ alg: 'trustmark', value: '4b60d881' }], false)).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('the no-label note says whether we looked', () => {
  it('tells apart "looked and found nothing" from "the online check is off"', async () => {
    const { noLabelNote } = await import('../src/recovered')
    expect(noLabelNote({ recovered: null, checked: true })).toMatch(/looked for a copy.*found none/i)
    expect(noLabelNote({ recovered: null, checked: false })).toMatch(/turn on/i)
    expect(noLabelNote({ recovered: { registry: 'R', manifestId: 'm', similarityScore: 97, signerCn: 's', signedAt: '2026-10-05', filename: null }, checked: true })).toMatch(/not proof/i)
  })
})
