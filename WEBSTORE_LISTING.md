# Verifieddit: Chrome Web Store listing copy

> Drafted from a code-evidence audit of v1.1.0. See `CHROME_WEB_STORE_LISTING.md`
> in the same repo for the operational submission doc with permission
> justifications, the screenshot manifest, and developer-console field-by-field
> mapping. This file is the user-facing copy + privacy draft only.

---

## Summary

> Maximum 132 characters per Chrome Web Store policy.

**See, in one click, whether an image, video, or audio file is real, AI-made, or edited, using open C2PA Content Credentials.**

*(127 characters, including spaces and punctuation.)*

---

## Detailed Description

### What Verifieddit does

Verifieddit is a free, open-source browser extension that reveals the **provenance** of images, videos, and audio on any web page. It reads the cryptographic signature embedded in modern media (the **C2PA Content Credentials** standard, the open spec adopted by Adobe, Google, Microsoft, the BBC, and others) and shows you whether the file you are looking at:

- was produced by a verified camera, editor, or AI generator,
- was edited after capture (and by what tools),
- carries a valid trust chain back to a known signer,
- has been tampered with since it was signed,
- or carries no credentials at all (the default state for most of today's web).

A small badge appears in the corner of each verified piece of media as you browse. Click it for the full chain of custody: who created the content, what tools touched it, when it was timestamped, and which trust list authenticates the signer.

### Why this matters in 2026

The internet is now a mix of authentic media and synthetic media at industrial scale. Browsers do not natively distinguish the two. Verifieddit puts cryptographic provenance one click away from every image and video you encounter, without changing how you browse.

### How to use it

1. **Install the extension.** No account, no sign-up.
2. **Browse normally.** When auto-scan is enabled, Verifieddit detects media with C2PA Content Credentials and overlays a small badge: **green** for verified trusted, **yellow** for valid manifest from an unknown signer, **red** for integrity failure.
3. **Click any badge** to open the provenance panel: full claim chain, signer details, certificate trust state, timestamp authority, and ingredient history.
4. **Right-click** any image, video, or audio element to manually inspect Content Credentials, even when auto-scan is off.

### Key features

- **Automatic detection** of C2PA-credentialed media on any web page (toggle on or off from the popup).
- **Visual badges** distinguish *verified trusted*, *unknown signer*, and *integrity failure* states at a glance.
- **AI content identification** based on C2PA metadata and digital-source-type assertions, surfaced when the manifest declares AI involvement.
- **Interactive provenance graph**: the chain of custody as a graph you can explore: expand any node for its detail, pan, zoom, fit to frame, or open it full screen. Covers multi-generation ingredient history, assertions, sensor telemetry, signer certificate, timestamp authority, and trust-list match.
- **Right-click manual inspection** for images, videos, and audio files, even outside the auto-scan flow.
- **Trust list management**: bring your own trust anchors, or use the bundled lists: the 30 anchors from the C2PA Conformance Program, the 22 official C2PA timestamp authorities, the 26 known-certificate anchors the Content Authenticity Initiative publishes (so mainstream cameras and editing software read as trusted out of the box), an AI trust list, and the Trusteddit anchors.
- **100% local processing**: see Privacy below.

### What it can read

Photographs, video, audio, and PDF documents, across sixteen file formats: the ones the web is built on, the raw formats photographers shoot in, and the newer formats publishers have started serving. The current list is in the repository README.

> Do not restore an enumerated format list here. Chrome rejected v1.1.1 on
> 2026-08-05 under Spam and Placement in the Store (Yellow Argon, keyword
> stuffing) for exactly that line. Do not name the vendors behind the CAI
> anchors either: v1.2.3 was rejected on 2026-09-03 under the same reference
> for "Adobe, Leica, Nikon, Canon, Sony, Fujifilm, Microsoft and Truepic".
> Google's limit is five brands per description. See
> `releases/store-assets/LISTING-COPY.md`.

### Open source

MIT-licensed. Source code: <https://github.com/Sanmarcsoft/verifieddit-extension>.

### Single Purpose Description

*(Required by Chrome Web Store policy: single sentence.)*

Verifieddit verifies the authenticity and provenance of images, videos, and audio on any webpage using the C2PA Content Credentials standard.

---

## Privacy Policy (draft)

> This draft is generated from a direct audit of the v1.1.0 source code. It is
> intended to be reviewed against the published policy at
> <https://www.verifieddit.com/privacy> (the URL referenced by the Chrome Web
> Store listing), which is authoritative where the two differ.

