# CHANGELOG

## v1.2.4

- Auto-scan no longer badges unsigned media (#169). With auto-scan on, every
  image larger than 5x5 px got a badge: a neutral camera while the check ran,
  upgraded to the grey camera with a red slash when the file carried no C2PA
  manifest, which on an ordinary page is nearly every image. That badge was
  added in #86 for the right-click path, where the user asked; auto-scan
  routed through the same function, and #162 made the badge survive
  scrolling. A no-manifest result from auto-scan or a popup scan now records
  the verdict (the popup still lists the file) and removes the badge. A
  right-click Verify keeps the badge and toast. Guarded by
  test/e2e/no-credentials-no-badge.spec.ts.

## v1.2.3

- No-credentials and verification-failed badges are restored when media
  re-enters the viewport (#162). Leaving the viewport destroys the badge DOM
  node, and recreation went through setIcon, which early-returns when
  state.c2pa is null, so every verdict-only image lost its badge permanently
  after one scroll-out. restoreIcon() now restores from whichever result shape
  the record holds. Also dedupes the expired-cert reason string that
  getC2PAStatus pushed into validationStatus on every recompute.
- The overlay trust row and screen-reader summary qualify a trust-list match
  when the signing certificate is expired and no trusted RFC 3161 timestamp
  covers the signature (#161). The on-page badge already degraded to the error
  state for this case; the panel rendered an unqualified checkmark.

## v1.2.2

- Legitimate Adobe-signed content is trusted (#160). Real Photoshop, Firefly
  and Lightroom output chains through Adobe Product Services G3/G4 to Adobe
  Root CA G2, and our only general bundled list (the C2PA conformance list)
  carries a single Adobe cert, the vault-a-or2 issuing CA, which none of those
  chains touch. The CAI known-certificate anchors
  (contentcredentials.org/trust/anchors.pem, the list the Content Credentials
  Verify site trusts; 26 anchors including Adobe Root CA G2, Leica, Nikon,
  Canon, Sony, Fujifilm, Microsoft, Truepic) are now generated into
  src/trust-anchors/cai-known-anchors.json by sync-c2pa-trust-lists.ts and
  merged at init. Regression locked by test/caiKnownAnchors.test.ts using the
  real chains extracted from the CAI example assets.
- Bundled trust anchors are merged on every update (#155). The store used to be
  seeded only when empty, so anchors added after a profile's first install
  never loaded: profiles from v1.1.3 or earlier kept showing
  trusteddit.com-signed media as untrusted while a fresh install looked
  perfect.
- One malformed stored trust record no longer aborts reconciliation. The
  key derivation over stored lists was unguarded, so a single record without a
  well-formed entities array threw before the merge loop and before fixture
  eviction, silently disabling both halves of the #155 fix (a fail-open).
- The overlay iframe no longer logs an allowfullscreen precedence warning on
  every page (#156).

## v1.2.1

- The panel's sections open again for anyone running the system setting
  "reduce motion". The credentials panel released its clipping mask on the
  `transitionend` of its slide-open animation, and the shared stylesheet
  disables every transition under `prefers-reduced-motion: reduce`, so that
  event never fired for those users. The panel then stayed frozen at the height
  it had while all sections were shut, with overflow still hidden. Every section
  did toggle when clicked; the detail it revealed was simply clipped away, which
  made the disclosure arrows look like dead controls. The unclipping now runs on
  a timer as well as on the animation, so it cannot depend on an event that may
  never arrive. Verified by running the same gesture under both motion
  preferences: `scripts/probe-reduced-motion.mjs`.
- Nodes in the provenance graph can be dragged. Previously a press on a node was
  ignored, which only matters once two nodes overlap, and an expanded node
  always overlaps something, so parts of the chain could be permanently hidden
  behind each other. A node now follows the cursor at any zoom, its edges follow
  with it, and a "Reset layout" control appears once anything has been moved by
  hand. The toggle button inside a node still expands it.
- "Fit" works in full screen. The fit scale was capped at 1, which is invisible
  in the 372px panel (where the ratio is below 1 anyway) and made the button a
  no-op on a full display: it re-centred a postage-stamp graph in a wall of
  empty canvas instead of filling the frame. Measured on a real signed asset at
  1500x1000, Fit now takes the chain from 4% to 97% of the frame width.
- The overlay attaches to pages that had already finished loading. The panel's
  iframe was added on `DOMContentLoaded` only, a one-shot bet that this script
  always runs before that event. It holds for the normal `document_start`
  injection and fails for every other entry into the code, including
  re-injection after an extension reload or update, leaving verification with
  nowhere to draw.

## v1.2.0

- The popup now lists every image, video and audio file it analysed, not only
  the ones that turned out to be signed. Before this release the drop-down was
  fed exclusively from records the in-page monitor had already validated and
  found a manifest on, so on an ordinary page — a news article, a shop, a photo
  gallery — it had nothing to show and sat on "Scanning for C2PA-signed media on
  this page…" indefinitely. Opening the popup now enumerates the page's media
  directly and reports a row for each file, whatever the outcome.
- Files with no Content Credentials get a **No Creds** badge, and the whole row
  is rendered at reduced opacity (full strength on hover or keyboard focus). The
  in-page badge is faded to match. Absence of a signature is a real finding, but
  a weaker one than any verdict about a signature that exists, and it should not
  carry the same visual weight as "trusted" or "invalid".
- "No credentials" and "could not check" are no longer the same thing. A file
  the extension could not read — a network failure, an engine that never came
  up — is now labelled **Unchecked** rather than being reported as unsigned.
  Telling a user that a signed asset carries no credentials is the worst verdict
  a verifier can get wrong, so the two are kept apart end to end.
- Right-click → "Verify with Verifieddit" works again. Three separate faults
  were in the path. The content script resolved its frame id once, without
  retrying, so a page that loaded while the MV3 service worker was suspended
  never got an answer and silently dropped every later verification. The click
  target had to *be* the media element and its URL had to match `src` exactly,
  which fails on `<picture>`, `srcset`, wrapped figures, and the transparent
  click-catching overlays that most news sites put over their images; the
  browser's own `srcUrl` is now authoritative and the event target is treated as
  a hint. And a failed validation was discarded with a bare `return`, so when
  the engine did fail the user's explicit request produced no badge, no message
  and no error — indistinguishable from the extension not being installed.
- Errors now survive the trip between the background and the page. Extension
  messaging is JSON, not structured clone, and `JSON.stringify(new Error(…))` is
  `{}`: name, message and the attached URL were all dropped, so the receiver's
  `instanceof Error` check was false and the failure vanished. Failures are
  flattened onto an explicit wire shape and rebuilt on the far side.
- The popup always reaches a terminal state. Each frame sends a summary after
  its entries, so the drop-down can say "no media on this page", "Verifieddit
  cannot read this page" (browser and Web Store pages are off limits), or how
  many files are still being checked, instead of showing a placeholder forever.
- Fixed a spurious "C2PA engine failed to initialise: Worker is not defined"
  banner. The WASM engine's module-level init ran wherever a runtime value was
  imported from it, including the service worker, which has no `Worker`.
  Validation was in fact working, via the offscreen document, and only the
  banner was wrong. Moving the shared helpers to a side-effect-free module also
  took the content script injected into every page from 199,934 to 135,572
  bytes.

## v1.1.3

- Firefox overlay fix: the credentials panel payload is relayed through the
  background rather than posted directly, which Gecko's port handling dropped.

## v1.1.2

- Firefox is submittable. The Gecko build existed but had never been checked
  against AMO's validator or run in Firefox at all. It carried a hard rejection
  (the add-on name was 46 characters against AMO's 45-character limit) plus 29
  warnings; it now reports zero errors and eight documented warnings.
- The Firefox minimum is now 115.0, up from 109.0. `background.type: module`
  needs 112 and `storage.session` needs 115, so the old floor advertised support
  the code could not deliver. 115 is an ESR, so no realistic user is dropped.
- Data collection is declared in the manifest, as AMO now requires. Nothing is
  collected by default; the opt-in manifest-store probe is disclosed as optional
  `websiteContent`, which is truthful about the perceptual hashes it sends when
  a user turns it on.
- The Firefox bundle no longer contains `chrome.offscreen`. Firefox has no such
  API and the call site was already guarded, but AMO flags every textual
  reference, so the branch is now constant-folded out at build time. Chrome
  keeps its offscreen path unchanged.
- Dropped a `web_accessible_resources` entry naming `iframe.js`, a file the
  build has never produced.
- Builds no longer bake the build machine's hostname into the shipped bundle.
  That value was published to the store; it now reads `local` unless a CI runner
  name is present, which also makes a reviewer's rebuild match.
- First functional proof in Gecko: eight of eight verdict badges across the demo
  corpus in Firefox 151, confirming the C2PA WebAssembly engine initialises
  inside a Firefox event page. Chrome runs that engine in an offscreen document,
  which Firefox has no equivalent for, so this was the real unknown.

## v1.1.1

- The manifest-store probe is opt-in. During validation the extension used to
  send a perceptual fingerprint of images to manifests.sanmarcsoft.com without
  anyone choosing it, and it was disclosed nowhere; WEBSTORE_LISTING.md claimed
  the opposite outright. Now gated inside probeManifestStore itself, off by
  default, failing closed when storage is unreadable. Consent is granted in
  context from the Cloud-recoverable pillar, applies forward only, and is
  reversible from Options. Pillar 3 reads 'declared' rather than 'verified'
  while off. Disclosed in both listing docs and in section 2.9 of the published
  privacy policy.
- All three Durable Content Credentials pillars are clickable and explain
  themselves in plain language.
- AI labelling says only what it knows. The popup row "AI detection" is now
  "AI (declared by signer)"; its negative value is "not declared" rather than
  "no", because an absent declaration is not evidence of human authorship. The
  manifest description no longer promises to "Detect AI-generated" media, which
  implied pixel analysis the extension does not perform.


## v1.1.0

- Interactive C2PA provenance graph. Click a node to expand its detail, drag to
  pan, scroll or +/- to zoom, Fit to frame, Full screen, Escape to exit. Shows
  assertion and sensor-telemetry nodes, multi-generation ingredient chains, C2PA
  relationship labels on edges, and per-node signer, claim-generator and
  validation detail. Replaces the flat ingredient-only diagram. Built from the
  raw c2pa-rs manifest store by a port of the hub's canonical `provenance-graph`
  builder, so the extension, verifieddit.com and trusteddit.com agree on what a
  file's metadata says. A malformed store degrades to the ingredient grid and can
  never turn a valid asset into a failed validation.
- C2PA engine upgraded to `@contentauth/c2pa-web` 0.11, `@contentauth/toolkit`
  0.13.14 and `c2pa-wc` 0.14.17. The WASM worker now loads from a packaged file
  via the native `workerSrc`, so no `blob:` CSP exception is needed in either
  browser.
- Right-click "Inspect Content Credentials" is recreated on every service-worker
  startup, so it no longer disappears after the worker is torn down.
- `bookmarks` permission removed entirely, along with the feature behind it.
- Trust anchors resynced with the C2PA Conformance Program. The bundled default
  list had drifted to 18 of the 29 official anchors, so assets signed by Huawei,
  Huanyu, Verimago, Snowball, Encypher, TrustAsia and RealReel rendered as
  valid-but-untrusted. Added the official C2PA TSA trust list (21 anchors) —
  previously only the Trusteddit TSA chain shipped, so official timestamp
  authorities failed the RFC 3161 trust check. Generated and drift-gated by
  `bun scripts/sync-c2pa-trust-lists.ts [--check]`.
- Fixture-signing CA moved out of the production trust list into
  `dev-trust-list.json`, so `default-trust-list.json` is exactly the official list.
- AI-generated media is now identified from what the asset declares, not from
  who signed it. `isAIDetected` was `trustList.name === 'AI trust list'`, and
  that list holds Microsoft as a CA plus OpenAI. A CA match covers every leaf
  certificate beneath it, so an ordinary photograph signed anywhere under
  Microsoft's PKI was badged AI-generated, while genuine AI output from any
  other vendor was missed entirely. Detection now reads the IPTC
  `digitalSourceType` from the active manifest's own `c2pa.actions` assertion:
  `trainedAlgorithmicMedia` is full generation, `compositeWithTrainedAlgorithmicMedia`
  is partial, and everything else — including `algorithmicMedia` for procedural
  work — is not AI. Unit tests in `test/aiDetection.test.ts` pin the negative
  cases, which are the ones that matter.
- Fixture-signing CA is no longer loaded as a trust anchor in published builds.
  Splitting it into its own file left it still being pushed into
  `globalTrustLists` by `loadDefaultTrustLists()`, so every installed copy
  trusted a signing key that is public in this repository — anyone holding it
  could mint media the extension reported as trusted. Loading is now gated on
  `TRUST_DEV_FIXTURES`, off by default and set only by `bun run build:e2e` so the
  bundled corpus can still exercise the trusted-signer path.

- Trust-path regression tests now `await` `checkTrustListInclusion`. The function
  became async and three call sites were never updated; the attacker-chain test
  had been passing without ever running.

## v0.1.3

- Auto-refresh trust lists
- Enable context menu validation and added auto-scan option
- Dynamic icon updates when in web view
- Create chrome and firefox dist zip artifact
- Add individual trust anchors list
- Add support for AVIF and SVG image formats
- Add support for MP3 and WAV audio formats
- Add support for AVI video format

## v0.1.2

- Add support for Firefox
- Add option to scan all media on a page
- Various updates

## v0.1.1

- IFrames, including nested IFrames and IFrames within shadow-roots, are now scanned for media elements
- Display trust list logo in popup (if available)
- Various updates

## v0.1.0

- Initial release
