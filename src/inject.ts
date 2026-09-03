/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { type C2paError, type C2paResult } from './c2pa'
// Value import: must come from the side-effect-free wire module, or the whole
// WASM engine is inlined into every page this content script runs on.
import { isC2paErrorWire, fromC2paErrorWire } from './c2paWire'
import { type ProvenanceGraph } from './provenanceTypes.js'
import { type MediaElement } from './content'
import { CrIcon } from './icon'
import { checkTrustListInclusion, loadTrustLists } from './trustlist'
import { type MediaRecord, type MediaVerdict } from './mediaRecord'
import * as VisibilityMonitor from './visible'
import { MediaMonitor } from './mediaMonitor' // requires treeshake: { moduleSideEffects: [path.resolve('src/mediaMonitor.ts')] }, in rollup.config.js
import {
  MSG_CHILD_REQUEST, MSG_FRAME_CLICK, MSG_GET_CONTAINER_OFFSET, MSG_PARENT_RESPONSE,
  MSG_REQUEST_C2PA_ENTRIES, MSG_RESPONSE_C2PA_ENTRIES, MSG_TRUSTLIST_UPDATE, MSG_OPEN_OVERLAY,
  type VALIDATION_STATUS, MSG_FORWARD_TO_CONTENT, MSG_C2PA_RESULT_FROM_CONTEXT, MSG_GET_ID,
  MSG_VALIDATE_URL, MSG_RESPONSE_C2PA_SUMMARY
} from './constants'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

interface TabAndFrameId {
  tab: number
  frame: number
}

const topLevelFrame = window === window.top
let messageCounter = 0
// const media = new Map<MediaElement, { validation: C2paResult, icon: CrIcon, status: VALIDATION_STATUS }>()
let _id: TabAndFrameId | undefined

/**
 * Resolve this frame's tab/frame id, retrying until the service worker answers.
 *
 * This was previously a single fire-and-forget call whose rejection was
 * swallowed. MV3 tears the service worker down aggressively, so a content
 * script that loads while it is suspended got no answer, left `_id` undefined
 * for the life of the page, and every later "Verify with Verifieddit" was
 * dropped by a guard that required it — with no error anywhere.
 */
async function resolveFrameId (): Promise<TabAndFrameId | undefined> {
  if (_id != null) return _id
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const id = await chrome.runtime.sendMessage({ action: MSG_GET_ID }) as TabAndFrameId | undefined
      if (id?.frame != null) {
        _id = id
        return _id
      }
    } catch {
      // SW asleep, or extension context invalidated mid-flight. Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
  return undefined
}

void resolveFrameId()

if (window.location.href.startsWith('chrome-extension:') || window.location.href.startsWith('moz-extension:')) {
  throw new Error('Ignoring extension IFrame')
}

window.addEventListener('message', (event) => {
  const message = event.data
  if (message.type === MSG_CHILD_REQUEST) {
    if (event.source == null) {
      throw new Error('event.source is null')
    }
    const sender = findChildFrame(event.source)
    if (sender === null) {
      return // not from a child frame
    }
    const payload = message.data
    if (payload?.type === MSG_GET_CONTAINER_OFFSET) {
      const contentWindow = sender.contentWindow
      if (contentWindow === null) {
        throw new Error('contentWindow is null')
      }
      void getParentOffset().then((parentOffsets) => {
        const senderRect = sender.getBoundingClientRect()
        const combinedOffset = combineOffsets(senderRect, parentOffsets)
        contentWindow.postMessage({ type: MSG_PARENT_RESPONSE, data: combinedOffset, id: message.id }, event.origin)
      })
    }
  }
})

function findChildFrame (sender: MessageEventSource): HTMLIFrameElement | null {
  const childIFrames = Array.from(document.querySelectorAll('iframe'))
  for (const iframe of childIFrames) {
    const contentWindow = iframe.contentWindow
    if (contentWindow === null) {
      throw new Error('contentWindow is null')
    }
    if (sender === contentWindow) {
      return iframe
    }
  }
  // child frames not found, look for shadow roots
  const divs = Array.from(document.getElementsByTagName('div'))
  const shadowRoots = divs.filter(div => div.shadowRoot != null) as HTMLElement[]
  for (const shadowRoot of shadowRoots) {
    const iFrames = Array.from(shadowRoot.shadowRoot?.querySelectorAll('iframe') ?? [])
    for (const iframe of iFrames) {
      const contentWindow = iframe.contentWindow
      if (contentWindow === null) {
        throw new Error('contentWindow is null')
      }
      if (sender === contentWindow) {
        return iframe
      }
    }
  }

  return null
}

async function postWithResponse <T> (message: unknown): Promise<T> {
  return await new Promise((resolve) => {
    const counter = messageCounter++
    const listener = (event: MessageEvent): void => {
      if (event.data.id === counter && event.data.type === MSG_PARENT_RESPONSE && event.source === window.parent) {
        resolve(event.data.data as T)
        window.removeEventListener('message', listener)
      }
    }
    window.addEventListener('message', listener)
    // #123: drop `src: document.location.href` — the receiver never reads it and
    // it leaked the frame URL to any listener. The remaining payload is
    // non-sensitive frame-geometry coordination; the receiver authenticates the
    // sender via `event.source === window.parent`.
    window.parent.postMessage({ type: MSG_CHILD_REQUEST, data: message, id: counter }, '*')
  })
}

