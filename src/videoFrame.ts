/*
 * A video's fingerprint, computed in the browser (#197).
 *
 * A stripped picture is found again by its fingerprint. A video is found the
 * same way, from one frame: the frame at half the duration. The Trusteddit
 * signer registers that frame's fingerprint when it signs (signing-api
 * lib/fingerprint.py), plus one of the centre of the frame and one of its
 * centre vertical slice, so a copy that a platform padded, stamped with a logo
 * or cropped to a vertical format can still be matched.
 *
 * Everything here runs on the device. What leaves is a few 16-character
 * hashes, never the video and never a frame.
 *
 * The geometry below mirrors the signer's exactly, and test/videoFrame.test.ts
 * pins it to the signer's own output: a pixel of difference in where a crop
 * falls is a fingerprint that no longer matches.
 */

import { computeDifferenceHash, computePerceptualHash, toGrayscale8 } from './perceptualHash'

/** A row or column is a bar when even its brightest pixel is this dark (0-255). */
const BAR_BRIGHTEST = 28
/** Bars are only believed when what is left is still a sensible picture. */
const BAR_MIN_KEPT = 0.25
/** How much of the frame the centre fingerprint covers, per side. */
const CENTRE_FRACTION = 0.7

export interface HashPair { phash: string, dhash: string }
export interface FrameFingerprints { whole: HashPair, centre: HashPair }

function crop (img: ImageData, left: number, top: number, width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * img.width + left) * 4
    data.set(img.data.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
}

/**
 * Crop away black bars a platform added around the picture. Vertical formats
 * put a wide video between two black bars, which would otherwise dominate the
 * fingerprint. A frame that is dark all over is left alone: bars are edges that
 * are black while the middle is not.
 */
export function removeBars (img: ImageData): ImageData {
  const { width, height } = img
  const grey = toGrayscale8(img)
  let top = -1; let bottom = -1; let left = -1; let right = -1
  const colLit = new Uint8Array(width)
  for (let y = 0; y < height; y++) {
    let rowLit = false
    for (let x = 0; x < width; x++) {
      if (grey[y * width + x] > BAR_BRIGHTEST) { rowLit = true; colLit[x] = 1 }
    }
    if (rowLit) { if (top < 0) top = y; bottom = y + 1 }
  }
  for (let x = 0; x < width; x++) {
    if (colLit[x] === 1) { if (left < 0) left = x; right = x + 1 }
  }
  if (top < 0 || left < 0) return img
  if ((bottom - top) * (right - left) < BAR_MIN_KEPT * height * width) return img
  if (top === 0 && left === 0 && bottom === height && right === width) return img
  return crop(img, left, top, right - left, bottom - top)
}

/** The middle of the frame, where a platform's logo and captions are not. */
export function centreRegion (img: ImageData, fraction = CENTRE_FRACTION): ImageData {
  const cw = Math.trunc(img.width * fraction)
  const ch = Math.trunc(img.height * fraction)
  return crop(img, Math.floor((img.width - cw) / 2), Math.floor((img.height - ch) / 2), cw, ch)
}

const hashes = (img: ImageData): HashPair => ({ phash: computePerceptualHash(img), dhash: computeDifferenceHash(img) })

/** The fingerprints of one frame: the whole picture without bars, and its centre. */
export function frameFingerprints (frame: ImageData): FrameFingerprints {
  const clean = removeBars(frame)
  return { whole: hashes(clean), centre: hashes(centreRegion(clean)) }
}

const LOAD_TIMEOUT_MS = 10_000

/**
 * The frame at half the duration of a video, or null when the browser cannot
 * decode it. Runs where there is a document: Chrome's offscreen page, Firefox's
 * background page. The video is never played and never attached to a page.
 */
export async function videoMiddleFrame (blob: Blob): Promise<ImageData | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  try {
    video.muted = true
    video.preload = 'auto'
    const wait = async (event: 'loadedmetadata' | 'seeked'): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`${event} timeout`)) }, LOAD_TIMEOUT_MS)
        video.addEventListener(event, () => { clearTimeout(timer); resolve() }, { once: true })
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cannot decode')) }, { once: true })
      })
    }
    const loaded = wait('loadedmetadata')
    video.src = url
    await loaded
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth === 0) return null
    const seeked = wait('seeked')
    video.currentTime = video.duration / 2
    await seeked
    const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight)
    const ctx = canvas.getContext('2d')
    if (ctx == null) return null
    ctx.drawImage(video, 0, 0)
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
