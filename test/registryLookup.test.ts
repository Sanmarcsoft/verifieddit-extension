/*
 *  The registry lookup asks the public credential registries, through
 *  api.verifieddit.com, whether a watermark named in a file's signed
 *  credentials is registered (#184). It shares the durable-check switch, so
 *  the same promise holds: nothing leaves unless the user said yes, and what
 *  leaves is the algorithm name and binding value from the signed claim.
 *  Run with:  bun test test/registryLookup.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

let storage: Record<string, unknown> = {}
let fetchCalls: Array<{ url: string, init: RequestInit | undefined }> = []
let answer: unknown = { results: [] }
let ok = true
const realFetch = globalThis.fetch

beforeEach(() => {
  storage = {}
  fetchCalls = []
  answer = { results: [] }
  ok = true
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: storage[k] }) } }
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    return { ok, json: async () => answer }
  }) as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch })

const loadFresh = async (): Promise<typeof import('../src/manifestStore')> =>
  await import(`../src/manifestStore?t=${Date.now()}${Math.random()}`)

const binding = { alg: 'ai.trufo.pawprint.watermark', value: 'AAEC' }

describe('softBindingsOf — reads bindings from signed assertions only', () => {
  it('takes the algorithm and each block value from soft-binding assertions', async () => {
    const { softBindingsOf } = await loadFresh()
    expect(softBindingsOf([
      { label: 'c2pa.actions.v2', data: { actions: [] } },
      { label: 'c2pa.soft-binding', data: { alg: 'ai.trufo.pawprint.watermark', blocks: [{ scope: {}, value: 'AAEC' }, { scope: {}, value: 'BBBB' }] } },
      { label: 'c2pa.soft-binding__1', data: { alg: 'com.adobe.trustmark.P', blocks: [{ value: 'ed63eb37' }] } }
    ])).toEqual([
      { alg: 'ai.trufo.pawprint.watermark', value: 'AAEC' },
      { alg: 'ai.trufo.pawprint.watermark', value: 'BBBB' },
      { alg: 'com.adobe.trustmark.P', value: 'ed63eb37' }
    ])
  })

  it('also reads the shape our own signer writes today (underscore label, binding_key)', async () => {
    const { softBindingsOf } = await loadFresh()
    expect(softBindingsOf([
      { label: 'c2pa.soft_binding', data: { alg: 'trustmark', alg_version: '0.9.0', blocks: [{ block_type: 'full_image', binding: { binding_key: '4b60d881', model_type: 'Q' } }] } }
    ])).toEqual([{ alg: 'trustmark', value: '4b60d881' }])
  })

  it('ignores malformed assertions and caps how many bindings it will ask about', async () => {
    const { softBindingsOf } = await loadFresh()
    expect(softBindingsOf(null)).toEqual([])
    expect(softBindingsOf([
      { label: 'c2pa.soft-binding', data: null },
      { label: 'c2pa.soft-binding', data: { alg: 7, blocks: [{ value: 'a' }] } },
      { label: 'c2pa.soft-binding', data: { alg: 'bad alg!', blocks: [{ value: 'a' }] } },
      { label: 'c2pa.soft-binding', data: { alg: 'a.b.c', blocks: [{ value: 'x'.repeat(5000) }, { value: 9 }] } }
    ])).toEqual([])
    const many = softBindingsOf([{ label: 'c2pa.soft-binding', data: { alg: 'a.b.c', blocks: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}` })) } }])
    expect(many.length).toBe(4)
  })
})

describe('probeRegistries — consent gate and honest reporting', () => {
  it('makes NO request when the user has not opted in', async () => {
    const { probeRegistries } = await loadFresh()
    expect(await probeRegistries([binding])).toEqual([])
    expect(fetchCalls).toEqual([])
  })

  it('makes no request when there is nothing to ask about', async () => {
    storage.manifestStoreProbe = true
    const { probeRegistries } = await loadFresh()
    expect(await probeRegistries([])).toEqual([])
    expect(fetchCalls).toEqual([])
  })

  it('once opted in, sends only the algorithm and value, without credentials', async () => {
    storage.manifestStoreProbe = true
    const { probeRegistries } = await loadFresh()
    await probeRegistries([binding])
    expect(fetchCalls.length).toBe(1)
    const u = new URL(fetchCalls[0].url)
    expect(u.origin + u.pathname).toBe('https://api.verifieddit.com/api/v1/durable/resolve')
    expect([...u.searchParams.keys()].sort()).toEqual(['alg', 'value'])
    expect(u.searchParams.get('alg')).toBe(binding.alg)
    expect(u.searchParams.get('value')).toBe(binding.value)
    expect(fetchCalls[0].init?.credentials).toBe('omit')
    expect(fetchCalls[0].init?.body).toBeUndefined()
  })

  it('names the registries that reported a match, each once', async () => {
    storage.manifestStoreProbe = true
    answer = { results: [
      { registry: 'trufo', name: 'Trufo', status: 'match', matches: [{ manifestId: 'm' }] },
      { registry: 'adobe', name: 'Adobe', status: 'needs-key', matches: [] },
      { registry: 'sanmarcsoft', name: 'SanMarcSoft Manifest Store', status: 'no-match', matches: [] }
    ] }
    const { probeRegistries } = await loadFresh()
    expect(await probeRegistries([binding, { ...binding, value: 'BBBB' }])).toEqual(['Trufo'])
  })

  it('fails closed: a hub error or nonsense answer confirms nothing', async () => {
    storage.manifestStoreProbe = true
    const { probeRegistries } = await loadFresh()
    ok = false
    expect(await probeRegistries([binding])).toEqual([])
    ok = true
    answer = { results: 'nope' }
    expect(await probeRegistries([binding])).toEqual([])
    answer = { results: [{ registry: 'x', name: 'X', status: 'match', matches: [] }] }
    expect(await probeRegistries([binding])).toEqual([])
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await probeRegistries([binding])).toEqual([])
  })
})
