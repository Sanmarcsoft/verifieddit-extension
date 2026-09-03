/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { createC2pa, type C2paSdk, type Manifest, type ManifestStore as C2paRsStore } from '@contentauth/c2pa-web'
import { type CertificateInfoExtended } from './certs/certs.js'
import { decode as coseDecode, type TSTInfo, type COSE_Sign1 } from './certs/cose.js'
import { isContentBox, decode as jumbfDecode } from './certs/jumbf.js'
import { getManifestFromMetadata } from './certs/metadata.js'
import { AWAIT_ASYNC_RESPONSE, MSG_C2PA_VALIDATE_URL, type MSG_PAYLOAD } from './constants.js'
import { type TrustListMatch } from './trustlistProxy.js'
import { type DurablePillars, hasSoftBinding } from './durableCredentials.js'
import { probeManifestStore } from './manifestStore.js'
import { buildProvenanceGraph } from './provenanceGraph.js'
import { type ProvenanceGraph } from './provenanceTypes.js'
import { detectAiGeneration, type AiGeneration } from './aiDetection.js'
import { blobToDataURL } from './utils.js'

// TranslatedDictionaryCategory came from the old `c2pa` SDK's
// selectEditsAndActivity helper, which has no equivalent in
// @contentauth/c2pa-web. editsAndActivity is now always null (see below), but
// the element shape is preserved so the existing UI (webComponents.ts reads
// `.icon` and `.description` off each entry) still type-checks against the
// public C2paResult contract.
export interface TranslatedDictionaryCategory {
  icon: string | null
  label: string
  description: string
}

let c2pa: C2paSdk | null = null

export interface C2paResult extends ExtensionC2paResult {
  url: string
  certChain: CertificateInfoExtended[] | null
  tstTokens: TSTInfo[] | null
  trustList: TrustListMatch | null
  tsaTrustList: TrustListMatch | null
  editsAndActivity: TranslatedDictionaryCategory[] | null
  // Assertion labels harvested from the manifest JUMBF (e.g. 'c2pa.hash.data',
  // 'c2pa.soft_binding'). Used to detect Durable Content Credentials offline.
  assertionLabels: string[]
  // Durable Content Credentials "3 pillars" verdict. Computed in the
  // background service worker once trust + timestamp signals are known.
  durablePillars: DurablePillars | null
  // True when a live manifest-store byBinding probe confirmed this asset's
  // credential is REGISTERED and recoverable (Pillar 3 'verified'). Probed in
  // the offscreen/background validate path where the image bytes are available.
  manifestStoreVerified: boolean
  // Whether the asset DECLARES AI generation, read from the IPTC
  // digitalSourceType in its own c2pa.actions assertion. Never inferred from
  // who signed it — see aiDetection.ts.
  aiGeneration: AiGeneration
  // The declared digitalSourceType URI, verbatim, or null when none is present.
  digitalSourceType: string | null
  // Portable provenance graph (manifests, ingredients, assertions, sensors)
  // built from the RAW c2pa-rs store before it is flattened into
  // ExtensionC2paResult. Same node/edge contract that verifieddit.com and
  // trusteddit.com render — see provenanceGraph.ts. Null when the store has no
  // diagrammable content.
  provenanceGraph: ProvenanceGraph | null
}

export interface C2paError extends Error {
  url: string
}

// The wire helpers that flatten a C2paError for extension messaging live in
// c2paWire.ts. They must not live here: this module initialises the WASM engine
// on import, and importing a runtime value from it drags that init into the
// service worker (no `Worker` there) and the content script.

