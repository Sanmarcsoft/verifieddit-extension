# Verifieddit Browser Extension: Privacy Policy

**Applies to:** the Verifieddit browser extension for Chrome and Firefox
(extension ID `verifieddit@verifieddit.com`), version 1.3.0 and later.
**Version:** 1.1 · **Effective:** 2026-09-12

This document covers the **extension only**. The Verifieddit website has its own
policy at <https://www.verifieddit.com/privacy>, which is a broader document
covering accounts, billing and website analytics. None of that applies here: the
extension has no account and no sign-in. It collects anonymous usage statistics
only if you explicitly choose to share them, and that collection is off by default.
Where the two documents touch the same behaviour, the website policy sections 2.1,
2.8 and 2.9 and this document say the same thing, and this document is the more
specific one.

---

## The short version

The extension reads C2PA Content Credentials out of media on the pages you
visit and verifies them **on your device**, in WebAssembly. Your media never
leaves your machine. There is no account, no advertising, no tracking of what
you browse, and no history of what you inspected. Anonymous usage statistics
are collected only if you turn them on, and they are off until then.

With default settings the extension sends **nothing** to us. Every outbound
request it can make is either started by a click of yours or is a setting you
turned on yourself.

---

## 1. Who is responsible

Sanmarcsoft LLC, Texas, United States, is the data controller.

- Privacy contact: privacy@sanmarcsoft.com
- Support: support@verifieddit.com
- Source code: <https://github.com/Sanmarcsoft/verifieddit-extension> (MIT)

## 2. What happens on your device

When you view a page, or right-click a file and choose "Verify with
Verifieddit.", the extension:

1. Reads the bytes of the image, video, audio file or PDF that is already
   loaded on that page.
2. Parses the embedded C2PA manifest and validates its signature chain against
   trust anchors held locally.
3. Shows you the result: who signed it, whether the bytes changed since
   signing, and what the signer declared about AI origin.

Every step of that happens in your browser. The C2PA engine is a WebAssembly
module shipped inside the extension package. No file content, no extracted
metadata, and no media bytes are transmitted anywhere. (If you opt in to
anonymous usage statistics, an aggregate outcome category is included in
verification completion telemetry; see Section 3.)

## 3. Everything that can leave your device

This is the complete list. There is nothing else.

| # | What is sent | When | Where to | Contains |
|---|---|---|---|---|
| 3.1 | An HTTP request for the media file itself | Whenever a file is verified | The site already hosting that file | Nothing we add. It is the same request your browser makes to display the file. |
| 3.2 | The web address of one media file | Only when you click "Inspect on Verifieddit" | verifieddit.com, in a new tab | The URL you chose, as a `?url=` parameter, visible in your address bar |
| 3.3 | A fixed surface name | Only when you click a link to Trusteddit or Verifieddit | The site you are opening | `?src=` plus one of five fixed words: `extension-panel`, `extension-popup`, `extension-options`, `extension-context-menu`, `extension-release-notes` |
| 3.4 | Two perceptual hashes of one image | Only if you switched the durable-credential check on | manifests.sanmarcsoft.com | A pHash and a dHash computed on your device, sent without cookies |
| 3.5 | A request for an updated trust list | Only for a trust list you imported from a URL yourself | An allowlisted host | Nothing about you. Sent with credentials omitted. |
| 3.6 | A request for a trust list you typed in | Only when you paste a URL into the trust-list importer and click Fetch | The host you typed | Nothing about you. Sent with credentials omitted. |
| 3.7 | Anonymous usage statistics | Only if you opted in to share usage statistics (off by default) | Telemetry relay operated by SanMarcSoft, forwarded to self-hosted Umami in the EU (`analytics.sanmarcsoft.com`) | Signed event payload with install ID (public key thumbprint), ticket, timestamp, version, signature, JWK, and event parameters. No URLs, file names, media content, or personal data. |

Notes on the ones that deserve detail:

**3.3, the `?src=` parameter.** It names a place in our interface, never you,
your device, your session, or the file you were looking at. It is one of five
fixed strings, it is visible in the address bar of the page it opens, and the
extension does not store, count or report it.

**3.4, the durable-credential check.** Some Content Credentials declare a
durable binding, an invisible watermark that lets a credential be recovered
even after a re-encode or a screenshot strips the metadata. The extension can
confirm such a credential is genuinely registered by asking our manifest store.

This is **off by default** (`MANIFEST_STORE_PROBE_DEFAULT = false` in
`src/constants.ts`). It is the only request the extension makes that you do not
start with a click, which is exactly why it is a choice rather than a default.
Turn it on from the "Cloud-recoverable" panel when you inspect a file, or from
Options; turn it off in the same places. When it is on, and only for images
whose credential declares a durable binding, the request carries two short hash
values and nothing else: not the image, not any part of it, not the page you
found it on, and no identifier for you, your device or your session. Turning it
on applies from that moment forward and never re-examines anything you looked at
earlier. With it off, such files still verify normally; the durable binding is
simply reported as *declared* rather than *confirmed*.

