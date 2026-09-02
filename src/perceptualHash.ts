/*
 * Perceptual hashing for Durable Content Credentials — Pillar 3 (manifest-store
 * recoverability). Computes pHash (DCT-based) and dHash (gradient-based)
 * fingerprints from image pixels, used to query the SanMarcSoft Manifest Store
 * (byBinding) and confirm a credential is REGISTERED and recoverable.
 *
 * The store is populated by the signing API, which fingerprints with the Python
 * `imagehash` library on top of Pillow. Recovery only works if the client
 * produces the SAME bits, so this file is a faithful port of that pipeline,
 * not a generic perceptual hash:
 *
 *   - grayscale: Pillow's RGB->L conversion, integer luma with rounding
 *     (L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16), alpha ignored
 *   - resize: Pillow's separable Lanczos (a=3) resampler, horizontal pass then
 *     vertical pass, 22-bit fixed-point coefficients, 8-bit clamp between passes
 *   - dHash: 9x8, bit set when the RIGHT pixel is brighter than the LEFT
 *     (imagehash: pixels[:, 1:] > pixels[:, :-1]), rows top to bottom
 *   - pHash: 32x32, 2-D DCT-II, top-left 8x8, bit set when the coefficient is
 *     above the median of ALL 64 low-frequency coefficients (DC included)
 *   - hex: 64 bits packed MSB-first, 16 lowercase hex chars
 *
 * Kept byte-for-byte in sync between verifieddit-www/src/utils/perceptualHash.ts
 * and verifieddit-extension/src/perceptualHash.ts. Pure TypeScript, no DOM.
 *
 * History: until 2026-09-02 this used area-average resizing and the opposite
 * gradient direction, so every dHash was the bitwise complement of the store's
 * and the byBinding cross-validation failed for every durable asset.
 */

const PRECISION_BITS = 32 - 8 - 2
const LANCZOS_SUPPORT = 3.0

/** Pillow's RGB -> L: integer luma with rounding. Alpha is ignored, as in PIL. */
export function toGrayscale8 (imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 19595 + data[p + 1] * 38470 + data[p + 2] * 7471 + 0x8000) >> 16
  }
  return out
}

function sinc (x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

function lanczos (x: number): number {
  if (x < -LANCZOS_SUPPORT || x >= LANCZOS_SUPPORT) return 0
  return sinc(x) * sinc(x / LANCZOS_SUPPORT)
}

interface Coeffs { bounds: Int32Array, kk: Int32Array, ksize: number }

/** Port of Pillow's precompute_coeffs + normalize_coeffs_8bpc for one axis. */
function precomputeCoeffs (inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize
  const filterscale = scale < 1 ? 1 : scale
  const support = LANCZOS_SUPPORT * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const kk = new Int32Array(outSize * ksize)
  const ss = 1 / filterscale
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    const w = new Float64Array(xmax)
    let ww = 0
    for (let x = 0; x < xmax; x++) {
      w[x] = lanczos((x + xmin - center + 0.5) * ss)
      ww += w[x]
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? w[x] / ww : w[x]
      // Pillow: (int)(-0.5 + v * (1 << PRECISION_BITS)) for negatives, +0.5 otherwise
      kk[xx * ksize + x] = v < 0
        ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS))
        : Math.trunc(0.5 + v * (1 << PRECISION_BITS))
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  return { bounds, kk, ksize }
}

function clip8 (v: number): number {
  // Pillow: clip8(in) = (in >> PRECISION_BITS) clamped to 0..255, with rounding term added by caller
  const s = v >> PRECISION_BITS
  return s < 0 ? 0 : s > 255 ? 255 : s
}

/**
 * Port of Pillow's ImagingResample for an 8-bit single-band image using the
 * Lanczos filter: horizontal pass, then vertical pass on the 8-bit intermediate.
 */