async function handleValidationResult (mediaElement: MediaElement, c2paResult: C2paResult | C2paError): Promise<void> {
  // rc11.7 / #86 — the user explicitly right-click → Verify'd this image.
  // Always produce a visible interactive icon, even when the result has
  // no embedded C2PA manifest. Previously this path early-returned and
  // the user saw nothing happen. The 'no-credentials' badge now renders
  // a distinct grey-camera-with-red-slash so users can see the verifier
  // DID run and found nothing.
  const mediaRecord = MediaMonitor.lookup(mediaElement)
  if (mediaRecord == null) {
    return
  }

  if (c2paResult instanceof Error || c2paResult.manifestStore == null) {
    const failure = c2paResult as C2paError
    const name = failure.name
    const url = failure?.url ?? mediaRecord.src

    // "We looked and found nothing" and "we could not look" are different
    // claims, and only the first one is a statement about the file. Reporting
    // a fetch failure or an uninitialised engine as "this file has no C2PA
    // manifest" tells the user a signed asset is unsigned — the worst verdict
    // a verifier can get wrong. Both branches previously fell through to the
    // same 'no-credentials' badge.
    if (name === 'No Manifest') {
      // Create (or update) an icon in the 'no-credentials' state so the
      // user gets clear feedback. Click handler opens a minimal panel —
      // no API call, just explanatory text (respects #83 security baseline).
      mediaRecord.state.verdict = { kind: 'no-credentials', url, detail: null }
      ensureNoCredentialsIcon(mediaRecord, url)
    } else {
      const detail = failure.message ?? 'unknown error'
      mediaRecord.state.verdict = { kind: 'unavailable', url, detail }
      ensureVerificationFailedIcon(mediaRecord, url, detail)
    }
    return
  }

  mediaRecord.state.c2pa = c2paResult
  mediaRecord.state.verdict = null

  setIcon(mediaRecord)
}

const NO_CREDENTIALS_NOTE = `No embedded content credentials were found for this image. ` +
  `The file has no C2PA manifest, so nothing cryptographic can be verified locally.`

function unavailableNote (detail: string): string {
  return `Verification could not be completed for this image, so its ` +
    `Content Credentials are unknown. This is NOT a finding that the file is ` +
    `unsigned — the check itself failed. Details: ${detail}`
}

function ensureNoCredentialsIcon (mediaRecord: MediaRecord, url: string): void {
  // The click handler is re-bound on the existing-icon path too. Auto-scan
  // creates a neutral 'img' badge first and wires it to open the C2PA overlay;
  // upgrading only the artwork left that stale handler in place, so a faded
  // no-credentials badge still tried to open an overlay for a manifest that
  // does not exist and appeared inert when it silently gave up.
  if (mediaRecord.icon != null) {
    mediaRecord.icon.status = 'no-credentials'
    mediaRecord.icon.setMetadataLink(url)
    mediaRecord.icon.onClick = () => { showNoCredentialsToast(NO_CREDENTIALS_NOTE, url) }
    mediaRecord.icon.show()
    return
  }
  mediaRecord.onReady = (mr: MediaRecord): void => {
    mr.icon = new CrIcon(mr.element, 'no-credentials')
    mr.icon.setMetadataLink(url)
    mr.icon.onClick = () => { showNoCredentialsToast(NO_CREDENTIALS_NOTE, url) }
  }
}

function ensureVerificationFailedIcon (mediaRecord: MediaRecord, url: string, detail: string): void {
  const note = unavailableNote(detail)

  if (mediaRecord.icon != null) {
    mediaRecord.icon.status = 'error'
    mediaRecord.icon.setMetadataLink(url)
    mediaRecord.icon.onClick = () => { showNoCredentialsToast(note, url) }
    mediaRecord.icon.show()
    return
  }
  mediaRecord.onReady = (mr: MediaRecord): void => {
    mr.icon = new CrIcon(mr.element, 'error')
    mr.icon.setMetadataLink(url)
    mr.icon.onClick = () => { showNoCredentialsToast(note, url) }
  }
}

async function getParentOffset (): Promise<Rect> {
  if (topLevelFrame) {
    return {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0
    }
  }
  return await postWithResponse<DOMRect>({ type: MSG_GET_CONTAINER_OFFSET })
}

async function getOffsets (element: HTMLElement): Promise<Rect> {
  const parentOffset = await getParentOffset()
  const mediaElementOffset = element.getBoundingClientRect()
  const combinedOffset = combineOffsets(mediaElementOffset, parentOffset)
  return combinedOffset
}

function combineOffsets (offset: Rect, parent: Rect): Rect {
  try {
    return {
      x: offset.x + parent.x,
      y: offset.y + parent.y,
      width: offset.width,
      height: offset.height,
      top: offset.top + parent.top,
      right: offset.right + parent.right,
      bottom: offset.bottom + parent.bottom,
      left: offset.left + parent.left
    }
  } catch (error) {
    throw new Error('Error combining offsets')
  }
}