export async function init (): Promise<void> {
  const wasmUrl = chrome.runtime.getURL('c2pa.wasm')

  // Firefox MV3 forbids blob: workers in the extension page CSP (and strips
  // blob: from the manifest CSP), so c2pa-web's default blob worker is blocked.
  // c2pa-web 0.11+ supports a native `workerSrc` (a URL) — point it at the
  // packaged worker file (a chrome-/moz-extension URL, allowed by 'self'),
  // which works in both browsers and avoids the blocked blob: worker. No patch.
  const workerUrl = new URL(chrome.runtime.getURL('c2pa-web.worker.js'))

  createC2pa({ wasmSrc: wasmUrl, workerSrc: workerUrl })
    .then(
      (newC2pa) => {
        c2pa = newC2pa
        // Clear any prior init error so popups don't render a stale banner.
        // NOTE: this module now runs in the offscreen document, whose restricted
        // API surface may not expose chrome.storage — guard chrome.storage too,
        // not just .session, or the success path throws (#134 follow-up).
        void chrome.storage?.session?.remove('c2paInitError')
      },
      (error: unknown) => {
        // WASM init failure leaves c2pa null forever. Surface to the popup
        // via chrome.storage.session (ephemeral, no persistence) so the user
        // sees a banner instead of silently empty badge state.
        const message = error instanceof Error ? error.message : String(error)
        void chrome.storage?.session?.set({ c2paInitError: message })
      }
    )

  chrome.runtime.onMessage.addListener(
    (request: MSG_PAYLOAD, sender, sendResponse) => {
      if (request.action === MSG_C2PA_VALIDATE_URL) {
        void validateUrl(request.data as string).then(sendResponse)
        return AWAIT_ASYNC_RESPONSE
      }
    }
  )
}

/**
 * Build the provenance graph without letting it affect the verdict.
 *
 * buildProvenanceGraph walks a manifest store that came out of a stranger's
 * media file. It is written defensively, but the diagram is cosmetic and the
 * verdict is not: a malformed store must degrade to "no diagram", never to a
 * failed validation.
 */
function safeProvenanceGraph (store: C2paRsStore, filename: string): ProvenanceGraph | null {
  try {
    return buildProvenanceGraph(store, filename)
  } catch (error: unknown) {
    console.debug('provenance graph skipped:', error)
    return null
  }
}

export async function validateUrl (url: string): Promise<C2paResult | C2paError> {
  if (c2pa == null) {
    return new Error('C2PA not initialized') as C2paError
  }

  // Fetch the asset bytes ourselves so we can both (a) hand the blob to the new
  // c2pa-web reader and (b) re-parse the raw JUMBF/COSE for the trust +
  // timestamp logic (extractC2paManifest below).
  let blob: Blob
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return { message: `Fetch failed: ${response.status} ${response.statusText}`, url, name: 'Fetch Error' } satisfies C2paError
    }
    blob = await response.blob()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { message, url, name: 'Fetch Error' } satisfies C2paError
  }

  // reader is null when the asset carries no C2PA metadata.
  const reader = await c2pa.reader.fromBlob(blob.type, blob)
  if (reader == null) {
    return { message: 'No manifest found', url, name: 'No Manifest' } satisfies C2paError
  }

  const store: C2paRsStore = await reader.manifestStore()

  if (store.active_manifest == null || store.manifests == null || store.manifests[store.active_manifest] == null) {
    return { message: 'No manifest found', url, name: 'No Manifest' } satisfies C2paError
  }

  const serializedResult = await serializeC2paStore(store, blob, url)

  // Re-parse the raw bytes for the COSE signature (certificate chain + RFC 3161
  // timestamp). This preserves the offline trust + timestamp verification path.
  const sourceBytes = new Uint8Array(await blob.arrayBuffer())
  const cose = await extractC2paManifest(blob.type, sourceBytes)

  // Source the soft-binding signal from the VALIDATED, claim-bound assertions of
  // the ACTIVE manifest (issue #113) — never raw JUMBF box labels, which an
  // attacker can add outside the signed claim to forge a durable verdict.
  const activeManifest: Manifest = store.manifests[store.active_manifest]
  const assertionLabels: string[] = (activeManifest.assertions ?? [])
    .map((a) => a?.label)
    .filter((label): label is string => typeof label === 'string')

  // selectEditsAndActivity has no equivalent in @contentauth/c2pa-web; the
  // edits/activity UI panel is fed null for this pass.
  const editsAndActivity: TranslatedDictionaryCategory[] | null = null

  // Durable Content Credentials — Pillar 3 (cloud-recoverable). When the asset
  // DECLARES a soft binding (P2) and is an image, probe the manifest store with
  // its perceptual fingerprint to confirm the credential is actually REGISTERED
  // and recoverable. Only computed fingerprints are sent (privacy); failure
  // fails closed to 'declared'. Done here in the offscreen/background validate
  // path because the decoded image bytes are available.
  let manifestStoreVerified = false
  if (hasSoftBinding(assertionLabels) && blob.type.startsWith('image/')) {
    manifestStoreVerified = await probeManifestStore(blob)
  }

  // AI generation is a claim the producer signed about the CONTENT, so it is
  // read from the active manifest's own actions assertion, not from the signer.
  const aiDetection = detectAiGeneration(activeManifest)

  const result: C2paResult = {
    ...serializedResult,
    url,
    trustList: null,
    tsaTrustList: null,
    certChain: cose?.unprotected?.x5chain ?? cose?.protected.x5chain ?? null,
    tstTokens: cose?.unprotected?.sigTst?.tstTokens ?? null,
    editsAndActivity,
    assertionLabels,
    manifestStoreVerified,
    // Built from the raw store — the flattened ExtensionC2paResult has already
    // dropped relationships, per-ingredient validation, and assertion payloads.
    // The diagram is a display affordance walking attacker-supplied structure;
    // it must never be able to turn a valid asset into a failed validation, so
    // a throw degrades to "no diagram", not to an error verdict.
    aiGeneration: aiDetection.generation,
    digitalSourceType: aiDetection.digitalSourceType,
    provenanceGraph: safeProvenanceGraph(store, serializedResult.source.filename),
    // Computed downstream in the background SW (detectDurablePillars) once the
    // timestamp/trust signals are resolved.
    durablePillars: null
  }

  return result
}

