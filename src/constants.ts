/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */
import 'dotenv/config'

export interface MSG_PAYLOAD {
  action: string
  data: unknown
  frame?: string
}

// rc11.7 / #86 — 'no-credentials' is produced when the user explicitly
// right-click → Verify's an image and the result has no embedded C2PA
// manifest. It renders as a neutral-grey camera with a small red slash
// to signal "checked, nothing found" — distinct from the transient
// 'img' status used during auto-scan detection.
export type VALIDATION_STATUS = 'success' | 'warning' | 'error' | 'audio' | 'img' | 'video' | 'none' | 'ai-success' | 'ai-error' | 'no-credentials'

export const MSG_VALIDATE_URL = 'MSG_VALIDATE_URL'
export const MSG_C2PA_VALIDATE_URL = 'MSG_C2PA_VALIDATE_URL'
export const MSG_DISPLAY_C2PA_OVERLAY = 'MSG_DISPLAY_C2PA_OVERLAY'
export const MSG_UPDATE_FRAME_HEIGHT = 'MSG_UPDATE_FRAME_HEIGHT'
export const MSG_OPEN_OVERLAY = 'MSG_OPEN_OVERLAY'
export const MSG_PARENT_RESPONSE = 'MSG_PARENT_RESPONSE'
export const MSG_CHILD_REQUEST = 'MSG_CHILD_REQUEST'
export const MSG_GET_CONTAINER_OFFSET = 'MSG_GET_CONTAINER_OFFSET'
export const MSG_GET_ID = 'MSG_GET_ID'
export const MSG_L3_INSPECT_URL = 'MSG_L3_INSPECT_URL'
export const MSG_REMOTE_INSPECT_URL = 'MSG_REMOTE_INSPECT_URL'
export const MSG_CHECK_TRUSTLIST_INCLUSION = 'MSG_CHECK_TRUSTLIST_INCLUSION'
export const MSG_GET_TRUSTLIST_INFOS = 'MSG_GET_TRUSTLIST_INFOS'
export const MSG_ADD_TRUSTLIST = 'MSG_ADD_TRUSTLIST'
export const MSG_ADD_TRUSTFILE = 'MSG_ADD_TRUSTFILE'
export const MSG_ADD_TSA_TRUSTFILE = 'MSG_ADD_TSA_TRUSTFILE'
export const MSG_REMOVE_TRUSTLIST = 'MSG_REMOVE_TRUSTLIST'
export const MSG_FRAME_CLICK = 'MSG_FRAME_CLICK'
export const MSG_REQUEST_C2PA_ENTRIES = 'MSG_REQUEST_C2PA_ENTRIES'
export const MSG_RESPONSE_C2PA_ENTRIES = 'MSG_RESPONSE_C2PA_ENTRIES'
// Sent once per frame after the entry burst, so the popup can tell "the scan
// finished and found nothing" from "the scan never answered". Without it the
// popup had no terminal state and sat on its "Scanning…" placeholder forever.
export const MSG_RESPONSE_C2PA_SUMMARY = 'MSG_RESPONSE_C2PA_SUMMARY'
export const MSG_TRUSTLIST_UPDATE = 'MSG_TRUSTLIST_UPDATE'
export const MSG_FORWARD_TO_CONTENT = 'MSG_FORWARD_TO_CONTENT'
export const MSG_SHOW_CONTEXT_MENU = 'MSG_SHOW_CONTEXT_MENU'
export const MSG_C2PA_RESULT_FROM_CONTEXT = 'MSG_C2PA_RESULT_FROM_CONTEXT'
export const MSG_AUTO_SCAN_UPDATED = 'MSG_AUTO_SCAN_UPDATED'

// #149 — named port the overlay iframe opens to the background so the
// background can push MSG_OPEN_OVERLAY back to the frame that needs it.
// A content script's chrome.runtime.sendMessage does not reach a sibling
// extension-page iframe under Gecko, and chrome.tabs.sendMessage only ever
// reaches content scripts, so a port is the one channel that lands on both
// engines. See src/platform.ts for the full note.
export const PORT_OVERLAY_FRAME = 'overlay-frame'
// Sent down the port the moment the background registers it, carrying the tab
// the background will route to. Without it the frame cannot tell "connected and
// routable" from "connected but the background dropped me", which are the two
// ways this relay fails and are otherwise indistinguishable from the outside.
export const MSG_RELAY_READY = 'MSG_RELAY_READY'
// Mirrors relay state onto <html data-vd-relay> so a WebDriver probe can read
// it from inside the frame. Diagnostic only — nothing branches on it.
export const RELAY_STATE_ATTR = 'vdRelay'
// Records what the frame did with the last overlay payload it received, so a
// failing click can be pinned to the hop that dropped it rather than to "the
// overlay did not open". Diagnostic only.
export const RELAY_EVENT_ATTR = 'vdOverlay'
// The MV3 background is torn down when idle, which disconnects every port.
// The frame reconnects after this delay so the next badge click still has a
// channel; long enough not to spin if the extension is being uninstalled.
export const PORT_RECONNECT_DELAY = 250 /* ms */

export const DEFAULT_MSG_TIMEOUT = 5000 /* 5 sec */
// Verifieddit's own in-browser validator page — replaces the upstream
// Microsoft Content Integrity deep-link (#74). The extension opens this
// URL with `?url=<encoded image src>` appended; the receiving page is
// expected to auto-fill its URL input from the query param.
export const REMOTE_VALIDATION_LINK = 'https://www.verifieddit.com/'