async function sendMessageWithRetry <T> (message: unknown, retries = 3, delay = 500): Promise<T | Error> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message) as T;
      return response;
    } catch (error: any) {
      if (error.message.includes('Extension context invalidated') || error.message.includes('Receiving end does not exist')) {
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          return new Error(`Failed to send message after ${retries} retries: ${error.message}`);
        }
      } else {
        return new Error(`Failed to send message: ${error.message}`);
      }
    }
  }
  return new Error('Unknown error in sendMessageWithRetry'); // Should not be reached
}

async function c2paValidateImage (url: string): Promise<C2paResult | C2paError> {
  const result = await sendMessageWithRetry<C2paResult | C2paError>({ action: MSG_VALIDATE_URL, data: url });
  if (result instanceof Error) {
    return result as C2paError;
  }
  // Rehydrate an Error the background flattened for the wire, so callers see a
  // real name and message instead of the `{}` that JSON messaging leaves behind.
  if (isC2paErrorWire(result)) {
    return fromC2paErrorWire(result);
  }
  return result;
}

/*
  Detect clicks within this frame and notify the content script. This is used to hide the overlay.
  When the overlay is displayed, the user can click anywhere on the page to hide the overlay.
  However when the user clicks within an IFrame, no click event occurs in the main window.

  The overlayFrame listens for this message and forwards it to the content script.
*/
document.addEventListener('click', (event) => {
  sendToContent({ action: MSG_FRAME_CLICK, data: null })
})

export interface IngredientSummary {
  title: string
  format: string
  thumbnail: string | null
  parentManifest: string
}

/**
 * What the extension concluded about one piece of media.
 *
 * `credentials` — a manifest was read; the signature detail is populated.
 * `no-credentials` — the file was fetched and parsed and carries no manifest.
 * `unavailable` — the check itself did not complete, so nothing is known.
 *
 * The last two used to have no representation at all: the popup was sent only
 * entries whose validation had succeeded, so every other outcome vanished.
 */
export type ValidationEntryKind = 'credentials' | 'no-credentials' | 'unavailable'

/** rc9 (#59) — detail fields rendered inside the expandable Validation row. */
export interface C2paEntryDetails {
  signer: string
  trustListName: string | null
  trustListEntity: string | null
  isAIDetected: boolean
  manifestCount: number
  activeManifest: string
  certIssuer: string | null
  certSubject: string | null
  hasTSA: boolean
  validationErrors: string[]
  ingredients: IngredientSummary[]
  /**
   * The full provenance graph, so the popup can draw the same diagram the
   * overlay draws. Previously the popup received only the flattened
   * `ingredients` list, which is why the Validation tab could never show a
   * diagram: the data simply never crossed the message boundary.
   *
   * Null when the graph could not be built — the popup falls back to the
   * ingredient tree, exactly as the overlay falls back to its grid.
   */
  provenanceGraph: ProvenanceGraph | null
}

export interface MSG_RESPONSE_C2PA_ENTRIES_PAYLOAD {
  kind: ValidationEntryKind
  name: string
  status: VALIDATION_STATUS
  thumbnail: string | null
  // Original image URL, used to populate each popup row's data-url and the
  // "Inspect on Verifieddit" deep link.
  url: string
  /** Why the check produced no credentials. Null for a successful read. */
  detail: string | null
  /** Populated iff `kind === 'credentials'`. */
  credentials: C2paEntryDetails | null
}

/**
 * A short display name for a media URL. Signed assets carry a filename in the
 * manifest; unsigned ones do not, so derive one rather than showing the user a
 * 300-character CDN URL in the list.
 */
function filenameFromUrl (url: string): string {
  try {
    const path = new URL(url, document.baseURI).pathname
    const last = path.split('/').filter((s) => s !== '').pop()
    return last != null && last !== '' ? last : url
  } catch {
    return url
  }
}

async function updateTrustLists (): Promise<void> {
  await loadTrustLists()
  for (const mediaRecord of MediaMonitor.all) {
    if (mediaRecord.state.c2pa?.certChain == null) continue
    mediaRecord.state.c2pa.trustList = await checkTrustListInclusion(mediaRecord.state.c2pa.certChain)
    setIcon(mediaRecord)
  }
}

// A validation_status code is a real INTEGRITY failure (→ red 'error' badge)
// unless it is merely a trust/expiry signal. signingCredential.untrusted means
// the signer is not in the trust list (surfaced as the amber 'warning' state);
// .expired is a cert-validity signal. Neither means the content was altered, so
// neither should turn the badge red. Mirrors isFatalValidationCode in
// webComponents.ts — keep the two in sync.
const NON_FATAL_VALIDATION_CODE = /\.(untrusted|expired)$/i
function hasFatalValidation (codes: string[] | undefined | null): boolean {
  return (codes ?? []).some((c) => c !== '' && !NON_FATAL_VALIDATION_CODE.test(c))
}

