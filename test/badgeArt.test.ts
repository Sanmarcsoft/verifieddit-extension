/*
 *  One badge set for every surface (#184). Colour is the verdict; a lock in the
 *  upper right means the credential is durable. Each badge has a plain-language
 *  explanation, and the two can never drift apart because both come from here.
 *  Run with:  bun test test/badgeArt.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { badgeSvg, explainBadge, BADGE_LEGEND, withDurable, COLOURS } from '../src/badgeArt'

describe('badgeSvg', () => {
  it('fills the teardrop with the verdict colour and keeps the CR letters', () => {
    const svg = badgeSvg('success')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain(COLOURS.green)
    expect(svg).toContain('data-part="cr"')
    expect(svg).not.toContain('data-part="indicator"')
  })

  it('gives each verdict its own colour', () => {
    expect(badgeSvg('ai-success')).toContain(COLOURS.purple)
    expect(badgeSvg('warning')).toContain(COLOURS.yellow)
    expect(badgeSvg('error')).toContain(COLOURS.red)
    expect(badgeSvg('ai-error')).toContain(COLOURS.red)
  })

  it('adds a lock, and only a lock, when the credential is durable', () => {
    for (const s of ['success', 'ai-success', 'warning', 'error'] as const) {
      const svg = badgeSvg(withDurable(s, true))
      expect(svg).toContain('data-part="indicator"')
      expect(svg).toContain('data-glyph="lock"')
    }
    expect(withDurable('success', false)).toBe('success')
    expect(withDurable('no-credentials', true)).toBe('no-credentials')
  })

  it('draws no credentials as a white teardrop with a red outline and slash, at full strength', () => {
    const svg = badgeSvg('no-credentials')
    expect(svg).toContain('fill="#FFFFFF"')
    expect(svg).toContain(COLOURS.slash)
    expect(svg).toContain('data-part="slash"')
  })

  it('marks a recovered credential with the recovery arrow', () => {
    expect(badgeSvg('stripped')).toContain('data-glyph="recover"')
  })

  it('drops the letters at the smallest size and centres the indicator', () => {
    const small = badgeSvg(withDurable('success', true), { small: true })
    expect(small).not.toContain('data-part="cr"')
    expect(small).toContain('data-glyph="lock"')
    expect(badgeSvg('success', { small: true })).not.toContain('data-part="cr"')
  })

  it('contains nothing but static markup', () => {
    for (const row of BADGE_LEGEND) expect(badgeSvg(row.status)).not.toMatch(/<script|onload|href/i)
  })
})

describe('plain-language explainers', () => {
  it('explains every badge the legend shows, in short plain sentences', () => {
    expect(BADGE_LEGEND.length).toBeGreaterThanOrEqual(8)
    for (const row of BADGE_LEGEND) {
      const e = explainBadge(row.status)
      expect(e.title.length).toBeGreaterThan(3)
      expect(e.title.length).toBeLessThanOrEqual(40)
      expect(e.text.length).toBeGreaterThan(20)
      expect(e.text.length).toBeLessThanOrEqual(220)
      // No jargon in what a person reads.
      expect(e.title + e.text).not.toMatch(/manifest|C2PA|soft binding|cryptograph|registry record|hash/i)
    }
  })

  it('says a file with no credentials is not thereby fake', () => {
    expect(explainBadge('no-credentials').text).toMatch(/does not mean/i)
  })

  it('says a recovered credential is a hint, not proof', () => {
    expect(explainBadge('stripped').text).toMatch(/not proof/i)
  })

  it('explains the lock in the durable variants', () => {
    expect(explainBadge(withDurable('success', true)).text).toMatch(/lock/i)
  })
})
