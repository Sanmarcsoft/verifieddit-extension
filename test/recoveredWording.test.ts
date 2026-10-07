/**
 * The recovered panel must call a video a video (#204).
 *
 * Seen in real Chrome on 2026-10-07: a stripped video was recovered correctly,
 * and the panel then said everything "comes from a registered picture", and
 * labelled the video's watermark "TrustMark", which is the picture watermark.
 * The wording is wrong on the one screen where the reader is asked to trust it.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediumWord, watermarkTileLabel } from '../src/recovered'

describe('recovered panel wording', () => {
  it('says picture for an image and video for a video', () => {
    expect(mediumWord({})).toBe('picture')
    expect(mediumWord(null)).toBe('picture')
    expect(mediumWord({ medium: 'video' })).toBe('video')
  })

  it('names TrustMark only for pictures', () => {
    expect(watermarkTileLabel(false)).toBe('TrustMark soft binding')
    expect(watermarkTileLabel(true)).not.toMatch(/trustmark/i)
    expect(watermarkTileLabel(true)).toMatch(/video/i)
  })

  it('the panel uses those words instead of a fixed "picture"', () => {
    const panel = readFileSync(join(import.meta.dir, '..', 'src', 'webComponents.ts'), 'utf8')
    expect(panel).not.toContain('comes from a registered picture')
    expect(panel).not.toContain('also match\'} this picture')
    expect(panel).toContain('mediumWord(')
    expect(panel).toContain('watermarkTileLabel(')
  })
})