function getC2PAStatus(c2pa: C2paResult): VALIDATION_STATUS {

  // AI status comes from what the asset DECLARES about its own content (the
  // IPTC digitalSourceType in its c2pa.actions assertion), not from which
  // trust list its signer matched. Matching on the "AI trust list" labelled
  // any file signed under Microsoft's CA as AI-generated, photographs
  // included, and missed genuine AI output from every other vendor.
  if (c2pa.aiGeneration !== 'none') {
    if (hasFatalValidation(c2pa.manifestStore.validationStatus)) {
      return 'ai-error';
    }
    return 'ai-success';
  }

  // make sure we have a manifest store and validation result
  if (!c2pa.manifestStore.validationStatus) {
    return 'error'; // Should not happen if manifestStore exists
  }
  // if there are genuine integrity failures, return the error status. Untrusted/
  // expired signers are NOT failures — they fall through to the trust-list check
  // below and surface as the amber 'warning' state.
  if (hasFatalValidation(c2pa.manifestStore.validationStatus)) {
    return 'error';
  }
  // if there is no trust list, return the warning status
  if (c2pa.trustList == null) {
    return 'warning';
  }
  // if the cert is expired, make sure the TSA time stamp is trusted
  // (no easy way to check that, we need to check the cert chain)
  if (c2pa.certChain && c2pa.certChain.length > 0 && new Date(c2pa.certChain[0].validTo) < new Date()) {
    // cert is expired, make sure we have a match in the TSA trust list (if not, timestamp must be ignored)
    if (c2pa.tstTokens == null || c2pa.tsaTrustList == null) {
      // Record the reason once. This used to push unconditionally, and
      // getC2PAStatus runs on every icon restore, so the same string
      // accumulated in validationStatus on each scroll pass (#161).
      const reason = 'certificate is expired and no trusted timestamp found'
      if (!c2pa.manifestStore.validationStatus.includes(reason)) {
        c2pa.manifestStore.validationStatus.push(reason);
      }
      return 'error';
    }
  }
  // otherwise, return the success status
  return 'success';
}

/**
 * Closing message of an entries burst. The popup previously had no terminal
 * signal at all: it hid its "Scanning…" placeholder only when an entry
 * arrived, so a page with no signed media left the placeholder up forever and
 * the user could not tell a finished scan from a stalled one.
 */
export interface MSG_RESPONSE_C2PA_SUMMARY_PAYLOAD {
  /** Entries this frame has sent or is about to send. */
  total: number
  /** Still being fetched and parsed when this summary was sent. */
  pending: number
  /** True once the frame is done, whatever it found. */
  complete: boolean
  /** Page-level auto-scanning state, so the popup can explain what it did. */
  autoScan: boolean
}

/**
 * How many media files one popup-triggered scan will fetch and parse. A news
 * front page carries hundreds of images and validating all of them would pull
 * the whole page down a second time to no purpose.
 */
const POPUP_SCAN_LIMIT = 40
/** Ignore tracking pixels, spacers and sprite chrome. */
const POPUP_SCAN_MIN_EDGE = 32
/** Validations in flight during a popup-triggered scan. */
const POPUP_SCAN_CONCURRENCY = 4

/**
 * Results of popup-triggered scans keyed by media URL, so reopening the popup
 * relists what was already found instead of refetching the page.
 */
const _popupScanCache = new Map<string, MSG_RESPONSE_C2PA_ENTRIES_PAYLOAD>()

function credentialsEntry (c2pa: C2paResult): MSG_RESPONSE_C2PA_ENTRIES_PAYLOAD {
  const activeManifest = c2pa.manifestStore.manifests[c2pa.manifestStore.activeManifest as unknown as keyof typeof c2pa.manifestStore.manifests]
  const certChain = c2pa.certChain ?? []
  const signingCert = certChain[0]
  const manifestArr = Object.values(c2pa.manifestStore.manifests ?? {}) as Array<{ title?: string, ingredients: Array<{ title: string, format: string, thumbnail: { data: string, type: string } }> }>
  const ingredients: IngredientSummary[] = []
  for (const m of manifestArr) {
    for (const ing of m.ingredients ?? []) {
      ingredients.push({
        title: ing.title ?? '(untitled)',
        format: ing.format ?? '',
        thumbnail: (ing.thumbnail?.data !== '' ? ing.thumbnail?.data : null) ?? null,
        parentManifest: m.title ?? '(unnamed manifest)'
      })
    }
  }
  return {
    kind: 'credentials',
    name: c2pa.source.filename,
    status: getC2PAStatus(c2pa),
    thumbnail: c2pa.source.thumbnail.data,
    url: c2pa.url,
    detail: null,
    credentials: {
      signer: (activeManifest as unknown as { signatureInfo?: { issuer?: string } })?.signatureInfo?.issuer ?? signingCert?.subject?.CN ?? '(unknown signer)',
      trustListName: c2pa.trustList?.tlInfo.name ?? null,
      trustListEntity: c2pa.trustList?.entity?.name ?? null,
      isAIDetected: c2pa.aiGeneration !== 'none',
      manifestCount: manifestArr.length,
      activeManifest: (activeManifest as unknown as { title?: string })?.title ?? '(unnamed)',
      certIssuer: signingCert?.issuer?.CN ?? null,
      certSubject: signingCert?.subject?.CN ?? null,
      hasTSA: c2pa.tstTokens != null && c2pa.tstTokens.length > 0,
      validationErrors: c2pa.manifestStore.validationStatus ?? [],
      ingredients,
      provenanceGraph: c2pa.provenanceGraph ?? null
    }
  }
}

