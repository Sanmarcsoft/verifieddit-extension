# Notes to Reviewer — Verifieddit

Thank you for reviewing. This document covers the build, the two findings the
linter reports, and the reasoning behind the broad host permission.

## What the add-on does

Verifieddit reads C2PA Content Credentials (an open provenance standard from the
Coalition for Content Provenance and Authenticity, adopted by Adobe, Google,
Microsoft, and the BBC) that are embedded in images, video, audio, and PDFs on
the pages you visit. It reports who signed the file, whether the bytes changed
since signing, and what the signer declared about AI origin.

All verification is local. The C2PA engine is WebAssembly and runs in-browser.
Media bytes are never transmitted anywhere.

## Source code submission

The uploaded package is a rollup + terser production build, so a source archive
accompanies it (`verifieddit-firefox-<version>-source.zip`).

**Environment**

| Tool | Version |
|---|---|
| Node.js | v25.2.1 (any 20+ works) |
| Bun | 1.3.14 |
| OS built on | macOS, arm64 |

**Build steps**

```bash
bun install --frozen-lockfile   # installs from the committed bun.lock
bun run build                   # runs prebuild, then rollup -c
```

The reviewable artifact is the **`dist/firefox`** directory. The uploaded zip is
that directory archived at its root (no wrapping folder), which is exactly what
`web-ext build --source-dir dist/firefox` produces.

**Two things worth knowing before you diff the output**

1. `scripts/generate-build-info.js` runs during `prebuild` and generates
   `src/build-info.ts`, which is `.gitignore`d. It is **included in the source
   archive** so you do not have to reproduce it. It records the git commit and
   an ISO `buildDate`; that timestamp differs on every build, so the bundle is
   not byte-identical between runs. Everything else is deterministic. If you
   rebuild in a directory with no `.git`, the git fields read `"unknown"` —
   that is expected, not tampering.
2. `scripts/extract-c2pa-worker.mjs` copies the C2PA worker out of
   `node_modules/@contentauth/c2pa-web` into `public/c2pa-web.worker.js`, and
   `scripts/patch-c2pa-worker-scheme.mjs` patches that upstream library to load
   its worker from a packaged file rather than a `blob:` URL. The patch exists
   **specifically for Firefox**: our CSP does not allow `blob:` in `script-src`,
   and we preferred patching the library over loosening the policy. Both scripts
   are in the archive and run as part of `prebuild`.

## Linter findings, and why they stand

`addons-linter` 10.10.0 reports **0 errors** and 8 warnings on this package.
The 8 break down as follows.

### 6x `UNSAFE_VAR_ASSIGNMENT` — assignment to innerHTML

Two sources:

- **Lit** (`chunk-property-*.js`) — the templating library's own internals.
- **`popup.js`**, from `src/popup.ts` — building the trust-list and validation
  panels.

Every interpolated value in `popup.ts` that could carry untrusted content is
escaped through the `esc()` helper defined at `src/popup.ts:356` before it
reaches `innerHTML`. This was hardened deliberately in issue #59. The remaining
assignments interpolate either escaped strings or string literals under our
control. The add-on's CSP is `script-src 'self' 'wasm-unsafe-eval'` with no
`unsafe-inline`, so injected markup cannot execute script regardless.

### 2x `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` — data_collection_permissions

> "strict_min_version" requires Firefox 115, which was released before version
> 140 introduced support for "data_collection_permissions".

Intentional. We declare `data_collection_permissions` because AMO requires the
disclosure, and we target `strict_min_version: 115.0` so that ESR 115 and ESR
128 users are supported. Firefox versions below 140 ignore the key harmlessly.
Raising the minimum to 140 purely to silence a warning would drop every ESR user
for no functional benefit.

## Data collection

```json
"data_collection_permissions": { "required": ["none"], "optional": ["websiteContent"] }
```

- **Required: none.** In its default configuration the add-on makes no outbound
  request carrying user data.
- **Optional: websiteContent.** One feature, the Manifest Store probe
  (`src/manifestStore.ts`), is **off by default** and must be switched on by the
  user. When on, it sends perceptual hashes (pHash/dHash hex digests) of images
  to `manifests.sanmarcsoft.com` to recover Content Credentials that were
  stripped from a file. Image bytes are never sent. We still disclose it,
  because a perceptual hash of a viewed image is information about what the user
  is viewing.

The gate is enforced at a single entry point in `manifestStore.ts` rather than at
each call site, so no caller can reach the network by forgetting to check.

There is no analytics, no telemetry, and no account.

Other network traffic, none of it user data:

- C2PA trust lists are fetched from their publishers with `credentials: 'omit'`
  (`src/trustlist.ts`), once a day via the `alarms` permission.
- Clicking "view full report" opens `https://www.verifieddit.com/` in a new tab
  with the media URL as a query parameter. This is user-initiated and disclosed
  in section 2.8 of our privacy policy.

## Why `<all_urls>`

Content Credentials can be attached to media on any site, so the add-on cannot
know in advance which hosts to scope to; a fixed host list would make it
non-functional on the sites users most want to check.

Mitigations:

- **Automatic scanning ships OFF.** On install, `autoScan` is set to `false`.
  Nothing is inspected until the user either enables auto-scan in the popup or
  right-clicks a specific media element and chooses "Verify with Verifieddit."
- Media is read in-page and verified locally in WebAssembly. Nothing is uploaded.
- The content script only reads media elements; it does not read page text, form
  fields, cookies, or credentials.

## Testing it yourself

The repository ships a fixture corpus with a deliberate spread of outcomes:
valid signatures, an untrusted signer, tampered pixels, and an unsigned file.

```bash
AUTO_SCAN=true TRUST_DEV_FIXTURES=true bun run build
bun run serve:fixtures            # http://localhost:3000
node scripts/firefox-smoke.mjs    # installs into real Firefox, asserts badges
```

`AUTO_SCAN=true` only flips the shipped default so the corpus self-verifies
without manual clicking; the verification path is identical to the released
build. On Firefox 151 this renders eight verdict badges across the eight corpus
images.

To exercise it by hand, load `dist/firefox/manifest.json` via
`about:debugging` → *Load Temporary Add-on*, then right-click any image on a
site that publishes Content Credentials and choose "Verify with Verifieddit."

## Contact

support@verifieddit.com — happy to answer anything or supply additional builds.
Source: https://github.com/Sanmarcsoft/verifieddit-browser-extension (MIT).