/**
 * Decode the manifest JUMBF once and return both the COSE signature (for the
 * certificate chain / RFC 3161 timestamp) and the full set of assertion box
 * labels (for Durable Content Credentials detection). The JUMBF decoder
 * flattens every labelled box recursively, so `assertionLabels` includes
 * nested assertions such as `c2pa.hash.data` and `c2pa.soft_binding`.
 */
export async function extractManifestParts (type: string, mediaBuffer: Uint8Array): Promise<{ cose: COSE_Sign1 | null, assertionLabels: string[] }> {
  const rawManifestBuffer = getManifestFromMetadata(type, mediaBuffer)
  if (rawManifestBuffer == null) {
    return { cose: null, assertionLabels: [] }
  }

  /*
    The manifest buffer is decoded into a JUMBF structure.
  */
  const jumbf = jumbfDecode(rawManifestBuffer)

  // Every labelled box (signature, claim, and each assertion) is registered
  // flat in jumbf.labels by the decoder.
  const assertionLabels = Object.keys(jumbf.labels)

  /*
    C2PA manifest files are expected to have a jumbf box with a label 'c2pa.signature' containing a cbor box
  */
  const jumbfBox = jumbf.labels['c2pa.signature']
  if (jumbfBox == null || jumbfBox.boxes.length === 0 || jumbfBox.boxes[0].type !== 'cbor') {
    return { cose: null, assertionLabels }
  }

  const contentBox = jumbfBox.boxes[0]

  /*
    The first, and only box, should have a 'cbor' type
  */
  if (contentBox?.type !== 'cbor' || !isContentBox(contentBox)) {
    return { cose: null, assertionLabels }
  }

  const coseData = contentBox.data

  const cose = await coseDecode(coseData)

  return { cose, assertionLabels }
}

/**
 * Backwards-compatible wrapper returning only the COSE signature.
 */
export async function extractC2paManifest (type: string, mediaBuffer: Uint8Array): Promise<COSE_Sign1 | null> {
  return (await extractManifestParts(type, mediaBuffer)).cose
}

void init()

export type dataUrl = string

