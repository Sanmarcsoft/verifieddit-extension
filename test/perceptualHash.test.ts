/*
 * Interop tests for the manifest-store fingerprints (issue #164).
 *
 * The store is populated by the signing API using Python imagehash on Pillow.
 * The probe only confirms a durable credential when OUR pHash matches AND our
 * dHash cross-validates within the store's Hamming limit of 8, so these tests
 * pin the extension's hashes to imagehash's exact output on PNG fixtures
 * (lossless decode → identical pixels on both sides).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PNG } from 'pngjs'
import { computeDifferenceHash, computePerceptualHash, hammingDistance } from '../src/perceptualHash'

const FIXTURES = join(import.meta.dir, 'fixtures')
const groundTruth: Record<string, { phash: string, dhash: string }> = JSON.parse(
  readFileSync(join(FIXTURES, 'interop', 'imagehash-groundtruth.json'), 'utf8')
)

function loadPng (rel: string): ImageData {
  const png = PNG.sync.read(readFileSync(join(FIXTURES, rel)))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data), colorSpace: 'srgb' } as unknown as ImageData
}

function synthetic (width: number, height: number, fill: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
}

// What the manifest store actually holds for the launch marquee (manifest
// 1201c671-a1ed-424b-9284-dbaf0a18e7fc), fingerprinted server-side. It sits a
// few bits from imagehash-on-the-served-bytes, so the client must be exact to
// stay inside the store's MAX_HAMMING_DISTANCE of 8 on both hashes.
const STORE_RECORD = { phash: 'a4b31bcc4e1d3fd8', dhash: '3fcccc8ca6ecd61c' }
const STORE_MAX_HAMMING = 8

describe('perceptualHash interop with the signing API (imagehash)', () => {
  for (const [rel, expected] of Object.entries(groundTruth)) {
    if (rel.startsWith('_')) continue
    it(`pHash of ${rel} equals imagehash.phash exactly`, () => {
      expect(computePerceptualHash(loadPng(rel))).toBe(expected.phash)
    })
    it(`dHash of ${rel} equals imagehash.dhash exactly`, () => {
      expect(computeDifferenceHash(loadPng(rel))).toBe(expected.dhash)
    })
  }

  it('the served launch marquee cross-validates against the live store record', () => {
    const img = loadPng('interop/marquee-signed.png')
    expect(hammingDistance(computePerceptualHash(img), STORE_RECORD.phash)).toBeLessThanOrEqual(STORE_MAX_HAMMING)
    expect(hammingDistance(computeDifferenceHash(img), STORE_RECORD.dhash)).toBeLessThanOrEqual(STORE_MAX_HAMMING)
  })

  it('dHash sets a bit when the RIGHT pixel is brighter (imagehash direction)', () => {
    // Brightness increases left to right, so every gradient bit is 1.
    expect(computeDifferenceHash(synthetic(90, 80, (x) => Math.round((x / 89) * 255)))).toBe('ffffffffffffffff')
    // Brightness decreases left to right, so every bit is 0.
    expect(computeDifferenceHash(synthetic(90, 80, (x) => Math.round(((89 - x) / 89) * 255)))).toBe('0000000000000000')
  })

  it('uniform images hash to all-zero dHash', () => {
    expect(computeDifferenceHash(synthetic(64, 64, () => 128))).toBe('0000000000000000')
  })
})
