# Firefox Add-ons (AMO) Listing: Verifieddit

> Operational submission doc for addons.mozilla.org. Verified against the v1.2.6
> source tree: every permission below is one `src/manifest.firefox.v3.json`
> actually requests, and every UI string is one the code actually renders.
>
> **Applies to:** v1.2.6 · **Last verified:** 2026-09-08
> **Chrome equivalent:** `releases/store-assets/LISTING-COPY.md` is the current
> user-facing copy; `CHROME_WEB_STORE_LISTING.md` is the older operational doc
> and still carries v1.1.0 counts. This file records only what AMO does
> *differently*.

> **2026-09-04 re-verification.** The permission table below was re-checked
> against `src/manifest.firefox.v3.json` at tag `v1.2.4` and is unchanged and
> correct: `storage`, `activeTab`, `contextMenus`, `alarms`, `<all_urls>`, and
> no `offscreen`. What did change since v1.1.1 is the bundled trust material
> (#160 added the CAI known-certificate anchors, so the shipped build carries
> six lists and 82 entities; #487 later resynced those to 84) and the auto-scan badge behaviour (#169: media
> with no Content Credentials is no longer badged during an auto-scan).

> **v1.2.5 delta a reviewer will see.** `options_ui` now points at a real
> preferences page (#170). Before v1.2.5 it pointed at the generator's scaffold,
> so clicking *Preferences* in the Add-ons Manager opened a page with a heading
> and nothing else. The page is now the disclosure surface for
> `data_collection_permissions.optional: ["websiteContent"]`: it explains, in
> the UI rather than only in this document, that the durable-credential check is
> off by default and what it sends when it is on. `open_in_tab` is `false`, so
> it renders inline in the Add-ons Manager. Chrome's manifest drops `options_ui`
> altogether; the same two controls live in the toolbar popup there. No
> permission changed.

> **v1.2.6 delta a reviewer will see.** Four changes, none of them touching
> permissions, hosts or data flow.
>
> 1. `src/verdict.ts` is new (#174, #179). An expired signing certificate no
>    longer reads as a failed integrity check when a *trusted* timestamp
>    authority recorded a signing time *before* that certificate expired. Pure
>    predicates, unit-tested. The durability panel is also gated so a tampered
>    file does not additionally report self-asserted durability.
> 2. `src/trust-anchors/*.json` resynced with the official c2pa.org lists
>    (#487): 29 to 30 signing anchors, 21 to 22 TSA anchors. The addition is the
>    Castlabs C2PA ECC P-384 Root CA. These are bundled data files, not code.
> 3. `src/perceptualHash.ts` rewritten (#164). The optional durable-credential
>    check sends two perceptual hashes of an image to
>    `manifests.sanmarcsoft.com` and asks whether that fingerprint is on record.
>    Our port of the server's hashing pipeline disagreed with it, so the answer
>    was always no. The port is now faithful. **The host, the request shape and
>    the two values sent are unchanged**; only their computation is corrected.
>    Still off by default, still `credentials: 'omit'`, still disclosed in the
>    preferences page and in `PRIVACY_POLICY.md` row 3.4.
> 4. `public/icons/Verifieddit_logo.png` removed. A 1024px master that nothing
>    loaded, copied verbatim into both targets, so it shipped twice. The package
>    drops from 19.82 MiB to 17.36 MiB.
>
> No permission changed, no host changed, no new data category. The remainder of
> the diff is the version bump, `CHANGELOG.md`, `src/releaseNotes.ts` and test
> fixtures, which are not packaged.

## How AMO differs from the Chrome Web Store

These are the deltas that actually change the submission. Everything not listed
here is identical to the Chrome listing.

| Field | Chrome Web Store | AMO |
|---|---|---|
| Add-on name | 75 chars | **45 chars, hard limit**; the CWS name is 46 and is rejected |
| Summary | 132 chars | 250 chars |
| Promo tiles | 1400x560 marquee + 440x280 small | **No equivalent, do not upload** |
| Source code | Not required | **Required** for minified/bundled code (see `AMO_REVIEWER_NOTES.md`) |
| Data disclosure | Privacy tab fields | `data_collection_permissions` in the manifest |
| Categories | One | Up to two |

## Add-on Name (45 char limit)

```
Verifieddit: C2PA Content Credential Verifier
```

Exactly 45 characters. The Chrome name (`Verifieddit - C2PA Content Credential
Verifier`) is 46 and AMO rejects it with
`JSON_INVALID: "/name" must NOT have more than 45 characters`. Do not "fix" this
by re-syncing the two manifests.

## Summary (250 char limit)

```
Verify content authenticity with C2PA Content Credentials. See who signed an image, video, audio file or PDF, whether it was altered since, and what the signer declared about AI origin. Everything is checked locally, and your media is never uploaded.
```

## Categories

- **Primary:** Privacy & Security
- **Secondary:** Other

(The Chrome listing uses "Developer Tools". AMO's audience skews toward the
privacy framing, and the add-on's value is verification, not development.)

## Detailed Description

Reuse the fenced "Detailed description" block of
`releases/store-assets/LISTING-COPY.md` verbatim. That is the post-#166 copy,
the only one carrying v1.2.5 counts, and the only one that has been audited
against the Yellow Argon rejections. Do **not** paste from
`CHROME_WEB_STORE_LISTING.md`: it still reads "Applies to v1.1.0", and writing
listing copy from a stale doc is precisely how v1.2.3 was rejected.

Three edits when pasting:

1. Change "browser extension" phrasing that says *Chrome* to *Firefox*.
2. AMO renders a restricted HTML subset, not Markdown. Bullet lists survive;
   `**bold**` does not, so use `<b>` or plain text.
3. Stop at the closing fence. The prose after it is the "How this is engineered"
   rationale, which names the eight vendors that got v1.2.3 rejected. It is
   commentary for us, never listing copy.

## Support and Identity

| Field | Value |
|---|---|
| Developer / Publisher | SanMarcSoft LLC |
| Homepage | https://www.verifieddit.com |
| Support site | https://www.verifieddit.com |
| Support email | support@verifieddit.com |
| Privacy policy | https://www.verifieddit.com/privacy |
| Source repository | https://github.com/Sanmarcsoft/verifieddit-extension |
| License | MIT |

## Screenshots

Reuse `releases/screenshots/` as-is; all six carry over:

| File | Caption |
|---|---|
| `01-detection.png` | Verdict badges on media, in place, as you browse |
| `02-provenance-graph.png` | The full chain of custody as an interactive graph |
| `03-graph-fullscreen.png` | Expand any provenance graph to full screen |
| `04-popup-validation.png` | Signer, trust status, and declared AI origin |
| `05-popup-trustlists.png` | C2PA Conformance Program anchors, plus your own |
| `06-popup-about.png` | Version, commit, and build provenance |

Do **not** upload `marquee-promo-1400x560` or `small-promo-440x280`; AMO has no
slot for either.

## Data Collection Disclosure

AMO reads this from the manifest rather than a web form. The shipped value:

```json
"data_collection_permissions": {
  "required": ["none"],
  "optional": ["websiteContent"]
}
```

Both halves are load-bearing and both are truthful:

- **`required: ["none"]`**: with default settings the add-on makes no outbound
  request carrying user data. C2PA verification is WASM, entirely in-browser,
  and media bytes never leave the machine.
- **`optional: ["websiteContent"]`**: the Manifest Store probe
  (`src/manifestStore.ts`) is **off unless the user turns it on**. When enabled,
  it sends *perceptual hashes* (pHash/dHash hex digests) of viewed images to
  `manifests.sanmarcsoft.com` to recover credentials stripped from a file. Image
  bytes are never sent, but a perceptual hash of what someone is viewing is
  still information about what they are viewing, so it is disclosed and it is a
  choice rather than a default.

The one remaining lint warning pair
(`KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`) is expected: the key needs Firefox
140 to be *read*, and we target 115. Older Firefox ignores it harmlessly. Do not
raise `strict_min_version` to silence it, since that would drop ESR 115 and 128 users
for no functional gain.

## Permission Justifications

Identical to the Chrome listing except `offscreen`, which the Firefox build does
not request (Firefox has no offscreen API; the C2PA engine runs directly in the
event page). Requested permissions are exactly:

| Permission | Why |
|---|---|
| `storage` | Auto-scan preference and the local trust-list cache. Nothing is synced to a server. |
| `activeTab` | The active tab only, when the user clicks the toolbar button or a context-menu item. |
| `contextMenus` | Adds "Verify with Verifieddit." to the right-click menu for images, video, and audio. |
| `alarms` | A once-daily trust-list refresh. |
| `<all_urls>` (host) | Content Credentials can be on media on any site, so verification cannot be scoped to a fixed host list. Nothing is transmitted; the media is read in-page and verified locally. |

## Pre-submission Checklist

- [ ] `node scripts/package-firefox.mjs` exits 0 (build, manifest gate, linter, package)
- [ ] `addons-linter` reports **0 errors** (warnings documented above are expected)
- [ ] `node scripts/firefox-smoke.mjs` passes against a real Firefox
- [ ] Version in `src/manifest.firefox.v3.json` matches `package.json`
- [ ] Tree is clean and tagged; `build-info.tagDescribe` must not read `-dirty`
- [ ] Both artifacts present in `releases/`: the add-on zip **and** the `-source.zip`
- [ ] `AMO_REVIEWER_NOTES.md` pasted into the "Notes to reviewer" field

## Submission

Listed submission: https://addons.mozilla.org/developers/addon/submit/upload-listed

1. Upload `releases/verifieddit-firefox-<version>.zip`.
2. When asked whether the add-on requires source code: **yes**. Upload
   `releases/verifieddit-firefox-<version>-source.zip`.
3. Paste `AMO_REVIEWER_NOTES.md` into "Notes to reviewer".
4. Fill the listing fields from this document.

### Credentials

`scripts/submit-firefox.mjs` (`bun run submit:firefox`) reads two `pass`
entries and hands them to `web-ext sign` through the environment, never argv:

| Entry | Value |
|---|---|
| `sanmarcsoft/amo/jwt-issuer` | JWT issuer, of the form `user:<id>:<id>` |
| `sanmarcsoft/amo/jwt-secret` | JWT secret, long hex string |

**Creating them** (one time, requires the SanMarcSoft Mozilla account):

1. Sign in at https://addons.mozilla.org/ and accept the Developer Agreement.
2. Open https://addons.mozilla.org/developers/addon/api/key/ and choose
   *Generate new credentials*.
3. **The secret is displayed exactly once.** Copy it before leaving the page.
4. Store both:

   ```bash
   pass insert sanmarcsoft/amo/jwt-issuer
   pass insert sanmarcsoft/amo/jwt-secret
   ```

Treat the secret as a signing key: it can publish code under the SanMarcSoft
name to every Firefox user who has the add-on installed. If it leaks, revoke it
on the same page and generate new credentials.

Verify the wiring without uploading anything:

```bash
bun run submit:firefox -- --dry-run
```

### Why the first submission is still manual

`web-ext sign` does support `--upload-source-code`, so the mandatory source
archive can go through the API. What the API *cannot* do is set listing
metadata: name, summary, categories, screenshots, privacy policy URL and
support contact. For a brand-new listing those must be entered in the Developer
Hub, and we have carefully written copy plus six screenshots to place.

So: **first release through the Hub, every release after that via
`bun run submit:firefox`.**
