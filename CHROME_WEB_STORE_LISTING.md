# Chrome Web Store Listing: Verifieddit

> Operational submission doc. Verified against the v1.1.0 source tree. Every
> permission below is one the manifest actually requests, and every UI string is
> the one the code actually renders. Re-verify before each submission; a
> justification that describes a menu item by the wrong name is a review finding.
>
> **Applies to:** v1.1.0 · **Last verified:** 2026-08-03
>
> **Partial re-verification, 2026-09-08 (v1.2.6).** One claim in this file was
> re-checked and corrected: the bundled trust-anchor counts, read directly from
> `src/trust-anchors/*.json` at tag `v1.2.6` after #487 resynced the c2pa.org
> anchors. Nothing else here has been re-audited since v1.1.0, so this file is
> still not a source for submission copy. The audited copy is
> `releases/store-assets/LISTING-COPY.md`, which is verified at v1.2.6.

## Extension Name
Verifieddit - C2PA Content Credential Verifier

## Short Name
Verifieddit

## Summary (132 chars max)
Verify content authenticity with C2PA Content Credentials. See who signed a file, whether it was altered, and declared AI origin.

## Category
Privacy & Security

> Changed from Developer Tools at the v1.2.3 submission (2026-09-01). The
> audience is anyone verifying media authenticity, a trust/security
> proposition; Developer Tools shelved it among coding utilities where nobody
> searches for content verification. Category played no part in the v1.1.1
> rejection, which was purely the description text.

## Language
English

## Developer / Publisher Identity
- **Publisher (displayed on listing):** SanMarcSoft LLC
- **Developer website:** https://www.verifieddit.com
- **Marketing site:** https://www.verifieddit.com
- **Support / contact email:** support@verifieddit.com (publicly displayed on the listing; mailbox confirmed-by-user 2026-05-17)
- **Privacy policy URL:** https://www.verifieddit.com/privacy
- **Source repository:** https://github.com/Sanmarcsoft/verifieddit-browser-extension

Listing the LLC as Publisher on the Chrome Web Store requires either (a) submitting from a Google Workspace account on a SanMarcSoft-owned domain, or (b) setting "SanMarcSoft LLC" as the verified Publisher name on an existing CWS developer account. CWS will display the registered publisher name to end users, so verify spelling before submit.

## Single Purpose Description
Verify the authenticity and provenance of images, videos, and audio on any webpage using the C2PA content credentials standard.

## Detailed Description

Verifieddit is a free, open-source browser extension that verifies Content Credentials (C2PA) embedded in images, videos, and audio files on any website you visit.

**What are Content Credentials?**
Content Credentials are a new open standard (C2PA) for proving where digital content came from and how it was created or modified. Major organisations including Adobe, Google, Microsoft, and the BBC have adopted the C2PA standard.

**Key Features:**

- Automatic Detection: Scans media elements on any webpage for C2PA content credentials
- Visual Indicators: Shows overlay icons on media with verified content credentials (green = valid, yellow = warning, red = invalid)
- AI Origin, As Declared: Reports the IPTC `digitalSourceType` the signer recorded in their own signed manifest. It reads a declaration; it does not analyse pixels or guess. Media carrying no such declaration is shown as "not declared", never as "not AI"
- Interactive Provenance Graph: Explore the full chain of custody as a graph: click a node to expand its detail, drag to pan, zoom, fit to frame, or open it full screen. Shows multi-generation ingredient history, assertions, and sensor telemetry
- Certificate Verification: Validates signer certificates against the C2PA Trust List, including RFC 3161 trusted timestamps
- Right-Click Inspection: Right-click any image, video, or audio to inspect its Content Credentials
- Trust List Management: Ships the 30 anchors from the C2PA Conformance Program, the 22 official timestamp authorities, and the 26 known-certificate anchors the Content Authenticity Initiative publishes, so mainstream cameras and editing software read as trusted out of the box; import your own trust anchors and TSA certificates alongside them
- Auto-Scan Toggle: Enable or disable automatic scanning per your preference

**Privacy-First:**
- All verification processing happens locally in your browser using WebAssembly
- No media files are ever uploaded to any server
- Anonymous usage statistics are strictly opt-in and off by default
- No advertising, tracking, or profiling
- No account required

**What It Can Read:**
Photographs, video, audio, and PDF documents, across sixteen file formats: the ones the web is built on, the raw formats photographers shoot in, and the newer formats publishers have started serving. The current list is in the repository README.

> Do not restore an enumerated format list here. Chrome rejected v1.1.1 on
> 2026-08-05 under Spam and Placement in the Store (Yellow Argon, keyword
> stuffing) for exactly that line. Do not name the vendors behind the CAI
> anchors either: v1.2.3 was rejected on 2026-09-03 under the same reference
> for "Adobe, Leica, Nikon, Canon, Sony, Fujifilm, Microsoft and Truepic".
> Google's limit is five brands per description. See
> `releases/store-assets/LISTING-COPY.md`.