**Last updated:** 2026-08-03 (trust-anchor counts re-verified 2026-09-08 at v1.2.6)  
**Applies to:** Verifieddit v1.1.0 Chrome extension  
**Publisher:** SanMarcSoft LLC

### Single purpose

Verifieddit has one purpose: to verify the authenticity and provenance of images, videos, and audio on any webpage using the open C2PA Content Credentials standard. Every permission the extension requests is in service of that single purpose. No feature in the extension exists for any unrelated purpose, and no permission is exercised for any unrelated purpose.

### What data the extension handles

Verifieddit is built to a **local-first** principle: all C2PA verification runs inside your browser and no media ever leaves your machine. Data reaches a SanMarcSoft server only when you click a link, never automatically. There are exactly two such links: **"Inspect on Verifieddit"** sends the URL of that one media file to `www.verifieddit.com` so the site can pre-fill its verifier, and **"Sign your own content with Trusteddit"** opens `www.trusteddit.com` with a parameter naming which part of the extension you clicked from. Specifically:

| Data category | Handling |
|---|---|
| **Media files (images, videos, audio)** on pages you visit | Verifieddit reads media bytes that your browser has already loaded for the page, and processes them inside your browser using locally-bundled WebAssembly (WASM). **Nothing is uploaded.** No copy of the media leaves your machine. |
| **URLs of verified media** | Sent to `www.verifieddit.com` (as a `?url=` query parameter) **only** when you explicitly click "Inspect on Verifieddit", so the site can pre-fill its verifier. Never transmitted automatically; auto-scan does not trigger this. |
| **Which extension surface a link was clicked from** | When you click "Sign your own content with Trusteddit", the opened URL carries `?src=` followed by a fixed word naming the surface, one of `extension-panel`, `extension-popup`, `extension-options`, `extension-context-menu`, `extension-release-notes`. It identifies a place in the interface, never you, your device, your session, or the media you were looking at. Disclosed by trusteddit.com's privacy policy §2.5. |
| **A perceptual fingerprint of an image** (only if you switch on "Check durable credentials online") | For images whose credential declares a durable binding, Verifieddit can ask `manifests.sanmarcsoft.com` whether that credential is actually registered and recoverable. The request carries a short perceptual hash (pHash and dHash) computed in your browser, **never the image itself**, and nothing identifying you, your device or your session. Sent with `credentials: 'omit'`, so no cookies. **Off by default**; turn it on from the pillar in the panel or the Options tab, and off again the same way. |
| **Verification results** | Computed and displayed in your browser only. Not transmitted. Not retained beyond the current page session. |
| **User preferences** (auto-scan toggle, imported trust lists) | Stored locally in `chrome.storage.local`. Never synced to any server. Never transmitted. |
| **Diagnostic state** (ephemeral init errors so the popup can show a banner if the C2PA engine fails to load) | Stored in `chrome.storage.session`, which is wiped automatically when the browser is closed. Never transmitted. |
| **Analytics / telemetry** | **None.** The extension code base contains zero analytics SDKs, zero beacon URLs, zero tracking calls, and makes zero outbound HTTP requests to any analytics or telemetry endpoint. |
| **Cookies** | **None.** The extension does not set or read cookies. |
| **`localStorage` / `sessionStorage`** | **Not used.** Only `chrome.storage.local` and `chrome.storage.session` are used, both isolated to the extension and never shared cross-origin. |
| **Personal account information** | **None.** Verifieddit does not require, collect, or accept any account, email, name, or identifier. |

### External network requests

The extension performs network requests only in the following narrow, user-initiated scenarios:

1. **Fetching the bytes of a media element** that your browser is already displaying on the page you are visiting, to read its embedded credentials. This is a separate HTTP request from the extension's background context to the same URL the page loaded the media from. It does not carry your page-session cookies (cross-origin requests from the background do not include credentials), but the media's origin server does see your IP address. The retrieved bytes are processed locally in WebAssembly and discarded; nothing is uploaded.
2. **Opening the Verifieddit inspector** when you explicitly click "Inspect on Verifieddit". Your browser navigates to `https://www.verifieddit.com/?url=<media-url>`; the URL of the media you inspected is included as a query parameter and processed by SanMarcSoft's website under its own privacy policy.
3. **Opening Trusteddit** when you explicitly click "Sign your own content with Trusteddit". Your browser navigates to `https://www.trusteddit.com/?src=<surface>`, where `<surface>` is a fixed word naming the part of the extension you clicked from. No identifier of you, your device, your session, or the media you were viewing is included, and the link is never followed automatically.
4. **Confirming a durable credential** only if you have switched on "Check durable credentials online", which is off until you do. For images whose credential declares a durable binding, Verifieddit asks `manifests.sanmarcsoft.com` whether it is registered, sending a perceptual hash of the image and nothing else. This is the extension's only request that is not started by a click, which is exactly why it is a choice rather than a default.
5. **Refreshing a trust list** only if you have explicitly imported a trust list with a `download_url` field. The bundled default trust lists set no `download_url` and are never re-fetched. Imported lists are fetched only from the exact URL you provided, with credentials omitted.

With "Check durable credentials online" left off, which is how it ships, the extension contacts a SanMarcSoft server only when you click one of the two links above. Switching it on adds the manifest-store lookup described in item 4, and nothing else.

### Data sharing

We do not collect any data, and therefore we do not share, sell, license, lease, trade, or transfer any data to any third party.

### Data retention

Because we do not receive any data, there is no retention. Local browser state (preferences, trust list cache) is governed by your browser and remains under your control. You can clear it any time from the extension's options page or from Chrome's normal data-management settings.

### Compliance with Google Chrome Web Store policies

- **Single Purpose policy**: every feature and permission in Verifieddit serves the single purpose of verifying media provenance. See "Single purpose" above.
- **User Data policy**: Verifieddit's use of permissions is limited to providing the single user-facing feature. Data leaves the device only on your explicit click, and only in two forms: the URL of a media file you choose to inspect (the "Inspect on Verifieddit" link), and a fixed word naming which extension surface you clicked from (the Trusteddit link). Both are used solely to provide the feature on the receiving SanMarcSoft site; neither is sold, used for advertising, or transferred to other third parties. In the CWS Data Safety form this is declared as **Website content → App functionality**.
- **Off-device data**: two user-initiated navigations (a media URL to verifieddit.com, a surface name to trusteddit.com) and, only after you opt in, a perceptual image hash to manifests.sanmarcsoft.com. Nothing else leaves the device, and none of it is sold, used for advertising, or shared with third parties.
- **Trust anchors**: the demo fixtures in the source repository are signed by a development key that is public in that repository. That key is not loaded as a trust anchor in any published build, so nothing signed with it can read as trusted to a user who installs from the Chrome Web Store.

### Permissions and what they actually do

| Permission | Used for |
|---|---|
| `storage` | Save your auto-scan preference and a local cache of the loaded trust lists, both inside your own browser. |
| `activeTab` | Scope verification work to the tab you are actively viewing when you click the extension icon or use the right-click context menu. |
| `contextMenus` | Add "Verify with Verifieddit." to your right-click menu on images, videos, and audio elements. |
| `alarms` | Schedule a periodic refresh (every 24 hours) of any custom trust list you have imported (bundled lists are never re-fetched). |
| `offscreen` | Run the C2PA WebAssembly verification engine in an offscreen document. A Manifest V3 service worker cannot host the WASM toolkit itself, so the verification work happens there. It shows nothing, makes no network calls of its own, and lives only while verification runs. |
| Host permission: `<all_urls>` | Allow the extension to detect C2PA Content Credentials on media from any website. Content Credentials are an open standard that may appear on any site; narrowing this scope would defeat the extension's purpose. The extension only reads media that is already visible on the page in your browser. |

### Contact

Questions about this policy or about Verifieddit's data handling: <support@verifieddit.com>.

### Changes to this policy

We will update the version date at the top of this document and the version field in the published policy at <https://www.verifieddit.com/privacy> whenever the policy changes. The change history is also publicly visible in this repository's git log.

---

*End of WEBSTORE_LISTING.md*