export function resizeLanczos8 (src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const needH = dstW !== srcW
  const needV = dstH !== srcH
  let cur = src
  let curW = srcW
  const curH = srcH
  if (needH) {
    const { bounds, kk, ksize } = precomputeCoeffs(srcW, dstW)
    const out = new Uint8Array(dstW * srcH)
    for (let y = 0; y < srcH; y++) {
      const row = y * srcW
      for (let xx = 0; xx < dstW; xx++) {
        const xmin = bounds[xx * 2]
        const xmax = bounds[xx * 2 + 1]
        let ss = 1 << (PRECISION_BITS - 1)
        const k = xx * ksize
        for (let x = 0; x < xmax; x++) ss += cur[row + x + xmin] * kk[k + x]
        out[y * dstW + xx] = clip8(ss)
      }
    }
    cur = out
    curW = dstW
  }
  if (needV) {
    const { bounds, kk, ksize } = precomputeCoeffs(srcH, dstH)
    const out = new Uint8Array(curW * dstH)
    for (let yy = 0; yy < dstH; yy++) {
      const ymin = bounds[yy * 2]
      const ymax = bounds[yy * 2 + 1]
      const k = yy * ksize
      for (let x = 0; x < curW; x++) {
        let ss = 1 << (PRECISION_BITS - 1)
        for (let y = 0; y < ymax; y++) ss += cur[(y + ymin) * curW + x] * kk[k + y]
        out[yy * curW + x] = clip8(ss)
      }
    }
    cur = out
  }
  void curH
  return cur
}

/** Grayscale (Pillow L) then Lanczos-resize to targetW x targetH, as imagehash does. */
export function resizeToGrayscale (imageData: ImageData, targetW: number, targetH: number): Uint8Array {
  const gray = toGrayscale8(imageData)
  return resizeLanczos8(gray, imageData.width, imageData.height, targetW, targetH)
}

/** 2-D DCT-II (unnormalised, as scipy.fftpack.dct type 2) of a size x size block; returns the top-left 8x8. */
export function computeDCT8x8 (pixels: ArrayLike<number>, size: number): Float64Array {
  const cosTable = new Float64Array(size * size)
  for (let k = 0; k < size; k++) {
    for (let n = 0; n < size; n++) {
      cosTable[k * size + n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size))
    }
  }
  // scipy applies the DCT along axis 0 (columns) first, then axis 1 (rows).
  const intermediate = new Float64Array(size * size)
  for (let x = 0; x < size; x++) {
    for (let ky = 0; ky < size; ky++) {
      let sum = 0
      for (let y = 0; y < size; y++) sum += pixels[y * size + x] * cosTable[ky * size + y]
      intermediate[ky * size + x] = 2 * sum
    }
  }
  const output = new Float64Array(64)
  for (let ky = 0; ky < 8; ky++) {
    for (let kx = 0; kx < 8; kx++) {
      let sum = 0
      for (let x = 0; x < size; x++) sum += intermediate[ky * size + x] * cosTable[kx * size + x]
      output[ky * 8 + kx] = 2 * sum
    }
  }
  return output
}

/** Pack 64 bits into a 16-char lowercase hex string, MSB-first (imagehash _binary_array_to_hex). */
function bitsToHex (bits: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
    hex += nibble.toString(16)
  }
  return hex
}

/** pHash: 32x32 Lanczos grayscale -> DCT -> top-left 8x8 -> above median of all 64 -> hex. */
export function computePerceptualHash (imageData: ImageData): string {
  const grayscale = resizeToGrayscale(imageData, 32, 32)
  const dctBlock = computeDCT8x8(grayscale, 32)
  const sorted = Array.from(dctBlock).sort((a, b) => a - b)
  const median = (sorted[31] + sorted[32]) / 2
  const bits = new Uint8Array(64)
  for (let i = 0; i < 64; i++) bits[i] = dctBlock[i] > median ? 1 : 0
  return bitsToHex(bits)
}

/** dHash: 9x8 Lanczos grayscale -> per row, bit = right pixel brighter than left -> hex. */
export function computeDifferenceHash (imageData: ImageData): string {
  const grayscale = resizeToGrayscale(imageData, 9, 8)
  const bits = new Uint8Array(64)
  let bitIdx = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = grayscale[y * 9 + x]
      const right = grayscale[y * 9 + x + 1]
      bits[bitIdx++] = right > left ? 1 : 0
    }
  }
  return bitsToHex(bits)
}

/** Hamming distance between two 64-bit hex fingerprints (case-insensitive). */
export function hammingDistance (a: string, b: string): number {
  const x = BigInt('0x' + a) ^ BigInt('0x' + b)
  let count = 0
  let v = x
  while (v > 0n) {
    count += Number(v & 1n)
    v >>= 1n
  }
  return count
}
