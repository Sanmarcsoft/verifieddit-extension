/*
 *  Unit tests for the Durable Content Credentials "3 pillars" detector.
 *  Run with:  bun test test/durableCredentials.test.ts
 *  (Playwright only scans ./test/e2e, so this file is ignored by `npm test`.)
 */
import { describe, it, expect } from 'bun:test'
import { claimsDurability, detectDurablePillars, hasSoftBinding } from '../src/durableCredentials'

describe('hasSoftBinding', () => {
  it('returns false for null / empty', () => {
    expect(hasSoftBinding(null)).toBe(false)
    expect(hasSoftBinding(undefined)).toBe(false)
    expect(hasSoftBinding([])).toBe(false)
  })

  it('matches both the underscore and hyphen spellings', () => {
    expect(hasSoftBinding(['c2pa.soft_binding'])).toBe(true)
    expect(hasSoftBinding(['c2pa.soft-binding'])).toBe(true)
    expect(hasSoftBinding(['c2pa.hash.data', 'c2pa.soft_binding'])).toBe(true)
  })

  it('ignores unrelated assertion labels', () => {
    expect(hasSoftBinding(['c2pa.hash.data', 'c2pa.actions', 'stds.schema-org.CreativeWork'])).toBe(false)
  })
})

describe('detectDurablePillars', () => {
  it('unsigned asset → no pillars', () => {
    const p = detectDurablePillars({ signed: false, hasTimestamp: false, assertionLabels: [] })
    expect(p).toMatchObject({ signedAndTimestamped: false, trustmark: false, manifestStore: 'absent', durable: false, count: 0, embedOnly: false })
  })

  it('signed + timestamped, no soft binding → embed-only (P1 only)', () => {
    const p = detectDurablePillars({ signed: true, hasTimestamp: true, assertionLabels: ['c2pa.hash.data', 'c2pa.actions'] })
    expect(p.signedAndTimestamped).toBe(true)
    expect(p.trustmark).toBe(false)
    expect(p.manifestStore).toBe('absent')
    expect(p.durable).toBe(false)
    expect(p.count).toBe(1)
    expect(p.embedOnly).toBe(true)
  })

  it('signed + timestamped + soft binding (unprobed) → durable, P3 declared not counted', () => {
    const p = detectDurablePillars({ signed: true, hasTimestamp: true, assertionLabels: ['c2pa.hash.data', 'c2pa.soft_binding'] })
    expect(p.trustmark).toBe(true)
    expect(p.manifestStore).toBe('declared') // NOT 'verified' — no offline probe
    expect(p.durable).toBe(true) // P1 && P2 provable offline
    expect(p.count).toBe(2) // P3 'declared' does not count
    expect(p.embedOnly).toBe(false)
  })

  it('names the registries that confirmed it, and only when it is confirmed (#184)', () => {
    const base = { signed: true, hasTimestamp: true, assertionLabels: ['c2pa.soft_binding'] }
    expect(detectDurablePillars({ ...base, manifestStoreVerified: true, confirmedBy: ['SanMarcSoft Manifest Store', 'Trufo'] }).confirmedBy)
      .toEqual(['SanMarcSoft Manifest Store', 'Trufo'])
    // Confirmed by the image-fingerprint probe alone: verified, but no registry named.
    expect(detectDurablePillars({ ...base, manifestStoreVerified: true }).confirmedBy).toEqual([])
    // Names without a confirmation are dropped: a name must never imply a check that did not pass.
    expect(detectDurablePillars({ ...base, manifestStoreVerified: false, confirmedBy: ['Trufo'] }).confirmedBy).toEqual([])
  })

  it('manifest-store probe confirmed → P3 verified, 3/3', () => {
    const p = detectDurablePillars({ signed: true, hasTimestamp: true, assertionLabels: ['c2pa.soft_binding'], manifestStoreVerified: true })
    expect(p.manifestStore).toBe('verified')
    expect(p.count).toBe(3)
  })

  it('soft binding present but unsigned → P2 only, not durable', () => {
    const p = detectDurablePillars({ signed: false, hasTimestamp: false, assertionLabels: ['c2pa.soft_binding'] })
    expect(p.signedAndTimestamped).toBe(false)
    expect(p.trustmark).toBe(true)
    expect(p.manifestStore).toBe('declared')
    expect(p.durable).toBe(false)
    expect(p.count).toBe(1) // only P2
  })

  it('timestamp without signature does not light P1', () => {
    const p = detectDurablePillars({ signed: false, hasTimestamp: true, assertionLabels: ['c2pa.soft_binding'] })
    expect(p.signedAndTimestamped).toBe(false)
  })
})

describe('claimsDurability (#186)', () => {
  const none = { signedAndTimestamped: false, trustmark: false, manifestStore: 'absent' } as const

  it('is false when the file claims no durable feature, so there is nothing to warn about', () => {
    expect(claimsDurability(none)).toBe(false)
    expect(claimsDurability(null)).toBe(false)
  })

  it('is true as soon as one durable feature is claimed', () => {
    expect(claimsDurability({ ...none, signedAndTimestamped: true })).toBe(true)
    expect(claimsDurability({ ...none, trustmark: true })).toBe(true)
    expect(claimsDurability({ ...none, manifestStore: 'declared' })).toBe(true)
    expect(claimsDurability({ ...none, manifestStore: 'verified' })).toBe(true)
  })
})
