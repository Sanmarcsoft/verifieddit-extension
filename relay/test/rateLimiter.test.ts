import { describe, expect, it } from 'bun:test'
import { RateLimiter } from '../src/rateLimiter'

describe('RateLimiter', () => {
  it('allows requests within limit and throttles excess requests', async () => {
    let currentTime = 1700000000000
    const limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 60000,
      now: () => currentTime
    })

    const ip = '192.168.1.50'
    expect(await limiter.isAllowed(ip)).toBe(true)
    expect(await limiter.isAllowed(ip)).toBe(true)
    expect(await limiter.isAllowed(ip)).toBe(true)
    expect(await limiter.isAllowed(ip)).toBe(false)

    // Advance clock past the rate limit window
    currentTime += 60001
    expect(await limiter.isAllowed(ip)).toBe(true)
  })

  it('never stores raw address in internal map keys or values', async () => {
    const rawIp = '203.0.113.195'
    const limiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 60000,
      now: () => 1700000000000
    })

    await limiter.isAllowed(rawIp)

    const mapKeys = limiter.getInternalKeys()
    expect(mapKeys.length).toBe(1)
    expect(mapKeys[0]).not.toBe(rawIp)
    expect(mapKeys[0]).not.toContain(rawIp)
    expect(limiter.hasRawAddress(rawIp)).toBe(false)
  })

  it('rotates salt and drops old buckets when clock passes day boundary', async () => {
    // 1700000000000 is 2023-11-14T22:13:20.000Z
    let currentTime = 1700000000000
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      now: () => currentTime
    })

    const ip = '198.51.100.22'
    const initialSalt = limiter.getSalt()

    expect(await limiter.isAllowed(ip)).toBe(true)
    expect(await limiter.isAllowed(ip)).toBe(true)
    expect(await limiter.isAllowed(ip)).toBe(false)
    expect(limiter.getInternalKeys().length).toBe(1)

    // Advance clock across day boundary (e.g. +3 hours -> next UTC day)
    currentTime += 3 * 3600 * 1000
    const newSalt = limiter.getSalt()

    expect(newSalt).not.toBe(initialSalt)
    // Old buckets dropped on rotation
    expect(limiter.getInternalKeys().length).toBe(0)
    // Requests allowed again after rotation
    expect(await limiter.isAllowed(ip)).toBe(true)
  })
})