export interface ExtensionC2paIngredient {
  title: string
  format: string
  instanceId: string
  thumbnail: {
    type: string
    data: dataUrl
  }
}

export interface ExtensionC2paManifest {
  key: string
  title: string
  format: string
  claimGenerator: string
  signatureInfo: {
    issuer: string
  }
  ingredients: ExtensionC2paIngredient[]
}

export interface ExtensionC2paResult {
  manifestStore: {
    manifests: ExtensionC2paManifest[]
    activeManifest: number
    validationStatus: string[]
  }
  source: {
    thumbnail: {
      type: string
      data: dataUrl
    }
    type: string
    data: dataUrl
    filename: string
  }
}

/**
 * Maps the c2pa-rs JSON manifest store (snake_case, from @contentauth/c2pa-web)
 * into the EXISTING ExtensionC2paResult shape the UI contract depends on.
 */
async function serializeC2paStore (store: C2paRsStore, blob: Blob, url: string): Promise<ExtensionC2paResult> {
  const c2paManifests = store.manifests ?? {}
  const manifestEntries = Object.entries(c2paManifests)

  const manifests: ExtensionC2paManifest[] = manifestEntries.map(([label, manifest]) => {
    const ingredients: ExtensionC2paIngredient[] = (manifest.ingredients ?? []).map((ingredient) => ({
      title: ingredient.title ?? '',
      format: ingredient.format ?? '',
      instanceId: ingredient.instance_id ?? '',
      // Ingredient thumbnails are left empty for this pass — the c2pa-web reader
      // exposes them as resource-store URIs (resourceToBytes), not inline blobs.
      thumbnail: {
        type: '',
        data: ''
      }
    }))

    return {
      key: label,
      title: manifest.title ?? '',
      format: manifest.format ?? '',
      claimGenerator: manifest.claim_generator ?? manifest.claim_generator_info?.[0]?.name ?? '',
      signatureInfo: {
        issuer: manifest.signature_info?.issuer ?? ''
      },
      ingredients
    }
  })

  // activeManifest is the INDEX of the active label within the manifests array
  // (the UI keys into manifests[activeManifest]). Defaults to 0 if not found.
  const activeIndex = manifestEntries.findIndex(([label]) => label === store.active_manifest)
  const activeManifestIndex = activeIndex >= 0 ? activeIndex : 0

  // validationStatus is a flat list of status codes (string[]).
  const validationStatus: string[] = (store.validation_status ?? [])
    .map((status) => status.code)
    .filter((code): code is string => typeof code === 'string' && code.length > 0)

  // Source-blob inlining budget. Raw bytes above this threshold would produce
  // a base64 data URL that is then structured-cloned four times across
  // inject → background → content-script → overlay-iframe, silently saturating
  // chrome.runtime/chrome.tabs/postMessage and leaving the CR overlay click
  // inert on large real-world C2PA-signed media (e.g. the 4.7 MB CBC fixture).
  // Below the threshold we inline as before; above it we emit the empty string
  // and rely on the overlay's existing thumbnail path + the caller's URL.
  const SOURCE_INLINE_MAX_BYTES = 512 * 1024
  const isImage = blob.type.startsWith('image/')
  const thumbnailData: dataUrl =
    (isImage && blob.size < SOURCE_INLINE_MAX_BYTES)
      ? await blobToDataURL(blob)
      : ''

  // Derive a filename from the URL basename.
  let filename = ''
  try {
    const pathname = new URL(url).pathname
    filename = pathname.substring(pathname.lastIndexOf('/') + 1)
  } catch {
    const stripped = url.split('?')[0].split('#')[0]
    filename = stripped.substring(stripped.lastIndexOf('/') + 1)
  }

  return {
    manifestStore: {
      manifests,
      activeManifest: activeManifestIndex,
      validationStatus
    },
    source: {
      thumbnail: {
        type: blob.type,
        data: thumbnailData
      },
      type: blob.type,
      // Raw source data URL was never populated by the old serializer either
      // beyond the thumbnail; leave empty (overlay falls back to URL/thumbnail).
      data: '',
      filename
    }
  }
}
