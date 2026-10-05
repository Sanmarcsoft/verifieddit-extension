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

/*
 * Federated lookup (#184). Our store is one registry among several. When the
 * signed credentials name a watermark algorithm and its value, the Verifieddit
 * hub can ask the registry that owns that algorithm whether it is registered.
 *
 * Same switch as the probe above, gated here for the same reason. What leaves
 * is the algorithm name and the binding value, both read from the signed
 * claim: no image, no fingerprint computed from pixels, no identifier.
 */
const REGISTRY_HUB_URL = 'https://api.verifieddit.com/api/v1/durable'
const SOFT_BINDING_LABEL = /^c2pa\.soft-binding/
const ALG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/
const MAX_BINDINGS = 4
const MAX_VALUE_LENGTH = 2048

export interface SoftBinding { alg: string, value: string }

interface RegistryAnswer { registry: string, name: string, status: string, matches: unknown[] }

/**
 * The soft bindings declared by a manifest's assertions. Pass only the
 * VALIDATED, claim-bound assertions of the active manifest (see c2pa.ts).
 */
export function softBindingsOf (assertions: ReadonlyArray<{ label?: unknown, data?: unknown }> | null | undefined): SoftBinding[] {
  const out: SoftBinding[] = []
  for (const a of assertions ?? []) {
    if (typeof a?.label !== 'string' || !SOFT_BINDING_LABEL.test(a.label)) continue
    const data = a.data as { alg?: unknown, blocks?: unknown } | null | undefined
    const alg = data?.alg
    if (typeof alg !== 'string' || !ALG_PATTERN.test(alg) || !Array.isArray(data?.blocks)) continue
    for (const block of data.blocks as Array<{ value?: unknown }>) {
      const value = block?.value
      if (typeof value !== 'string' || value === '' || value.length > MAX_VALUE_LENGTH) continue
      if (out.length < MAX_BINDINGS) out.push({ alg, value })
    }
  }
  return out
}

/**
 * The names of the registries that report a credential registered for any of
 * these bindings. Empty when the user has not opted in, and on any failure:
 * an unanswered question confirms nothing.
 */
export async function probeRegistries (bindings: readonly SoftBinding[]): Promise<string[]> {
  try {
    if (bindings.length === 0 || !(await isProbeEnabled())) return []
    const names = new Set<string>()
    for (const { alg, value } of bindings) {
      const params = new URLSearchParams({ alg, value })
      const response = await fetch(`${REGISTRY_HUB_URL}/resolve?${params.toString()}`, { credentials: 'omit' })
      if (!response.ok) continue
      const data = await response.json() as { results?: RegistryAnswer[] }
      if (!Array.isArray(data?.results)) continue
      for (const r of data.results) {
        if (r?.status === 'match' && Array.isArray(r.matches) && r.matches.length > 0 && typeof r.name === 'string') names.add(r.name)
      }
    }
    return [...names]
  } catch {
    return []
  }
}