function verdictEntry (verdict: MediaVerdict): MSG_RESPONSE_C2PA_ENTRIES_PAYLOAD {
  return {
    kind: verdict.kind,
    name: filenameFromUrl(verdict.url),
    // 'unavailable' is deliberately NOT 'no-credentials'. We could not look, so
    // we must not report the file as unsigned.
    status: verdict.kind === 'no-credentials' ? 'no-credentials' : 'error',
    thumbnail: verdict.url,
    url: verdict.url,
    detail: verdict.detail,
    credentials: null
  }
}

function entryFromResult (url: string, result: C2paResult | C2paError): MSG_RESPONSE_C2PA_ENTRIES_PAYLOAD {
  if (result instanceof Error || result.manifestStore == null) {
    const failure = result as C2paError
    const failureUrl = failure.url ?? url
    return failure.name === 'No Manifest'
      ? verdictEntry({ kind: 'no-credentials', url: failureUrl, detail: null })
      : verdictEntry({ kind: 'unavailable', url: failureUrl, detail: failure.message ?? 'unknown error' })
  }
  return credentialsEntry(result)
}

/**
 * Media on this page the popup has not already been told about.
 *
 * The popup used to be fed exclusively from MediaMonitor, which is empty
 * whenever auto-scan is off and holds only viewport-entered records when it is
 * on. That is why the drop-down never showed a gallery: on most pages there was
 * nothing in the monitor to report. Reading the DOM directly means opening the
 * popup lists what is actually on the page.
 */
function collectScanTargets (reported: Set<string>): Array<{ url: string, element: MediaElement }> {
  const seen = new Set(reported)
  const candidates: Array<{ url: string, element: MediaElement, area: number }> = []

  document.querySelectorAll<MediaElement>('img,video,audio').forEach((element) => {
    const url = element.currentSrc !== '' ? element.currentSrc : element.src
    // data: and blob: URLs are not fetchable from the background service worker,
    // which is where validation runs.
    if (url === '' || url.startsWith('data:') || url.startsWith('blob:')) return
    if (seen.has(url)) return
    seen.add(url)

    const rect = element.getBoundingClientRect()
    if (element.nodeName === 'IMG' && (rect.width < POPUP_SCAN_MIN_EDGE || rect.height < POPUP_SCAN_MIN_EDGE)) return
    candidates.push({ url, element, area: rect.width * rect.height })
  })

  // Largest first: if the cap bites, the user gets the images the page is
  // actually about rather than forty avatars.
  return candidates
    .sort((a, b) => b.area - a.area)
    .slice(0, POPUP_SCAN_LIMIT)
    .map(({ url, element }) => ({ url, element }))
}

async function respondWithEntries (): Promise<void> {
  const send = (action: string, data: unknown): void => {
    // The popup closes the moment it loses focus, and every send after that
    // rejects. That is expected, not an error worth surfacing.
    chrome.runtime.sendMessage({ action, data }).catch(() => { /* popup gone */ })
  }

  const reported = new Set<string>()

  for (const record of MediaMonitor.all) {
    const entry = record.state.c2pa != null
      ? credentialsEntry(record.state.c2pa)
      : record.state.verdict != null ? verdictEntry(record.state.verdict) : null
    if (entry == null) continue
    reported.add(entry.url)
    send(MSG_RESPONSE_C2PA_ENTRIES, entry)
  }

  for (const [url, entry] of _popupScanCache) {
    if (reported.has(url)) continue
    reported.add(url)
    send(MSG_RESPONSE_C2PA_ENTRIES, entry)
  }

  const targets = collectScanTargets(reported)

  const summary = (pending: number): MSG_RESPONSE_C2PA_SUMMARY_PAYLOAD => ({
    total: reported.size + targets.length,
    pending,
    complete: pending === 0,
    autoScan: MediaMonitor.monitoring
  })

  // Sent up front so the popup can show "analysing N images" instead of an
  // unqualified spinner, then again on completion as the terminal signal.
  send(MSG_RESPONSE_C2PA_SUMMARY, summary(targets.length))

  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const target = targets[next++]
      let result: C2paResult | C2paError
      try {
        result = await c2paValidateImage(target.url)
      } catch (error) {
        result = Object.assign(new Error(error instanceof Error ? error.message : String(error)), { url: target.url }) as C2paError
      }
      const entry = entryFromResult(target.url, result)
      _popupScanCache.set(target.url, entry)
      send(MSG_RESPONSE_C2PA_ENTRIES, entry)

      // If the element is monitored, fold the result back into its record so
      // the on-page badge agrees with the popup rather than contradicting it.
      if (MediaMonitor.lookup(target.element) != null) {
        await handleValidationResult(target.element, result)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(POPUP_SCAN_CONCURRENCY, targets.length) }, worker))

  send(MSG_RESPONSE_C2PA_SUMMARY, summary(0))
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message.action
  const data = message.data
  if (action == null || data === undefined) return

  if (message.action === MSG_REQUEST_C2PA_ENTRIES) {
    void respondWithEntries()
    // multiple frames will act on this message, so we send the response as a separate message
  }
  if (message.action === MSG_TRUSTLIST_UPDATE) {
    void updateTrustLists()
  }
  if (message.action === MSG_C2PA_RESULT_FROM_CONTEXT) {
    void handleContextMenuVerdict(data)
  }
})

