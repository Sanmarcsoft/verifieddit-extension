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
| 3.7 | Anonymous usage statistics | Only if you opted in to share usage statistics (off by default) | google-analytics.com (`https://www.google-analytics.com/mp/collect`) | A random client UUID, session ID, event name, extension version, engagement time, and event parameters (e.g. verify result enum, media type). No URLs, media, or personal data. |

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

**3.7, anonymous usage statistics.** We use the Google Analytics 4 Measurement
Protocol to collect aggregate, anonymous product metrics so we know whether the
extension is working and which features are used.

This is **off by default**. It sends nothing unless you explicitly opt in by
clicking "Yes" on the first-run consent banner or by toggling "Share anonymous
usage statistics" on in Options.

What IS sent:
- A random identifier (`crypto.randomUUID()`) generated on your device and stored
  in `chrome.storage.local` (`ga4ClientId`). It is not tied to your identity,
  account, or hardware.
- A session identifier derived from the current timestamp, stored in
  `chrome.storage.session` (or in memory on Firefox) and discarded after
  30 minutes of inactivity.
- The event name, extension version, and elapsed `engagement_time_msec`.
- Event-specific parameters: `previous_version` on an update
  (`extension_updated`); `source` on verification start (`verify_started`:
  `context_menu`, `popup`, or `auto_scan`); `result` (`valid`, `invalid`,
  `none`, or `error`), `has_durable_binding` (boolean), and `media_type`
  (`image`, `video`, `audio`, or `pdf`) on verification completion
  (`verify_completed`); and `value` (`granted`) on consent change
  (`consent_changed`).
- The complete list of events is strictly: `extension_installed`,
  `extension_updated`, `verify_started`, `verify_completed`, `badge_scan`,
  `options_opened`, `consent_changed`.

What is NOT sent:
No URLs, no page titles, no page content, no file names, no image, video, or
audio data, no hashes of user media, no signer identities, no certificate
details, no account or contact details, and nothing that identifies you or your
device beyond the random identifier.

Google receives the request's IP address, as it does for any HTTPS network
request.

Auto-scan telemetry is throttled to at most one `verify_started`,
`verify_completed`, and `badge_scan` set per browser tab per minute, ensuring
page scanning does not become a per-image beacon.

You can turn it off at any time in Options. Turning it off stops all outbound
analytics traffic immediately. Because no accounts exist and data is pseudonymous
under a random UUID, there is no separate deletion request flow.

## 4. What is stored, and where

Only on your device, in `chrome.storage.local` and `chrome.storage.session`.
Nothing is synced to a server or to your browser profile sync.

| Key | What it is |
|---|---|
| `autoScan` | Whether automatic scanning is on |
| `manifestStoreProbe` | Whether the durable-credential check is on |
| `trustList` | The cached trust lists, bundled and imported |
| `rc117AutoScanMigrationDone` | A one-time settings migration flag |
| `analyticsConsent` | Consent status for usage statistics (`granted`, `denied`, or `unset`) |
| `ga4ClientId` | Random UUID generated locally for anonymous analytics |
| `ga4SessionData` | Ephemeral session ID and timestamp in `chrome.storage.session` (discarded after 30 minutes of inactivity) |

Transient C2PA engine startup errors and ephemeral GA4 session data
(`ga4SessionData`) are held in `chrome.storage.session` (or in memory on Firefox).
Your browser clears that automatically when it closes, and session data expires
after 30 minutes of inactivity.

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
  only the minimal, typed GA4 Measurement Protocol endpoint when explicitly
  enabled.
- No cookies. No advertising identifiers. No browser fingerprinting.
- No sale or commercial brokering of data. We do not sell or monetize user data.
- No account, no sign-in, no email address or contact information collected.
- No remote code. Every executable byte ships inside the extension package. The
  WebAssembly module and its worker are loaded strictly from the extension's own
  origin.

## 6. Permissions, and why each one exists

| Permission | Why it is needed |
|---|---|
| `storage` | The settings above, consent state, random client ID, and the local trust-list cache |
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
  on Firefox. When off, zero analytics requests are sent.
- **Trust lists:** you can add and remove them, including your own.
- **Everything else:** uninstalling removes all locally stored data.

## 8. Your rights

Because the extension stores no identifying personal information on our servers
and identifies analytics sessions only by a locally generated random UUID (if
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
| Anonymous analytics implementation | The source file is `src/analytics.ts`, with all events and parameters typed and declared there. A build without `GA4_MEASUREMENT_ID` and `GA4_API_SECRET` makes the client completely inert: it never calls `fetch` and never logs. |

## 12. Contact

- Privacy: privacy@sanmarcsoft.com
- Support: support@verifieddit.com
- Issues: <https://github.com/Sanmarcsoft/verifieddit-extension/issues>

Sanmarcsoft LLC, Texas, United States.
