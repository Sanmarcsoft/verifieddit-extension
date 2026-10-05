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
import { type RecoveredCredential } from './recovered'

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

/**
 * Whether the online check is on. `enabled` is the caller's answer and wins when
 * given: in Chrome this code runs in an offscreen document, which cannot read
 * chrome.storage, so the background reads the switch and passes it in.
 */
async function checkIsOn (enabled?: boolean): Promise<boolean> {
  return enabled ?? await isProbeEnabled()
}

export async function probeManifestStore (blob: Blob, enabled?: boolean): Promise<boolean> {
  try {
    if (!(await checkIsOn(enabled))) return false
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
// The spec spells it with a hyphen; our own signer currently writes an underscore
// and nests the value (verifieddit-www#495). Read both until the signer is fixed.
const SOFT_BINDING_LABEL = /^c2pa\.soft[-_]binding/
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
    for (const block of data.blocks as Array<{ value?: unknown, binding?: { binding_key?: unknown } }>) {
      const value = block?.value ?? block?.binding?.binding_key
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
export async function probeRegistries (bindings: readonly SoftBinding[], enabled?: boolean): Promise<string[]> {
  try {
    if (bindings.length === 0 || !(await checkIsOn(enabled))) return []
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

/*
 * Recovery of a stripped image (#184). When the Content Credentials have been
 * removed, nothing in the file says where they went. What survives is the
 * picture, so its fingerprint is looked up in our registry and, on a match, the
 * registered record says who signed the original and when.
 *
 * Same opt-in as everything else here, and the caller only invokes it on an
 * explicit Verify, never on auto-scan: with auto-scan it would send a
 * fingerprint of every unsigned image a person browses past.
 *
 * A match is a lead. The copy in hand may have been edited since it was signed;
 * the registry only says a credential exists for a picture this similar.
 */
export { recoveredNote, type RecoveredCredential } from './recovered'

const MANIFEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

export async function recoverByFingerprint (fp: { phash: string, dhash: string }, enabled?: boolean): Promise<RecoveredCredential | null> {
  try {
    if (!(await checkIsOn(enabled))) return null
    const params = new URLSearchParams({ alg: 'phash', value: fp.phash, crossAlg: 'dhash', crossValue: fp.dhash })
    const response = await fetch(`${MANIFEST_STORE_URL}/matches/byBinding?${params.toString()}`, { credentials: 'omit' })
    if (!response.ok) return null
    const best = (await response.json() as ByBindingResponse)?.matches?.[0]
    if (best == null || typeof best.manifestId !== 'string' || !MANIFEST_ID.test(best.manifestId)) return null
    const record = await fetch(`${MANIFEST_STORE_URL}/manifests/${best.manifestId}?format=json`, { credentials: 'omit' })
    if (!record.ok) return null
    const meta = await record.json() as { signerCn?: unknown, signedAt?: unknown, filename?: unknown } | null
    if (meta == null) return null
    const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v.slice(0, 200) : null
    return {
      registry: 'SanMarcSoft Manifest Store',
      manifestId: best.manifestId,
      similarityScore: typeof best.similarityScore === 'number' ? best.similarityScore : 0,
      signerCn: text(meta.signerCn),
      signedAt: text(meta.signedAt),
      filename: text(meta.filename)
    }
  } catch {
    return null
  }
}

/** Recovery for an image blob: fingerprints are computed here, on the device. */
export async function recoverStripped (blob: Blob, enabled?: boolean): Promise<RecoveredCredential | null> {
  if (!(await checkIsOn(enabled))) return null
  const imageData = await blobToImageData(blob)
  if (imageData == null) return null
  return await recoverByFingerprint({ phash: computePerceptualHash(imageData), dhash: computeDifferenceHash(imageData) }, true)
}

/*
 * Does the registry's record agree with the file in hand (#184)? For a file
 * that carries credentials and names a TrustMark binding, fetch the record our
 * registry holds for that binding and compare. Only the binding value is sent;
 * the file's hash is computed and compared here, on the device.
 */
export interface RegistryRecord {
  registry: string
  manifestId: string
  signerCn: string | null
  signedAt: string | null
  /** true: this is the registered file. false: it differs. null: the registry holds no hash. */
  sameFile: boolean | null
}

const OUR_ALGS = /^(trustmark|com\.adobe\.trustmark\..+)$/

export async function checkRegistryRecord (blob: Blob, bindings: readonly SoftBinding[], enabled?: boolean): Promise<RegistryRecord | null> {
  try {
    const binding = bindings.find((b) => OUR_ALGS.test(b.alg))
    if (binding == null || !(await checkIsOn(enabled))) return null
    const params = new URLSearchParams({ alg: 'trustmark', value: binding.value })
    const response = await fetch(`${MANIFEST_STORE_URL}/matches/byBinding?${params.toString()}`, { credentials: 'omit' })
    if (!response.ok) return null
    const best = (await response.json() as ByBindingResponse)?.matches?.[0]
    if (best == null || typeof best.manifestId !== 'string' || !MANIFEST_ID.test(best.manifestId)) return null
    const record = await fetch(`${MANIFEST_STORE_URL}/manifests/${best.manifestId}?format=json`, { credentials: 'omit' })
    if (!record.ok) return null
    const meta = await record.json() as { signerCn?: unknown, signedAt?: unknown, fileHash?: unknown } | null
    if (meta == null) return null
    const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v.slice(0, 200) : null
    const registered = text(meta.fileHash)?.replace(/^sha256:/i, '').toLowerCase() ?? null
    let sameFile: boolean | null = null
    if (registered != null) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
      sameFile = Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('') === registered
    }
    return { registry: 'SanMarcSoft Manifest Store', manifestId: best.manifestId, signerCn: text(meta.signerCn), signedAt: text(meta.signedAt), sameFile }
  } catch {
    return null
  }
}