const MEDIA_TAGS = ['IMG', 'VIDEO', 'AUDIO']

function isMediaNode (node: unknown): node is MediaElement {
  return node instanceof HTMLElement && MEDIA_TAGS.includes(node.nodeName)
}

function sameUrl (candidate: string | null | undefined, url: string): boolean {
  if (candidate == null || candidate === '') return false
  if (candidate === url) return true
  try {
    return new URL(candidate, document.baseURI).href === new URL(url, document.baseURI).href
  } catch {
    return false
  }
}

/**
 * Find the media element a context-menu verdict belongs to.
 *
 * `_lastContextTarget` is raw `event.target` from the contextmenu listener, so
 * on `<picture>` markup, wrapped figures, and anything carrying a transparent
 * click-catching overlay — the standard shape of a news site — it is the
 * wrapper or the overlay and never the `<img>`. Requiring it to BE the media
 * element, and requiring `srcUrl` to equal `.src` or `.currentSrc` exactly, is
 * why "Verify with Verifieddit" did nothing on most real pages.
 *
 * The browser's `srcUrl` is the authoritative identifier for what was clicked,
 * so match on that and treat the event target as a locality hint.
 */
function resolveContextTarget (url: string): MediaElement | null {
  const matches = (el: MediaElement): boolean => sameUrl(el.src, url) || sameUrl(el.currentSrc, url)

  const hint = _lastContextTarget
  if (hint != null) {
    if (isMediaNode(hint) && matches(hint)) return hint
    // Widen outwards a couple of levels: the media element is normally a child
    // or a sibling of whatever actually received the click.
    const scopes: Element[] = []
    if (hint instanceof Element) {
      scopes.push(hint)
      const parent = hint.parentElement
      if (parent != null) scopes.push(parent)
      const grandparent = parent?.parentElement
      if (grandparent != null) scopes.push(grandparent)
    }
    for (const scope of scopes) {
      const found = Array.from(scope.querySelectorAll<MediaElement>('img,video,audio')).find(matches)
      if (found != null) return found
    }
  }

  const found = Array.from(document.querySelectorAll<MediaElement>('img,video,audio')).find(matches)
  if (found != null) return found

  // Last resort: the clicked element itself. A media element the user
  // deliberately right-clicked is a better target than none, and the verdict
  // carries its own URL, so nothing is attributed to the wrong file.
  if (isMediaNode(hint)) return hint
  return null
}

/**
 * Apply a verdict produced by the "Verify with Verifieddit" context-menu item.
 *
 * Every guard here used to be a bare early `return`, so all four failure modes
 * looked identical to the user: nothing happened at all.
 */
async function handleContextMenuVerdict (data: { url?: string, frame?: number, c2paResult?: unknown }): Promise<void> {
  const url = data?.url
  if (url == null || data?.c2paResult == null) return

  const id = await resolveFrameId()
  // Skip only when we positively know the verdict belongs to a different frame.
  // An unresolved id is not evidence of a mismatch, and dropping on it is what
  // made the whole feature fail closed after a service-worker restart.
  if (id != null && data.frame != null && data.frame !== id.frame) return

  const target = resolveContextTarget(url)
  if (target == null) return

  const result = isC2paErrorWire(data.c2paResult)
    ? fromC2paErrorWire(data.c2paResult)
    : data.c2paResult as C2paResult | C2paError

  MediaMonitor.add(target)
  await handleValidationResult(target, result)
}

function sendToContent (message: unknown): void {
  // Wrap sendMessage: after an extension reload the content-script keeps
  // running but the runtime channel is dead, so chrome.runtime.sendMessage
  // throws "Extension context invalidated." and the async/fire-and-forget
  // call swallows the error silently — leaving the CR-overlay click inert
  // with no diagnostic. Catch + log + show a one-shot page toast.
  try {
    void chrome.runtime.sendMessage({ action: MSG_FORWARD_TO_CONTENT, data: message })
  } catch (err) {
    showExtensionReloadToast()
  }
}

