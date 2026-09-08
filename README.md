# Verifieddit: C2PA Content Credential Verifier for Chrome and Firefox

**See who signed a photo, video, audio file or PDF, and whether it was altered since. Free, open source, and it never uploads your media.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Sanmarcsoft/verifieddit-extension)](https://github.com/Sanmarcsoft/verifieddit-extension/releases)
[![E2E](https://github.com/Sanmarcsoft/verifieddit-extension/actions/workflows/e2e.yml/badge.svg)](https://github.com/Sanmarcsoft/verifieddit-extension/actions/workflows/e2e.yml)

Most photos and videos online carry no proof of where they came from, or whether
they were altered since. Verifieddit checks the ones that do.

It is a browser extension that reads the [C2PA](https://c2pa.org) Content
Credential embedded in a file, rebuilds the cryptographic signature, and traces
the signing certificate back to a trust anchor you control. A signed image that
was altered, or whose certificate chain is broken, gets caught here instead of
being shown to you as fine.

Verification runs entirely in your browser using locally bundled WebAssembly.
Media bytes never leave your machine. No account, no analytics, no telemetry, no
cookies.

---

## The four answers

Media carrying Content Credentials picks up a badge as you browse.

| Badge | Meaning |
|---|---|
| **Green** | Signature checks out, and the certificate traces to a trust anchor already loaded, whether bundled or one you added |
| **Yellow** | Valid manifest, but the signer is in none of your trust lists. Signed by somebody, and you decide whether that somebody counts |
| **Red** | The file was altered after signing. The bytes no longer match |
| **No badge** | Nothing signed was found. That means **unverified, not clean**, and today that is most of the web |

That fourth state is the one most verification tools quietly skip. Absence of a
warning is not evidence of authenticity, and this extension will not let you read
it that way. It is also why you can believe the other three.

## What you get when you open it

- Who signed it, and which trust list matched
- The signing certificate, and who issued it to whom
- Whether an RFC 3161 trusted timestamp is present
- An **interactive provenance graph** of every ingredient and edit in the file's
  history: pan, zoom, fit, expand node by node, or open full screen
- **Durable Content Credentials** scored across three pillars (signed and
  timestamped, TrustMark soft binding, manifest-store recoverability), shown as
  verified only when they can actually be verified
- When verification fails, exactly what failed, not a bare red mark

### About the AI label

The popup shows a row called **AI (declared by signer)**. Read it literally. It
reports the IPTC `digitalSourceType` a signer wrote into their own signed
manifest. It does not analyse pixels and it does not guess.

Media with no signed manifest, which is most of what you will meet online, reads
`not declared` rather than `no`, because an absent declaration is not evidence of
human authorship. Any AI image detector claiming a verdict on an unsigned JPEG is
guessing.

## Privacy

Verification is local. The extension collects nothing about you and keeps no
record of what you inspected. There are zero analytics SDKs, zero tracking calls,
and no use of cookies, `localStorage` or `sessionStorage` anywhere in `src/`.

Data leaves the device in exactly five cases. Each one follows something you
did, and none carries an identifier for you, your device or your session:

| What | When |
|---|---|
| The URL of one media file | You click *Inspect on Verifieddit* |
| A fixed word naming an extension surface (`?src=`) | You click the Trusteddit link |
| A perceptual hash of one image | **Only if you opt in** to the durable credential check, which ships off |
| A trust-list refresh | Once a day, and only for a list you imported from a URL yourself |
| A trust-list fetch | You paste a URL into the importer and click Fetch |

Full detail, permission by permission and request by request, in
[`PRIVACY_POLICY.md`](PRIVACY_POLICY.md). That is the policy for this extension.
The [website policy](https://www.verifieddit.com/privacy) is a separate, broader
document covering accounts and billing on verifieddit.com, none of which the
extension has.

## Supported formats

JPEG, PNG, WebP, AVIF, TIFF, SVG, HEIC, HEIF, DNG, ARW, MP4, AVI, WAV, MP3, M4A
and PDF.

## Who uses it

Journalists and picture desks checking wire photos before publication.
Photographers and studios proving their own work is theirs. Researchers,
moderators, archivists and legal teams tracing where a file came from. Anyone who
has shared something that turned out to be fake and would rather check first.

---

## Install

**Chrome Web Store:** v1.1.1 submitted, in review.
**Firefox Add-ons (AMO):** v1.1.1 packaged and verified, awaiting upload; see
[`FIREFOX_ADDON_LISTING.md`](FIREFOX_ADDON_LISTING.md).

**Side-load a build:**

```bash
bun install
bun run build          # produces dist/chrome and dist/firefox
```

- Chrome: `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`
- Firefox: `about:debugging` → *Load Temporary Add-on* → `dist/firefox/manifest.json`

Auto-scan ships **off**. Turn it on from the popup's Options tab, or right-click
any image, video or audio element and choose *Verify with Verifieddit.*

## Develop

| Command | What it does |
|---|---|
| `bun install` | Install deps (applies the pinned `c2pa` patch via `patch-package`) |
| `bun run build` | Production build. Does **not** trust the demo fixture CA |
| `bun run build:e2e` | Same, but trusts the demo fixtures so the corpus exercises the trusted path |
| `bun run build:debug` | Development build with inline source maps |
| `bunx tsc --noEmit` | Type-check |
| `bun test test/*.test.ts` | Unit tests (trust path, durable credentials, AI detection, probe consent) |
| `bun run test` | Playwright end-to-end suite, Chrome (`test/e2e`) |
| `bun run smoke:firefox` | Functional smoke test in real Firefox via geckodriver |
| `bun run package:firefox` | Build, gate, lint and package the AMO submission |
| `bun run submit:firefox` | Sign and upload a new version to AMO (creds from `pass`) |
| `bun run serve:fixtures` | Serve the demo corpus on `:3000` |

Always use **bun**, never npm/npx.

### A note on the demo corpus

Fixtures 01 to 03 read **Untrusted** in a production build. That is correct, not
a failure: their signing CA is public in this repository, and shipped builds
deliberately do not load it. A signing key anyone can read is not a basis for
trust. Fixture 08 is signed through [Trusteddit](https://www.trusteddit.com/) and
is the one that reads as trusted.

## Trust setup

Six trust lists ship built in, 84 entities in total: the C2PA Conformance
Program anchors (30 signing, 22 official timestamp authorities), the Content
Authenticity Initiative's 26 known-certificate anchors, an AI trust list, and
the Trusteddit signing and timestamp anchors.

Add your own from a file or a URL, or remove any list you would rather not rely
on, from the options page. Who counts as trustworthy is configuration you
control, not a decision made for you.

## Security

Verifieddit's job is to tell people what to trust, so trust-evaluation bugs are
treated as high severity. Report vulnerabilities per [`SECURITY.md`](SECURITY.md)
to `security@verifieddit.com`, **not** to Microsoft.

## If you sign your own work

Verifying is the free half. [Trusteddit](https://www.trusteddit.com/), from the
same publisher, issues the certificates and signs the Content Credentials this
extension reads, with enterprise PKI and Chrome enterprise policy deployment for
organisations that need to document content provenance.

## Attribution and licence

MIT. See [`LICENSE`](LICENSE). Microsoft's original copyright is preserved;
SanMarcSoft's modifications are likewise MIT-licensed.

Verifieddit is a fork of Microsoft's
[c2pa-extension-validator](https://github.com/microsoft/c2pa-extension-validator),
built on [`c2pa-js`](https://github.com/contentauth/c2pa-js) from the
[Content Authenticity Initiative](https://github.com/contentauth). Published by
**SanMarcSoft LLC**, which is not affiliated with, endorsed by, or partnered with
Microsoft, Adobe, or the Content Authenticity Initiative.