/**
 * Trusteddit — where a user goes to SIGN content, rather than verify it.
 *
 * The extension had six source references to trusteddit.com and not one
 * user-facing way to reach it, so the only route from "I verify other people's
 * content" to "I could sign my own" was for the user to already know the
 * product existed.
 *
 * This is a plain outbound link the user chooses to click. It adds no
 * permission, sends no request on its own, and the extension observes nothing
 * about whether it is used. `trustlist.ts` already allowlists this host.
 */
export const TRUSTEDDIT_LINK = 'https://www.trusteddit.com/'

/**
 * Which of our own surfaces sent the user to a site, appended as `?src=`.
 *
 * Deliberately coarse: it names a surface, never a user, a device, an asset or
 * a session, and it is visible in the address bar of the page it opens. The
 * receiving sites disclose it — verifieddit.com privacy policy section 2.8 and
 * trusteddit.com section 2.5 — and those were published BEFORE this shipped so
 * the disclosure is not retrofitted.
 *
 * Nothing here is stored, counted or transmitted by the extension itself.
 */
export type ClickSource =
  | 'extension-panel'
  | 'extension-popup'
  | 'extension-options'
  | 'extension-context-menu'
  | 'extension-release-notes'

/**
 * Append `?src=<source>` without disturbing existing query parameters.
 *
 * Returns the input unchanged if it will not parse, because a broken outbound
 * link is a worse failure than an untagged one.
 */
export function taggedLink (url: string, source: ClickSource): string {
  try {
    const target = new URL(url)
    target.searchParams.set('src', source)
    return target.toString()
  } catch {
    return url
  }
}

export const AWAIT_ASYNC_RESPONSE = true
export const AUTO_SCAN_DEFAULT = process.env.AUTO_SCAN?.toLowerCase() === 'true' || false

/**
 * Load the demo-corpus fixture signing CA as a trust anchor.
 *
 * OFF by default, and it must stay off in anything users install. The fixture
 * CA is a key in this repository, so trusting it means whoever holds that key
 * can mint media the extension reports as trusted — the exact failure this
 * product exists to prevent. `bun run build:e2e` turns it on so the bundled
 * corpus can still exercise the trusted-signer path.
 */
export const TRUST_DEV_FIXTURES = process.env.TRUST_DEV_FIXTURES?.toLowerCase() === 'true'
/**
 * Ask manifests.sanmarcsoft.com whether a credential is registered for an
 * image's perceptual fingerprint (Durable Content Credentials Pillar 3).
 *
 * OFF unless the user turns it on. It is the extension's only automatic
 * outbound request, and although it sends hashes rather than pixels, a
 * perceptual hash of what someone is looking at is still information about
 * what they are looking at. A tool people install to check whether they are
 * being deceived should not quietly transmit anything on their behalf.
 *
 * With it off, Pillar 3 reports 'declared' rather than 'verified' — the asset
 * says it has a durable binding and we did not confirm the registration. That
 * is the honest reading, and it degrades openly instead of silently.
 */
export const MANIFEST_STORE_PROBE_DEFAULT = false
/** Set the manifest-store probe preference from a UI surface (overlay/popup). */
export const MSG_SET_MANIFEST_STORE_PROBE = 'setManifestStoreProbe'
/** chrome.storage.local key backing MANIFEST_STORE_PROBE_DEFAULT. */
export const MANIFEST_STORE_PROBE_KEY = 'manifestStoreProbe'

export const TRUSTLIST_UPDATE_INTERVAL = 1440 /* 24 hours */
export const LOCAL_TRUST_ANCHOR_LIST_NAME = 'Local Trust Anchors'
export const LOCAL_TRUST_TSA_LIST_NAME = 'Local TSA Anchors'

export const CR_ICON_SIZE = '2em'
export const CR_ICON_Z_INDEX = 10000
export const CR_ICON_MARGIN_RIGHT = 5
export const CR_ICON_MARGIN_TOP = 5
export const CR_ICON_AUDIO_MARGIN_RIGHT = -5
export const CR_ICON_AUDIO_MARGIN_TOP = -5
export const OVERLAY_Z_INDEX = 10001

export const IS_DEBUG = (process.env.NODE_ENV === 'development'.toString())

export const MIME = {
  C2PA: 'application/c2pa',
  APPLICATION_MP4: 'application/mp4',
  X_C2PA_MANIFEST_STORE: 'application/x-c2pa-manifest-store',
  AUDIO_MP4: 'audio/mp4',
  MPEG: 'audio/mpeg',
  VND_WAVE: 'audio/vnd.wave',
  WAV: 'audio/wav',
  X_WAV: 'audio/x-wav',
  AVIF: 'image/avif',
  HEIC: 'image/heic',
  HEIF: 'image/heif',
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  SVG_XML: 'image/svg+xml',
  TIFF: 'image/tiff',
  WEBP: 'image/webp',
  X_ADOBE_DNG: 'image/x-adobe-dng',
  X_SONY_ARW: 'image/x-sony-arw',
  MP4: 'video/mp4',
  X_MSVIDEO: 'video/x-msvideo',
  PDF: 'application/pdf'
}