// Send MSG_OPEN_OVERLAY to the BACKGROUND, which relays it into this tab's
// overlay iframe over a named port (#149).
//
// The overlay UI lives in `iframe.html`, an extension page hosted as an iframe
// on the current tab, and there is no direct route to it from here.
// chrome.tabs.sendMessage — which is what the MSG_FORWARD_TO_CONTENT wrapper
// uses — is delivered to **content scripts only**, so it never sees the frame.
//
// This code previously relied on chrome.runtime.sendMessage fanning out to
// every extension context holding a runtime.onMessage listener, including
// embedded extension pages, and let overlayFrame.ts's listener fire directly.
// That is true on Chrome and false on Gecko, where the frame is simply not a
// delivery target. The send resolved without throwing, so nothing surfaced: the
// click registered, no error appeared anywhere, and the overlay never opened.
// A packaged, addons-linter-clean Firefox build shipped with a dead UI.
//
// runtime.sendMessage still reaches the background on both engines, so the
// message below is unchanged — only its destination is. The background hands it
// to the right tab's frame from there. See src/platform.ts.
function openOverlay (c2paResult: unknown, position: { x: number, y: number }): void {
  try {
    void chrome.runtime.sendMessage({
      action: MSG_OPEN_OVERLAY,
      data: { c2paResult, position }
    })
  } catch (err) {
    showExtensionReloadToast()
  }
}

// Tiny in-page toast shown when the content script can no longer talk to the
// background. Rendered once; subsequent failures update the text. This makes
// the "click does nothing" post-reload failure mode self-explanatory.
let _toastEl: HTMLDivElement | null = null
function showExtensionReloadToast (): void {
  try {
    if (_toastEl != null) return
    const toast = document.createElement('div')
    toast.setAttribute('c2pa-toast', 'c2pa-toast')
    toast.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'background:#1a1a1a',
      'color:#ffffff',
      'padding:10px 14px',
      'border-radius:6px',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
      'max-width:320px'
    ].map(s => `${s} !important`).join(';')
    toast.textContent = 'Verifieddit was reloaded — refresh this tab to restore C2PA validation.'
    document.body.appendChild(toast)
    _toastEl = toast
  } catch {
    // nothing we can do if document is gone
  }
}

// Per-call, auto-dismissing in-page toast for the "no credentials" badge click.
// Replaces the prior native modal dialog in content-script context (CWS policy
// prohibits content scripts from spawning native dialogs — host-page event-loop
// hijack, origin-spoofing risk). Same visual idiom as showExtensionReloadToast
// but non-singleton and self-removing.
function showNoCredentialsToast (note: string, url: string): void {
  try {
    const toast = document.createElement('div')
    toast.setAttribute('c2pa-toast', 'c2pa-toast')
    toast.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'background:#1a1a1a',
      'color:#ffffff',
      'padding:10px 14px',
      'border-radius:6px',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
      'max-width:380px',
      'word-break:break-all'
    ].map(s => `${s} !important`).join(';')
    const noteLine = document.createElement('div')
    noteLine.textContent = note
    const urlLine = document.createElement('div')
    urlLine.style.cssText = 'margin-top:6px;opacity:0.75;font-size:11px !important'
    const truncated = url.length > 140 ? url.slice(0, 140) + '…' : url
    urlLine.textContent = truncated
    toast.appendChild(noteLine)
    toast.appendChild(urlLine)
    document.body.appendChild(toast)
    setTimeout(() => { try { toast.remove() } catch { /* gone already */ } }, 8000)
  } catch {
    // nothing we can do if document is gone
  }
}

let _lastContextTarget: MediaElement | null = null

document.addEventListener('contextmenu', event => {
  _lastContextTarget = event.target as MediaElement
})

MediaMonitor.onAdd = (mediaRecord: MediaRecord): void => {
  VisibilityMonitor.observe(mediaRecord)
}

MediaMonitor.onRemove = (mediaRecord: MediaRecord): void => {
  if (mediaRecord.icon != null) {
    mediaRecord.icon.remove()
  }
  VisibilityMonitor.unobserve(mediaRecord)
}

MediaMonitor.onMonitoringStart = (): void => {
  MediaMonitor.all.forEach((mediaRecord) => {
    setIcon(mediaRecord)
    VisibilityMonitor.observe(mediaRecord)
  })
}

MediaMonitor.onMonitoringStop = (): void => {
  MediaMonitor.all.forEach((mediaRecord) => {
    mediaRecord.icon = null
    VisibilityMonitor.unobserve(mediaRecord)
  })
}

VisibilityMonitor.onVisible((mediaRecord: MediaRecord): void => {
  restoreIcon(mediaRecord)
})

// #162: onNotVisible destroys the badge DOM node (`mediaRecord.icon = null`
// runs CrIcon.remove() via the setter), and recreation on re-entry went
// through setIcon, which early-returns when state.c2pa is null. Any image
// whose result was a verdict rather than a manifest ('no-credentials',
// 'unavailable') therefore lost its badge permanently after one scroll-out,
// which is why a long page showed a handful of fluctuating badges instead of
// one per analysed image. Restore from whichever result shape the record holds.
function restoreIcon (mediaRecord: MediaRecord): void {
  if (mediaRecord.state.c2pa != null) {
    setIcon(mediaRecord)
    return
  }
  const verdict = mediaRecord.state.verdict
  if (verdict == null) return
  if (verdict.kind === 'no-credentials') {
    ensureNoCredentialsIcon(mediaRecord, verdict.url)
  } else if (verdict.kind === 'unavailable') {
    ensureVerificationFailedIcon(mediaRecord, verdict.url, verdict.detail ?? 'unknown error')
  }
}

