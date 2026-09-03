/*
 * Perceptual hashing for Durable Content Credentials — Pillar 3 (manifest-store
 * recoverability). Computes pHash (DCT-based) and dHash (gradient-based)
 * fingerprints from image pixels, used to query the SanMarcSoft Manifest Store
 * (byBinding) and confirm a credential is REGISTERED and recoverable.
 *
 * Ported verbatim from verifieddit-www/src/utils/perceptualHash.ts so the
 * fingerprints match exactly what the manifest store indexed. Pure TypeScript,
 * no DOM — operates on an ImageData produced by the caller (see manifestStore.ts
 * blobToImageData). Keep byte-for-byte in sync with the www implementation; a
 * drift in either changes the hash and breaks recovery matching.
 */

/** Resize an ImageData to targetW×targetH grayscale (BT.601), area-averaged. */
export function resizeToGrayscale (imageData: ImageData, targetW: number, targetH: number): Float64Array {
  const { data, width: srcW, height: srcH } = imageData
  const result = new Float64Array(targetW * targetH)
  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      const srcX0 = (tx * srcW) / targetW
      const srcX1 = ((tx + 1) * srcW) / targetW
      const srcY0 = (ty * srcH) / targetH
      const srcY1 = ((ty + 1) * srcH) / targetH
      let sum = 0
      let count = 0
      const iy0 = Math.floor(srcY0)
      const iy1 = Math.min(Math.ceil(srcY1), srcH)
      const ix0 = Math.floor(srcX0)
      const ix1 = Math.min(Math.ceil(srcX1), srcW)
      for (let sy = iy0; sy < iy1; sy++) {
        for (let sx = ix0; sx < ix1; sx++) {
          const idx = (sy * srcW + sx) * 4
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]
          sum += gray
          count++
        }
      }
      result[ty * targetW + tx] = count > 0 ? sum / count : 0
    }
  }
  return result
}

/** 2D DCT-II of a size×size grayscale image; returns the top-left 8×8 block. */
export function computeDCT8x8 (grayscale: Float64Array, size: number): Float64Array {
  const cosTable = new Float64Array(size * size)
  for (let k = 0; k < size; k++) {
    for (let n = 0; n < size; n++) {
      cosTable[k * size + n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size))
    }
  }
  const intermediate = new Float64Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let k = 0; k < size; k++) {
      let sum = 0
      for (let x = 0; x < size; x++) {
        sum += grayscale[y * size + x] * cosTable[k * size + x]
      }
      intermediate[y * size + k] = sum
    }
  }
  const output = new Float64Array(64)
  for (let ky = 0; ky < 8; ky++) {
    for (let kx = 0; kx < 8; kx++) {
      let sum = 0
      for (let y = 0; y < size; y++) {
        sum += intermediate[y * size + kx] * cosTable[ky * size + y]
      }
      output[ky * 8 + kx] = sum
    }
  }
  return output
}

/** Pack a 64-element bit array into a 16-char hex string (MSB-first per nibble). */
function bitsToHex (bits: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
    hex += nibble.toString(16)
  }
  return hex
}

/** pHash: 32×32 grayscale → DCT → 8×8 top-left → threshold at AC median → 64-bit hex. */
export function computePerceptualHash (imageData: ImageData): string {
  const grayscale = resizeToGrayscale(imageData, 32, 32)
  const dctBlock = computeDCT8x8(grayscale, 32)
  const acCoefficients = Array.from(dctBlock.slice(1))
  acCoefficients.sort((a, b) => a - b)
  const mid = Math.floor(acCoefficients.length / 2)
  const median = acCoefficients.length % 2 === 0
    ? (acCoefficients[mid - 1] + acCoefficients[mid]) / 2
    : acCoefficients[mid]
  const bits = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    bits[i] = dctBlock[i] > median ? 1 : 0
  }
  return bitsToHex(bits)
}

/** dHash: 9×8 grayscale → per-row left>right gradient → 64-bit hex. */
export function computeDifferenceHash (imageData: ImageData): string {
  const grayscale = resizeToGrayscale(imageData, 9, 8)
  const bits = new Uint8Array(64)
  let bitIdx = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = grayscale[y * 9 + x]
      const right = grayscale[y * 9 + x + 1]
      bits[bitIdx++] = left > right ? 1 : 0
    }
  }
  return bitsToHex(bits)
}