**Open Source:**
MIT-licensed. View the source code at https://github.com/Sanmarcsoft/verifieddit-browser-extension

Learn more at https://www.verifieddit.com

## Privacy Policy URL
https://www.verifieddit.com/privacy

## Permission Justifications

### storage
Saves the user's auto-scan preference and a local cache of the loaded trust lists in the browser. Also stores the analytics opt-in consent state (`analyticsConsent`). Ephemeral relay ticket data (`telemetryTicketData`) is stored in `chrome.storage.session`, while the non-extractable ECDSA signing key pair is stored in IndexedDB. Nothing is synced to a server. No new permission is required for analytics.

### activeTab
Accesses the currently active tab when the user clicks the toolbar action or selects an item from the right-click context menu, scoped to that single interaction.

### contextMenus
Adds "Verify with Verifieddit." to the right-click context menu on images, videos, and audio elements.

### alarms
Schedules periodic trust list refreshes (every 24 hours, `TRUSTLIST_UPDATE_INTERVAL = 1440`) for trust lists the user has imported. The bundled lists carry no `download_url` and are never re-fetched.

### storage (durable-credential check)
The opt-in for the manifest-store lookup is kept in `chrome.storage.local` under `manifestStoreProbe`, default `false`. No separate permission is required; it is noted here because it governs the only automatic outbound request.

### offscreen
Hosts the C2PA WebAssembly verification engine in an offscreen document. A Manifest V3 service worker cannot run the WASM toolkit directly, so verification work is delegated to this document. It renders nothing to the user, performs no network calls of its own, and exists only for the duration of verification.

### Host Permissions: <all_urls>
The extension needs access to all URLs because C2PA content credentials can appear on any website. The extension scans image, video, and audio elements on the current page to detect and verify cryptographic provenance data embedded in media files. Without broad host access, users would need to manually allowlist every website, defeating the purpose of automatic content credential detection. The existing `<all_urls>` host permission also covers outbound fetch requests to endpoints such as the telemetry relay when optional analytics is enabled (no data is sent to Google), so no additional host permission is required.

## Data Sent Off-Device

In the Chrome Web Store Developer Console Privacy tab, disclosures are declared
under the following categories and purposes:

1. **Website content → App functionality**:
   - User-initiated click to inspect media (`verifieddit.com/?url=<media-url>`)
   - Opt-in durable credential lookup (`manifests.sanmarcsoft.com/v1/matches/byBinding`) sending a perceptual hash
   - Same opt-in: registry lookup (`api.verifieddit.com/api/v1/durable/resolve`) sending the watermark algorithm name and value read from the file's signed credentials
   - Second opt-in, on top of the first: stripped-video recovery (`api.verifieddit.com/api/v1/verify`) sending the video file the user right-clicked and chose to verify
2. **User activity → Analytics**:
   - Opt-in interaction events (`extension_installed`, `extension_updated`, `verify_started`, `verify_completed`, `badge_scan`, `options_opened`, `consent_changed`)
3. **Personally identifiable information: User identifiers → Analytics**:
   - Opt-in per-install identifier (RFC 7638 thumbprint of an on-device ECDSA P-256 public key, generated locally and not derived from user or device identity)

Outbound destinations:

| Destination | When | What travels |
|---|---|---|
| `www.verifieddit.com/?url=<media-url>` | User clicks "Inspect on Verifieddit" | The URL of the one media file they chose to inspect |
| `www.trusteddit.com/?src=<surface>` | User clicks "Sign your own content with Trusteddit" | A constant naming which extension surface the link was clicked from. No user, device, asset or session identifier |
| `manifests.sanmarcsoft.com/v1/matches/byBinding` | **Only after the user opts in** to "Check durable credentials online" (off by default), for images whose credential declares a durable binding | A perceptual hash of the image (pHash + dHash). Never the image, never a user, device or session identifier. `credentials: 'omit'` |
| `api.verifieddit.com/api/v1/durable/resolve` | **Only after the user opts in** to "Check durable credentials online" (the same switch, off by default), for files whose signed credentials name a watermark | The watermark's algorithm name and binding value, read from the signed credentials. Never the image or a hash of it, never a user, device or session identifier. `credentials: 'omit'`. The service forwards the two values to the public registry that owns the algorithm |
| `manifests.sanmarcsoft.com/v1/matches/byBinding` and `/v1/manifests/{id}?format=json` (stripped-image recovery) | **Only after the user opts in** to "Check durable credentials online" AND right-clicks an image that has no credentials and chooses Verify. Never on automatic scan | A perceptual hash of that image (pHash + dHash), then the matched credential's public record id. Never the image, never a user, device or session identifier. `credentials: 'omit'` |
| `manifests.sanmarcsoft.com/v1/matches/byBinding?alg=trustmark` and `/v1/manifests/{id}?format=json` (registry-record check) | **Only after the user opts in**, for a file whose signed credentials name a TrustMark watermark | The watermark binding value read from the signed credentials, then the matched record id. The file's hash is compared on the device and never sent. `credentials: 'omit'` |
| `manifests.sanmarcsoft.com/v1/manifests/{id}` (recovered credential) | **Only after** an explicit right-click Verify found a registered match for an image with no credentials | The matched record id. The response is the registered credential, shown to the user marked as recovered |
| `api.verifieddit.com/api/v1/verify` (stripped-video recovery) | **Only after the user opts in twice** ("Check durable credentials online" and "Send videos I verify to Verifieddit", both off by default) AND right-clicks a video with no credentials and chooses Verify | The video file itself (MP4, up to 25 MB), without cookies. The service reads the watermark in its frames, looks for a registered credential and deletes the file once read. Never sent during automatic scanning |
| Telemetry relay (configured by `TELEMETRY_RELAY_URL`) | **Only after the user opts in** to "Share anonymous usage statistics" (off by default) | Signed event payload with install ID (public key thumbprint), ticket, timestamp, extension version, browser family (Chrome or Firefox), signature, JWK, and typed event parameters (`source`, `result`, `has_durable_binding`, `media_type`, `previous_version`, `value`). Forwarded to self-hosted Umami in the EU (`analytics.sanmarcsoft.com`). `fetch` POST / DELETE. |

