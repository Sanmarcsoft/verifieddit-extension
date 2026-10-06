/*
 *  A video's fingerprint in the browser (#197). The signer registers the
 *  fingerprint of the frame at half the duration, with black bars removed, plus
 *  one of the centre of that frame. The browser has to compute the SAME values
 *  from the same frame, so these tests pin our output to the signer's own code
 *  (lib/fingerprint.py) on lossless frames: identical pixels on both sides.
 *  Run with:  bun test test/videoFrame.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PNG } from 'pngjs'
import { removeBars, centreRegion, frameFingerprints } from '../src/videoFrame'

const DIR = join(import.meta.dir, 'fixtures', 'video-frames')
const truth: Record<string, { size: number[], afterBars: number[], centreSize: number[], whole: { phash: string, dhash: string }, centre: { phash: string, dhash: string } }> =
  JSON.parse(readFileSync(join(DIR, 'signer-groundtruth.json'), 'utf8'))

function loadPng (name: string): ImageData {
  const png = PNG.sync.read(readFileSync(join(DIR, name)))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data), colorSpace: 'srgb' } as unknown as ImageData
}

function flat (width: number, height: number, value: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = data[i + 1] = data[i + 2] = value(x, y); data[i + 3] = 255
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
}

describe('against the signer, frame by frame', () => {
  for (const [name, want] of Object.entries(truth)) {
    it(`${name}: same picture after bar removal, same centre, same four hashes`, () => {
      const frame = loadPng(name)
      expect([frame.width, frame.height]).toEqual(want.size)
      const clean = removeBars(frame)
      expect([clean.width, clean.height]).toEqual(want.afterBars)
      const centre = centreRegion(clean)
      expect([centre.width, centre.height]).toEqual(want.centreSize)
      expect(frameFingerprints(frame)).toEqual({ whole: want.whole, centre: want.centre })
    })
  }
})

describe('removeBars', () => {
  it('cuts black bars above and below, and left and right', () => {
    const lit = (x: number, y: number): number => (y >= 40 && y < 100 && x >= 10 && x < 190 ? 120 + (x % 50) : 0)
    const out = removeBars(flat(200, 140, lit))
    expect([out.width, out.height]).toEqual([180, 60])
    expect(out.data[0]).toBe(130) // the pixel at (10, 40) of the original
  })

  it('leaves a picture with no bars exactly as it is', () => {
    const img = flat(64, 48, (x, y) => 60 + ((x + y) % 100))
    expect(removeBars(img)).toBe(img)
  })

  it('does not crop a frame that is dark all over', () => {
    const img = flat(64, 48, () => 9)
    expect(removeBars(img)).toBe(img)
  })

  it('does not believe bars that would leave less than a quarter of the frame', () => {
    const img = flat(200, 200, (x, y) => (x >= 90 && x < 110 && y >= 90 && y < 110 ? 200 : 0))
    expect(removeBars(img)).toBe(img)
  })

  it('treats near-black as black, as a compressed bar is never exactly zero', () => {
    const out = removeBars(flat(100, 100, (_x, y) => (y >= 20 && y < 80 ? 150 : 14)))
    expect([out.width, out.height]).toEqual([100, 60])
  })
})

describe('centreRegion', () => {
  it('is the middle seven tenths, placed as the signer places it', () => {
    const out = centreRegion(flat(640, 360, (x) => x % 256))
    expect([out.width, out.height]).toEqual([448, 251]) // int(640*0.7), int(360*0.7)
    expect(out.data[0]).toBe(96) // left edge = (640-448)//2
  })
})