**3.5, the trust list refresh.** A once-daily alarm re-fetches only trust lists
that carry a `download_url`, which means only lists you imported yourself. The
lists bundled with the extension set no `download_url` and are never re-fetched.
Refreshes are further restricted to an allowlist of four hosts:
`contentcredentials.org`, `c2pa.org`, `trusteddit.com`, `verifieddit.com`.

**3.7, anonymous usage statistics.** We collect aggregate, anonymous product
metrics so we know whether the extension is working and which features are used.
Events are sent to a telemetry relay operated by SanMarcSoft and stored in our
self-hosted Umami instance in the EU (`https://analytics.sanmarcsoft.com`). No
data is sent to Google Analytics or any other Google service.

This is **off by default**. It sends nothing unless you explicitly opt in by
clicking "Yes" on the first-run consent banner or by toggling "Share anonymous
usage statistics" on in Options.

How it works:
- Each event is signed by a key generated on your device for that installation
  (ECDSA P-256). The private key is non-extractable and kept securely in the
  browser's IndexedDB database.
- The installation identifier (`install_id`) is the RFC 7638 JWK thumbprint of
  that public key, not derived from you, your account, or your device hardware.
- The relay issues a short-lived ticket, which the extension includes with
  subsequent signed event payloads.

What IS sent:
- The installation identifier (`install_id`), ticket, event timestamp (`ts`),
  extension version, and an ECDSA P-256 signature (`sig`) over the canonical
  JSON payload, accompanied by the public key (`jwk`) to verify the signature.
- Event-specific parameters for one of the exact seven events:
  - `extension_installed`: no parameters.
  - `extension_updated`: `previous_version` (string, max 32 characters).
  - `verify_started`: `source` (`context_menu`, `popup`, or `auto_scan`).
  - `verify_completed`: `result` (`valid`, `invalid`, `none`, or `error`),
    `has_durable_binding` (boolean), and `media_type` (`image`, `video`,
    `audio`, or `pdf`).
  - `badge_scan`: no parameters.
  - `options_opened`: no parameters.
  - `consent_changed`: `value` (`granted` or `denied`).

What is NOT sent:
No URLs, no page titles, no page content, no file names, no content of verified
media (no image, video, audio, or PDF data), no hashes of user media, no signer
identities, no certificate details, no account or contact details, and nothing
that identifies you or your device beyond the installation public key thumbprint.
No data is sent to Google.

IP addresses are not stored: the relay uses the client IP address only in memory,
as a salted hash with a daily rotating salt, for rate limiting, and never
forwards or logs it.

Auto-scan telemetry is throttled to at most one `verify_started`,
`verify_completed`, and `badge_scan` set per browser tab per minute, ensuring
page scanning does not become a per-image beacon.

How to withdraw:
You can turn the setting off at any time from the extension's options page
(or Preferences on Firefox). Turning it off immediately stops all outbound
telemetry. Doing so sends one signed erasure request (`DELETE /v1/installs`)
to the relay and deletes the key pair, the ticket, and the identifier from the
browser's IndexedDB and local storage. Erasure of already stored records in Umami
is processed by SanMarcSoft from the relay's erasure queue (it is not
instantaneous or automatic inside Umami).

## 4. What is stored, and where

Only on your device, in `chrome.storage.local`, `chrome.storage.session`, and
IndexedDB. Nothing is synced to a server or to your browser profile sync.

| Key | What it is |
|---|---|
| `autoScan` | Whether automatic scanning is on |
| `manifestStoreProbe` | Whether the durable-credential check is on |
| `trustList` | The cached trust lists, bundled and imported |
| `rc117AutoScanMigrationDone` | A one-time settings migration flag |
| `analyticsConsent` | Consent status for usage statistics (`granted`, `denied`, or `unset`) |
| `telemetryTicketData` | Ephemeral relay ticket and install ID in `chrome.storage.session` (or memory on Firefox) |

The telemetry signing key pair is stored in IndexedDB (`verifieddit_telemetry`),
with the private key set to non-extractable. Ephemeral relay tickets
(`telemetryTicketData`) and transient C2PA engine startup errors are held in
`chrome.storage.session` (or in memory on Firefox). Your browser clears session
data automatically when it closes.

No browsing history is stored. No media content is stored. No record of which
media or URLs you inspected is stored. Uninstalling the extension removes all of
it.

## 5. What we never do

- No tracking of your browsing activity, visited URLs, page titles, or page
  content.
- No surveillance or inspection logging: we never collect, log, or transmit the
  media files you view, the hashes of your media files (except the opt-in
  durable credential check described in 3.4), or who signed the credentials you
  inspect.
- No default telemetry. Usage statistics are strictly opt-in and off by
  default.
