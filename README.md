# Verifieddit

**Every image on the internet is asking you to trust it. Verifieddit tells you whether you should.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Sanmarcsoft/verifieddit-browser-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/Sanmarcsoft/verifieddit-browser-extension/actions/workflows/ci.yml)
[![E2E](https://github.com/Sanmarcsoft/verifieddit-browser-extension/actions/workflows/e2e.yml/badge.svg)](https://github.com/Sanmarcsoft/verifieddit-browser-extension/actions/workflows/e2e.yml)

Here is the truth nobody in your feed will say out loud.

Most of what you scroll past carries no proof of where it came from. None. And the tools promising to "detect AI" from pixels are guessing, because pixels do not carry provenance.

Verifieddit does not guess. It reads the cryptographic Content Credential a camera, an editing app, or a signing service embedded in the file. It rebuilds the signature. It traces the certificate back to somebody you have chosen to trust. Free, open source, inside your browser, and nothing you look at ever leaves your machine.

**[Get the extension](https://www.verifieddit.com/extension)** · [How it works](#the-four-answers) · [Build it yourself](#build-it-yourself) · [Sign your own work](#if-you-create-content-sign-it)

---

## The problem is not fakes. The problem is confidence.

Fakes have always existed. What changed is the price of making one, which is now zero.

What did not change is how people decide what is real. Gut feel. Whether the source seems reputable. Whether it "looks right". That worked when a convincing fake took a studio and a week. It does not work when it takes a sentence and four seconds.

You need a different question. Not "does this look real?" but "**who signed this, and has it changed since?**"

That question has a mathematical answer. Verifieddit gives it to you in one click.

## What it does

Browse normally. When a photo, video, audio file or PDF carries a [C2PA](https://c2pa.org) Content Credential, a small badge appears in its corner. Click it, or right-click any media and choose *Verify with Verifieddit*, and you get the whole record: who signed it, what tools touched it, when it was timestamped, and whether a single byte has changed since.

Everything happens locally. The verification engine is WebAssembly bundled inside the extension. No upload, no account, no analytics, no cookies, no record of what you inspected.

## The four answers

Most verification tools give you two states: fine, and not fine. That is how people get fooled. Verifieddit gives you four, and the fourth one is the whole product.

**1. Green: verified and trusted.**
The signature checks out and the signing certificate traces to a trust anchor already loaded, whether it shipped with the extension or you added it yourself.

**2. Yellow: signed, but by whom?**
The manifest is valid, but the signer is in none of your trust lists. Somebody signed it. You decide whether that somebody counts.

**3. Red: altered after signing.**
The bytes no longer match what was signed. This is the one a tampered file cannot talk its way out of.

**4. No badge: unverified. Not clean. Unverified.**
Nothing signed was found. Today that is most of the web. Absence of a warning is not evidence of authenticity, and this extension will never let you read it that way.

That fourth answer is the one most tools quietly skip, because it sounds like a limitation. It is the opposite. It is the reason you can believe the other three.

## What you see when you open it

- **Who signed it**, and which of your trust lists matched
- **The certificate chain**, issuer by issuer
- **Whether an RFC 3161 trusted timestamp** covers the signature
- **An interactive provenance graph** of every ingredient and edit in the file's history. Pan, zoom, expand node by node, or open it full screen
- **Durable credential scoring** across three pillars: signed and timestamped, watermark soft binding, and cloud recoverability. Each shown as verified only when it can actually be verified
- **When something fails, exactly what failed.** Never a bare red mark

## The AI label: read it literally

The panel shows a row called **AI (declared by signer)**. Take that name at face value.

It reports the `digitalSourceType` a signer wrote into their own signed manifest. It does not analyse pixels. It does not guess. Media with no signed manifest, which is most of what you will meet online, reads *not declared* rather than *no*, because an absent declaration is not evidence of human authorship.

Any tool that hands you an AI verdict on an unsigned JPEG is guessing. This one will not pretend otherwise. That honesty is a feature you will only appreciate the day it matters.

## Your data stays yours

Verification runs in your browser. Media bytes never leave your machine. There are zero analytics SDKs and zero tracking calls anywhere in this repository, and you can check.

Data leaves the device in exactly three cases, all of them yours to trigger:

| What | When |
|---|---|
| The URL of one media file | You click *Inspect on Verifieddit* |
| A fixed word naming which part of the extension you clicked from | You click the Trusteddit link |
| A perceptual hash of one image, never the image | **Only if you opt in** to the durable credential check. It ships off |

The full [privacy policy](https://www.verifieddit.com/privacy) is short, because there is not much to say.

## Trust is yours to set

Six trust lists ship built in, 82 entities in total: the C2PA Conformance Program anchors (29 signing, 21 official timestamp authorities), the Content Authenticity Initiative's 26 known-certificate anchors so mainstream cameras and editing software read as trusted out of the box, an AI trust list, and the Trusteddit signing and timestamp anchors.

Add your own from a file or a URL. Remove any list you would rather not rely on. Who counts as trustworthy is configuration you control, not a decision we make for you.

The bundled lists are generated by [`scripts/sync-c2pa-trust-lists.ts`](scripts/sync-c2pa-trust-lists.ts) from the published sources, so you can regenerate them instead of taking our word for it.

## Who this is for

- **Picture desks and journalists** checking a wire photo before it runs
- **Photographers and studios** proving the work is theirs
- **Researchers, moderators, archivists and legal teams** tracing where a file came from before relying on it
- **Anyone who has shared something that turned out to be fake** and would rather check first

## Install in sixty seconds

**From the store:** [verifieddit.com/extension](https://www.verifieddit.com/extension) links to the current Chrome Web Store and Firefox Add-ons listings.

**Or side-load a build you compiled yourself:**

```bash
bun install
bun run build          # produces dist/chrome and dist/firefox
```

- Chrome: `chrome://extensions`, enable Developer mode, *Load unpacked*, pick `dist/chrome`
- Firefox: `about:debugging`, *Load Temporary Add-on*, pick `dist/firefox/manifest.json`

Auto-scan ships **off**. Turn it on from the popup's Options tab, or right-click any image, video or audio element and choose *Verify with Verifieddit*.

## Supported formats

JPEG, PNG, WebP, AVIF, TIFF, SVG, HEIC, HEIF, DNG, ARW, MP4, AVI, WAV, MP3, M4A and PDF.

## Build it yourself

You should not have to trust a verification tool you cannot read. So read it.

| Command | What it does |
|---|---|
| `bun install` | Install dependencies (applies the pinned `c2pa` patch) |
| `bun run build` | Production build. Does **not** trust the demo fixture CA |
| `bun run build:e2e` | Same, but trusts the demo fixtures so the corpus exercises the trusted path |
| `bunx tsc --noEmit` | Type-check |
| `bun test test/*.test.ts` | Unit tests: trust path, durable credentials, AI declaration, probe consent |
| `bun run test` | Playwright end-to-end suite in Chrome |
| `bun run smoke:firefox` | Functional smoke test in real Firefox |
| `bun run serve:fixtures` | Serve the demo corpus on port 3000 |

Use **bun**. Not npm.

**About the demo corpus:** fixtures 01 to 03 read *Untrusted* in a production build. That is correct. Their signing CA is public in this repository, and a key anyone can read is not a basis for trust. Fixture 08 is signed through Trusteddit and is the one that reads as trusted.

## If you create content, sign it

Verifying is the free half.

If you are the photographer, the newsroom, or the team that has to prove its own content is real, [Trusteddit](https://www.trusteddit.com/), from the same publisher, issues the certificates and signs the Content Credentials this extension reads. It also serves organisations documenting provenance for regulatory or compliance reasons, with enterprise PKI and managed Chrome deployment.

Verify with Verifieddit. Sign with Trusteddit. That is the whole loop.

## Contribute

Found a trust-evaluation bug? That is the highest severity we have, because this tool's job is to tell people what to trust. Report vulnerabilities per [`SECURITY.md`](SECURITY.md) to `security@verifieddit.com`. Everything else: open an issue, or a pull request with a test.

If this saved you from sharing something fake, star the repo. It helps the next person find it.

## Attribution and licence

MIT. See [`LICENSE`](LICENSE). Microsoft's original copyright is preserved; SanMarcSoft's modifications are likewise MIT-licensed.

Verifieddit is a fork of Microsoft's [c2pa-extension-validator](https://github.com/microsoft/c2pa-extension-validator), built on [`c2pa-js`](https://github.com/contentauth/c2pa-js) from the [Content Authenticity Initiative](https://github.com/contentauth). Published by **SanMarcSoft LLC**, which is not affiliated with, endorsed by, or partnered with Microsoft, Adobe, or the Content Authenticity Initiative.
