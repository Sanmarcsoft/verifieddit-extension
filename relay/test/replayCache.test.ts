import { describe, expect, it } from 'bun:test'
import { MAX_REPLAY_CACHE_ENTRIES, ReplayCache } from '../src/replayCache'

describe('ReplayCache', () => {
  it('detects duplicate signatures and records new ones', () => {
    let currentTime = 1700000000000
    const cache = new ReplayCache({ now: () => currentTime })

    expect(cache.size).toBe(0)

    // First time seeing sig1 -> returns false (not seen before)
    const isReplay1 = cache.remember('sig1', currentTime)
    expect(isReplay1).toBe(false)
    expect(cache.size).toBe(1)
    expect(cache.has('sig1')).toBe(true)

    // Second time seeing sig1 with same timestamp -> returns true (duplicate detected)
    const isReplay2 = cache.remember('sig1', currentTime)
    expect(isReplay2).toBe(true)
    expect(cache.size).toBe(1)

    // Second time seeing sig1 even with different timestamp -> returns true
    const isReplay3 = cache.remember('sig1', currentTime + 1000)
    expect(isReplay3).toBe(true)
    expect(cache.size).toBe(1)

    // Different signature -> returns false
    const isReplayOther = cache.remember('sig2', currentTime)
    expect(isReplayOther).toBe(false)
    expect(cache.size).toBe(2)
    expect(cache.has('sig2')).toBe(true)
  })

  it('drops entry after its timestamp window passes', () => {
    let currentTime = 1700000000000
    const windowMs = 5 * 60 * 1000 // 5 minutes
    const cache = new ReplayCache({
      windowMs,
      now: () => currentTime
    })

    const requestTs = currentTime
    expect(cache.remember('sig1', requestTs)).toBe(false)
    expect(cache.size).toBe(1)
    expect(cache.has('sig1')).toBe(true)

    // Advance clock to exactly ts + window: entry is still valid
    currentTime = requestTs + windowMs
    expect(cache.has('sig1')).toBe(true)
    expect(cache.size).toBe(1)
    expect(cache.remember('sig1', requestTs)).toBe(true)

    // Advance clock 1ms past ts + window: entry has expired
    currentTime = requestTs + windowMs + 1
    expect(cache.has('sig1')).toBe(false)
    expect(cache.size).toBe(0)

    // Resending after window has passed is no longer blocked by replay cache
    // (the relay server will reject old timestamps upstream in validateTimestamp)
    const newTs = currentTime
    expect(cache.remember('sig1', newTs)).toBe(false)
    expect(cache.size).toBe(1)
  })

  it('evicts oldest entries first when cap is reached and newest survive', () => {
    let currentTime = 1700000000000
    const cache = new ReplayCache({
      maxEntries: 3,
      now: () => currentTime
    })

    expect(cache.remember('sig1', currentTime)).toBe(false)
    currentTime += 100
    expect(cache.remember('sig2', currentTime)).toBe(false)
    currentTime += 100
    expect(cache.remember('sig3', currentTime)).toBe(false)
    expect(cache.size).toBe(3)

    // Inserting 4th entry evicts oldest (sig1)
    currentTime += 100
    expect(cache.remember('sig4', currentTime)).toBe(false)
    expect(cache.size).toBe(3)

    // sig1 is gone, sig2, sig3, sig4 survive
    expect(cache.has('sig1')).toBe(false)
    expect(cache.has('sig2')).toBe(true)
    expect(cache.has('sig3')).toBe(true)
    expect(cache.has('sig4')).toBe(true)

    // Inserting 5th entry evicts next oldest (sig2)
    currentTime += 100
    expect(cache.remember('sig5', currentTime)).toBe(false)
    expect(cache.size).toBe(3)
    expect(cache.has('sig2')).toBe(false)
    expect(cache.has('sig3')).toBe(true)
    expect(cache.has('sig4')).toBe(true)
    expect(cache.has('sig5')).toBe(true)
  })

  it('maintains a bounded size capped by MAX_REPLAY_CACHE_ENTRIES or configured limit', () => {
    expect(MAX_REPLAY_CACHE_ENTRIES).toBe(100000)

    const baseTs = 1700000000000
    const cache = new ReplayCache({
      maxEntries: 5,
      now: () => baseTs
    })

    for (let i = 0; i < 20; i++) {
      cache.remember(`sig_${i}`, baseTs + i)
      expect(cache.size).toBeLessThanOrEqual(5)
    }

    expect(cache.size).toBe(5)
  })

  it('normalizes malleable ECDSA signatures with (r, n - s) to the same key', () => {
    const fixedNow = 1700000000000
    const cache = new ReplayCache({ now: () => fixedNow })

    const n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
    const rBytes = new Uint8Array(32).fill(0x01)
    const sLow = 0x1234567890abcdefn
    const sHigh = n - sLow

    const sLowBytes = new Uint8Array(32)
    const hexLow = sLow.toString(16).padStart(64, '0')
    for (let i = 0; i < 32; i++) {
      sLowBytes[i] = parseInt(hexLow.slice(i * 2, i * 2 + 2), 16)
    }

    const sHighBytes = new Uint8Array(32)
    const hexHigh = sHigh.toString(16).padStart(64, '0')
    for (let i = 0; i < 32; i++) {
      sHighBytes[i] = parseInt(hexHigh.slice(i * 2, i * 2 + 2), 16)
    }

    const sigLow = new Uint8Array(64)
    sigLow.set(rBytes, 0)
    sigLow.set(sLowBytes, 32)
    const sigLowB64 = Buffer.from(sigLow).toString('base64url')

    const sigHigh = new Uint8Array(64)
    sigHigh.set(rBytes, 0)
    sigHigh.set(sHighBytes, 32)
    const sigHighB64 = Buffer.from(sigHigh).toString('base64url')

    expect(sigLowB64).not.toBe(sigHighB64)

    // Store the first signature
    expect(cache.remember(sigLowB64, fixedNow)).toBe(false)
    expect(cache.has(sigLowB64)).toBe(true)

    // The malleated signature must be recognised as a replay
    expect(cache.has(sigHighB64)).toBe(true)
    expect(cache.remember(sigHighB64, fixedNow)).toBe(true)
    expect(cache.size).toBe(1)
  })

  it('sweeps at most once per second while lookups never treat expired entries as present', () => {
    let currentTime = 1700000000000
    const cache = new ReplayCache({
      windowMs: 5000,
      now: () => currentTime
    })

    cache.remember('sig1', currentTime)
    expect(cache.has('sig1')).toBe(true)

    // Advance past expiration (+5001ms)
    currentTime += 5001

    // Lookup never treats expired entry as present
    expect(cache.has('sig1')).toBe(false)
  })
})