- No third-party advertising trackers or session replay tools (no Sentry,
  PostHog, Mixpanel, Segment, Datadog, or FullStory). Outbound analytics uses
  only minimal, signed requests to the SanMarcSoft telemetry relay when
  explicitly enabled. No data is sent to Google Analytics or any third party.
- No cookies. No advertising identifiers. No browser fingerprinting.
- No sale or commercial brokering of data. We do not sell or monetize user data.
- No account, no sign-in, no email address or contact information collected.
- No remote code. Every executable byte ships inside the extension package. The
  WebAssembly module and its worker are loaded strictly from the extension's own
  origin.

## 6. Permissions, and why each one exists

| Permission | Why it is needed |
|---|---|
| `storage` | The settings above, consent state, and the local trust-list cache (the telemetry signing key is kept in IndexedDB) |
| `activeTab` | Limits the popup and the context menu to the one tab you are acting on, instead of standing access to every tab |
| `contextMenus` | Adds the single item "Verify with Verifieddit." on images, video and audio |
| `alarms` | The once-daily trust-list refresh described in 3.5 |
| `<all_urls>` | Content Credentials can be embedded in media on any site. Restricting this to a fixed list of hosts would mean the extension could only verify media on sites we chose in advance, which defeats its purpose. |
| `offscreen` (Chrome only) | Hosts the WebAssembly engine, because a Manifest V3 service worker cannot run it. It renders nothing, hosts no UI, and makes no network requests of its own. |

`<all_urls>` is a broad permission and we would rather it were narrower. What it
grants here is the ability to read media bytes on the page in front of you. It
is not used to collect page content, record browsing history, or transmit
anything.

## 7. Your controls

- **Automatic scanning:** on or off, in the popup (Chrome) or in Preferences in
  the Add-ons Manager (Firefox). With it off, nothing is verified until you ask.
- **Durable-credential check:** off unless you turn it on, in the same places
  or from the "Cloud-recoverable" panel.
- **Anonymous usage statistics:** off by default. You can enable or disable
  "Share anonymous usage statistics" at any time from the Options tab in the
  toolbar popup on Chrome, or under about:addons -> Verifieddit -> Preferences
  on Firefox. When turned off, the extension stops sending telemetry, sends a
  signed erasure request to the relay, and deletes its local signing key, ticket,
  and install identifier.
- **Trust lists:** you can add and remove them, including your own.
- **Everything else:** uninstalling removes all locally stored data.

## 8. Your rights

Because the extension stores no identifying personal information on our servers
and identifies analytics only by a per-install public key thumbprint (if
enabled), we hold no directly identifying personal data about you arising from
its use, and so there is normally nothing to access, correct, port or erase.

If you are in the EEA, the UK or Switzerland, the GDPR rights of access,
rectification, erasure, restriction, portability, objection and withdrawal of
consent still apply to any personal data Sanmarcsoft LLC does hold about you.
Write to privacy@sanmarcsoft.com with the subject line "GDPR Data Subject
Request" and we will respond within 30 days. California residents have the
equivalent CCPA rights; we do not sell personal information.

You may lodge a complaint with a supervisory authority. Our production
infrastructure is in France, so the lead authority is the CNIL,
3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, France, <https://www.cnil.fr>.
We would rather you wrote to us first at privacy@sanmarcsoft.com.

## 9. Children

The extension is not directed at children under 13 and collects no personal
data from anyone, including children.

## 10. Changes

Material changes to this document will be published in this repository, noted in
`CHANGELOG.md`, and reflected in the store listings. The version and effective
date at the top of this file are the record. Because this file is in version
control, every change to it is public and attributable, which is deliberate.

## 11. Checking these claims yourself

You do not have to take our word for any of this. The extension is MIT licensed
and the source is public:

| Claim | Where to check |
|---|---|
| The durable check is off by default | `src/constants.ts`, `MANIFEST_STORE_PROBE_DEFAULT` |
| What the durable check sends | `src/manifestStore.ts` |
| The complete set of network calls | `grep -rn "fetch(" src/` returns exactly six. Five reach external endpoints: rows 3.1, 3.4, 3.5, 3.6, and 3.7 (analytics, opt-in only); the sixth (`src/utils.ts`) is a `data:` URL that reaches no network. |
| The trust-list host allowlist | `src/trustlist.ts`, `ALLOWED_REFRESH_HOSTS` |
| The `?src=` values | `src/constants.ts`, the `ClickSource` type |
| Anonymous analytics implementation | The source file is `src/analytics.ts`, with all events and parameters typed and declared there. A build with an empty `TELEMETRY_RELAY_URL` makes the client completely inert: it never calls `fetch` and never logs. The companion relay service is in `relay/`. |

## 12. Contact

- Privacy: privacy@sanmarcsoft.com
- Support: support@verifieddit.com
- Issues: <https://github.com/Sanmarcsoft/verifieddit-extension/issues>

Sanmarcsoft LLC, Texas, United States.