VisibilityMonitor.onNotVisible((mediaRecord: MediaRecord): void => {
  mediaRecord.icon = null
})

VisibilityMonitor.onEnterViewport((mediaRecord: MediaRecord): void => {
  if (!mediaRecord.state.evaluated && mediaRecord.src !== '') {
    mediaRecord.state.evaluated = true

    // Check image dimensions for icon injection
    if (mediaRecord.element.tagName === 'IMG') {
      const imgElement = mediaRecord.element as HTMLImageElement;
      // Capture the ready-callback locally so we can invoke it directly
      // for already-loaded images. mediaRecord.onReady is a setter-only
      // property on MediaRecord — reading it returns undefined, so we
      // cannot round-trip through it (#57).
      const onReadyCallback = (): void => {
        if (imgElement.naturalWidth > 5 && imgElement.naturalHeight > 5) {
          // Create icon with a default status if it doesn't exist
          if (mediaRecord.icon === null) {
             mediaRecord.icon = new CrIcon(mediaRecord.element, 'img'); // Use 'img' as default status
             mediaRecord.icon.setMetadataLink(mediaRecord.src);
             mediaRecord.icon.onClick = async () => {
               const offsets = await getOffsets(mediaRecord.element);
               if (mediaRecord.state.c2pa) {
                 openOverlay(mediaRecord.state.c2pa, { x: offsets.x + offsets.width, y: offsets.y });
               } else {
                 // Optional: Provide user feedback that C2PA data is not available
               }
             };
          } else {
             // Icon already exists (shouldn't happen if created here first), ensure it's visible and positioned
             mediaRecord.icon.show();
          }

          // Proceed with C2PA validation regardless of icon creation.
          //
          // Routed through handleValidationResult rather than handled inline.
          // The old `else` branch did nothing at all, so an auto-scanned image
          // with no manifest kept the neutral 'img' camera badge indefinitely —
          // visually identical to one still being scanned — and left no trace on
          // the record, which is why the popup could only ever list signed media.
          void c2paValidateImage(mediaRecord.src)
            .then(async (c2paResult) => { await handleValidationResult(mediaRecord.element, c2paResult) })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error)
              mediaRecord.state.verdict = { kind: 'unavailable', url: mediaRecord.src, detail }
              ensureVerificationFailedIcon(mediaRecord, mediaRecord.src, detail)
            });
        } else {
          // If icon exists for this element (shouldn't if logic is correct), remove it
          if (mediaRecord.icon) {
             mediaRecord.icon.remove();
             mediaRecord.icon = null;
          }
        }
      };
      mediaRecord.onReady = onReadyCallback;
      // Trigger onReady logic immediately if the image is already loaded
      if (imgElement.complete && imgElement.naturalWidth !== 0) {
          onReadyCallback();
      }
    } else {
       // For non-image media elements (video, audio), proceed with C2PA validation
       // Icon injection for these types is not part of the current 5x5px image requirement.
       // Same routing as the image path above, so audio/video that carries no
       // manifest is recorded as a verdict and reaches the popup's list.
       void c2paValidateImage(mediaRecord.src)
         .then(async (c2paResult) => { await handleValidationResult(mediaRecord.element, c2paResult) })
         .catch((error: unknown) => {
           const detail = error instanceof Error ? error.message : String(error)
           mediaRecord.state.verdict = { kind: 'unavailable', url: mediaRecord.src, detail }
         });
    }
  }
});

VisibilityMonitor.onLeaveViewport((mediaRecord: MediaRecord): void => {
  // do nothing
})

VisibilityMonitor.onUpdate((mediaRecord: MediaRecord): void => {
  mediaRecord.icon?.position()
})

function setIcon (mediaRecord: MediaRecord): void {

  // If no C2PA data, and an icon already exists (created based on size), do nothing.
  // If no C2PA data and no icon, do nothing.
  if (mediaRecord.state.c2pa == null) {
    return;
  }

  // If C2PA data is available, get the status and update/create the icon
  const c2paStatus = getC2PAStatus(mediaRecord.state.c2pa);

  if (mediaRecord.icon == null) {
    // This case handles non-image media or images where C2PA data arrived before onEnterViewport's load listener.
    mediaRecord.onReady = (mediaRecord) => {
      // Use the C2PA status directly for the icon status
      mediaRecord.icon = new CrIcon(mediaRecord.element, c2paStatus as VALIDATION_STATUS)
      mediaRecord.icon.setMetadataLink(mediaRecord.src) // Set the metadata link
      mediaRecord.icon.onClick = async () => {
        const offsets = await getOffsets(mediaRecord.element)
        if (mediaRecord.state.c2pa) {
          openOverlay(mediaRecord.state.c2pa, { x: offsets.x + offsets.width, y: offsets.y })
        }
      }
    }
    return; // Wait for onReady if element isn't ready
  }

  // Icon already exists (created in onEnterViewport or previously here), update its status
  mediaRecord.icon.status = c2paStatus as VALIDATION_STATUS;
  mediaRecord.icon.setMetadataLink(mediaRecord.src); // Update the metadata link
  mediaRecord.icon.show(); // Explicitly ensure icon is visible
}