The `src` value is drawn from a fixed set (`extension-panel`, `extension-popup`,
`extension-options`, `extension-context-menu`, `extension-release-notes`) and is
disclosed by the receiving sites: verifieddit.com privacy policy §2.8 and
trusteddit.com privacy policy §2.5, both published before the parameter shipped.

The manifest-store lookup is off by default and is granted in context: the
"Cloud-recoverable" pillar in the panel states what would be sent before anything
is. Consent applies forward only; enabling it never re-checks media already on
screen.

Anonymous usage statistics are collected via a signed telemetry relay operated
by SanMarcSoft (`src/analytics.ts`) and forwarded to self-hosted Umami in the
EU (`https://analytics.sanmarcsoft.com`). No data is sent to Google. Collection
is strictly **off by default** and transmits nothing unless the user explicitly
opts in via the initial popup consent banner or the Options tab toggle. Each event
is signed by an ECDSA P-256 key generated on the device for that install, with
the private key held non-extractably in IndexedDB; the install identifier is the
RFC 7638 thumbprint of the public key, not derived from user or device identity.
IP addresses are not stored: the relay uses the client address only in memory,
as a salted hash with a daily rotating salt, for rate limiting, and never
forwards or logs it. Events carry only the event name, its typed parameters, the
extension version, and the browser family (Chrome or Firefox). The exact seven
events sent are `extension_installed`, `extension_updated` (`previous_version`),
`verify_started` (`source`), `verify_completed` (`result`,
`has_durable_binding`, `media_type`), `badge_scan`, `options_opened`, and
`consent_changed` (`value`). It sends no URLs, page titles, page content, file
names, or content of verified media.
Auto-scan telemetry is throttled to at most one verify/scan event set per tab
per minute. Users can turn off usage statistics at any time from the popup
Options tab: doing so immediately stops outbound telemetry, sends one signed
erasure request (`DELETE /v1/installs`) to the relay, and deletes the key, ticket,
and install identifier from the browser. Erasure of already stored records in
Umami is processed by SanMarcSoft from the relay's erasure queue (it is not
instantaneous or automatic inside Umami). A build produced with an empty
`TELEMETRY_RELAY_URL` contains no endpoint credentials and the analytics client
is completely inert.

Beyond these, the extension collects nothing and sets no cookies. Verified
against the source: zero analytics SDKs, and no `document.cookie`,
`localStorage` or `sessionStorage` anywhere in `src/`.

## Screenshots

Captured from the built v1.1.0 extension in real Chrome, 1280x800. Regenerate
with `bun scripts/capture-listing-screenshots.mjs` after any UI change. Stale
screenshots that show a superseded interface are a listing-accuracy defect.

| # | File | Shows |
|---|---|---|
| 1 | `releases/screenshots/01-detection.png` | Badges overlaid on credentialed media across a live page |
| 2 | `releases/screenshots/02-provenance-graph.png` | The interactive provenance graph in the panel, node expanded |
| 3 | `releases/screenshots/03-graph-fullscreen.png` | The graph full screen, showing a multi-generation chain |
| 4 | `releases/screenshots/04-popup-validation.png` | Popup Validation tab with the graph for the current page |
| 5 | `releases/screenshots/05-popup-trustlists.png` | Popup Trust Lists tab, official C2PA + TSA anchors loaded |

Held in the repo but not uploaded (CWS caps the listing at five):
`06-popup-about.png` (About tab, version + what's new). The right-click item is
not captured: Chrome renders that menu natively, outside the page, so no
automated capture can include it honestly.

## Store Icon
Use vd128.png (128x128), generated from the SanMarcSoft Verifieddit logo
