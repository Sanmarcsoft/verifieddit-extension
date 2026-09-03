/*
 * SanMarcSoft Manifest Store probe — confirms Durable Content Credentials
 * Pillar 3 (cloud-recoverable). Given an image, compute its perceptual
 * fingerprints (pHash + dHash) and ask the manifest store whether a credential
 * is REGISTERED for it (byBinding recovery). A match upgrades P3 from
 * 'declared' to 'verified'.
 *
 * Privacy: OFF unless the user opts in (MANIFEST_STORE_PROBE_KEY). This is the
 * extension's only automatic outbound request, so it is gated at the single
 * entry point below rather than at the call site, and no caller can reach the
 * network by forgetting the check. Only computed hex fingerprints leave the
 * browser — never image bytes — but a perceptual hash of what someone is
 * viewing is still information about what they are viewing, which is why it is
 * a choice rather than a default. Network/parse failures fail CLOSED (probe
 * returns false → P3 stays 'declared'), so we never falsely claim a credential
 * is registered.
 *
 * Endpoint contract mirrors verifieddit-www/src/utils/manifestStoreClient.ts.
 */
import { computeDifferenceHash, computePerceptualHash } from './perceptualHash'
import { MANIFEST_STORE_PROBE_DEFAULT, MANIFEST_STORE_PROBE_KEY } from './constants'

const MANIFEST_STORE_URL = 'https://manifests.sanmarcsoft.com/v1'

interface ManifestMatch { manifestId: string, similarityScore: number, algorithm: string }
interface ByBindingResponse { matches: ManifestMatch[] }

/**
 * Decode an image Blob into ImageData using OffscreenCanvas — available in the
 * offscreen document (Chrome) and the background page (Firefox). Returns null
 * if the blob is not a decodable image.
 */
export async function blobToImageData (blob: Blob): Promise<ImageData | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (ctx == null) { bitmap.close(); return null }
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return imageData
  } catch {
    return null
  }
}

/**
 * True iff the manifest store has a credential registered for this image's
 * perceptual fingerprint (byBinding, pHash with dHash cross-validation).
 * Fails closed (false) on any decode/network/parse error.
 */
export async function isProbeEnabled (): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(MANIFEST_STORE_PROBE_KEY)
    return stored?.[MANIFEST_STORE_PROBE_KEY] ?? MANIFEST_STORE_PROBE_DEFAULT
  } catch {
    // Storage unreadable: treat as not opted in. Failing closed on a privacy
    // switch means the quiet outcome is the private one.
    return MANIFEST_STORE_PROBE_DEFAULT
  }
}

export async function probeManifestStore (blob: Blob): Promise<boolean> {
  try {
    if (!(await isProbeEnabled())) return false
    const imageData = await blobToImageData(blob)
    if (imageData == null) return false
    const phash = computePerceptualHash(imageData)
    const dhash = computeDifferenceHash(imageData)
    const params = new URLSearchParams({ alg: 'phash', value: phash, crossAlg: 'dhash', crossValue: dhash })
    const response = await fetch(`${MANIFEST_STORE_URL}/matches/byBinding?${params.toString()}`, { credentials: 'omit' })
    if (!response.ok) return false // 404 = not registered, anything else = unknown → fail closed
    const data = await response.json() as ByBindingResponse
    return Array.isArray(data?.matches) && data.matches.length > 0
  } catch {
    return false
  }
}
