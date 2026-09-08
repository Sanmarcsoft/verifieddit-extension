# Verifieddit v1.2.6 Chrome Web Store listing copy

Every claim checked against the v1.2.6 source. No em-dashes. No brand roll-calls
(see "No brand roll-call" under SEO before touching the trust section).

---

## Item name (75 max)

```
Verifieddit - C2PA Content Credential Verifier
```

45 characters. Carries the two highest-intent search terms, "C2PA" and "Content Credential", plus the category word "Verifier".

---

## Summary (132 hard cap), already in the shipped manifest

```
Verify content authenticity with C2PA Content Credentials. See who signed a file, whether it was altered, and declared AI origin.
```

129 characters.

---

## Detailed description

```
Most photos and videos online carry no proof of where they came from, or whether they were altered since. Verifieddit checks the ones that do, free, in your browser, with no account.

It does not just repeat what a file says about itself. It rebuilds the signature on the file's C2PA Content Credential and traces the signing certificate back to an issuer you trust, the way your browser checks a padlock before you trust a website. A signed photo that was altered, or whose certificate chain is broken, gets caught here instead of being shown to you as fine.

Browse normally. Media carrying Content Credentials picks up a small badge in the corner.


THE FOUR ANSWERS

GREEN: the signature checks out and the certificate traces back to a trust anchor already loaded, whether we shipped it or you added it yourself.

YELLOW: the manifest is valid, but the signer is in none of your trust lists. Signed by somebody, and you decide whether that somebody counts.

RED: the file was altered after it was signed. The bytes no longer match what was signed.

NO BADGE: nothing signed was found here. That means unverified, not clean, and today that is most of the web.

That fourth answer is the one most verification tools quietly skip. Absence of a warning is not evidence of authenticity, and this extension will not let you read it that way. It is also why you can believe the other three.


WHAT YOU SEE WHEN YOU OPEN IT

Click any badge, or right click any image, video or audio file and choose "Verify with Verifieddit", and you get the whole record:

- who signed it, and which trust list matched
- the signing certificate, and who issued it to whom
- whether an RFC 3161 trusted timestamp is present
- an interactive provenance graph of every ingredient and edit in the file's history, which you can pan, zoom, fit, expand node by node, or open full screen
- and when verification fails, exactly what failed, rather than a bare red mark

The same panel is one click away in the toolbar popup for whatever is on the page you are viewing.


ABOUT THE AI LABEL

The popup shows a row called "AI (declared by signer)". Read that label literally. It reports the IPTC digitalSourceType a signer wrote into their own signed manifest. It does not analyse pixels and it does not guess.

Media carrying no signed manifest, which is most of what you will meet online, reads "not declared" rather than "no", because an absent declaration is not evidence of human authorship. Any AI image detector that claims a verdict on an unsigned JPEG is guessing, and this one will not pretend otherwise.


IT TELLS YOU WHAT IT CANNOT CONFIRM

Content Credentials have more than one layer, and the panel scores three: signed and timestamped, a durable watermark, and cloud recovery if the file is re-encoded or stripped.

Often only the first can be confirmed from what is inside the file, and the panel says so plainly, "1 of 3 verified", instead of handing you a clean result you would discover was fragile later. An embed-only credential is real, but it does not survive a screenshot.


YOUR PRIVACY

Verification runs entirely inside your browser using locally bundled WebAssembly. Media bytes never leave your machine. No analytics, no telemetry, no cookies, no account, and no record of what you inspected.

One optional feature can send anything at all, and it is off until you switch it on. Enable the durable credential check and the extension asks our manifest store whether a credential is registered for an image, sending a short perceptual fingerprint of that picture. Never the image, never the page, and nothing identifying you or your device. You turn it on from the panel itself, which states exactly what would be sent before anything is, and off again whenever you like. Section 2.9 of the privacy policy has the detail.


WHY IT ASKS FOR ACCESS TO ALL SITES

Content Credentials can appear on any page you visit, so the extension has to read the media on the page you are actually looking at. It makes no other use of that access.


TRUST IS YOURS TO SET

Six trust lists ship built in, 84 entities in total: the C2PA Conformance Program anchors, 30 for signing and 22 official timestamp authorities; the Content Authenticity Initiative's 26 known-certificate anchors, the same production roots the Content Credentials Verify site trusts, so photos from mainstream cameras and edits from mainstream software read as trusted out of the box; an AI trust list; and the Trusteddit signing and timestamp anchors.

Add your own trust list from a file or a web address at any time, or remove any list you would rather not rely on. Who counts as trustworthy is configuration you control, not a decision we make for you.


WHAT IT CAN READ

Photographs, video, audio and PDF documents, across sixteen file formats: the ones the web is built on, the raw formats photographers shoot in, and the newer formats publishers have started serving. Coverage tracks what the C2PA specification supports, and the current list is kept in the repository README next to the code that implements it.


WHO USES IT

A picture desk checking a wire photo before it runs. A photographer proving the work is theirs. Anyone tracing where a file came from before relying on it, or who has shared something that turned out to be fake and would rather check first.


IF YOU SIGN YOUR OWN WORK

Verifying is the free half. If you are the photographer, the newsroom or the team that has to prove its own content, Trusteddit, from the same publisher, issues the certificates and signs the Content Credentials this extension reads. It also serves organisations documenting content provenance for regulatory or compliance reasons, with enterprise PKI and Chrome enterprise policy deployment across managed fleets.


ABOUT

Free and open source, MIT licensed. Source code, issue tracker and full release history at github.com/Sanmarcsoft/verifieddit-browser-extension.

Published by SanMarcSoft LLC as an independent fork of Microsoft's open source C2PA validator, built on the Content Authenticity Initiative's c2pa toolkit. SanMarcSoft is not affiliated with, endorsed by, or partnered with Microsoft, Adobe, or the Content Authenticity Initiative.
```

---

## How this is engineered

### Persuasion

**The first screen does four jobs.** Problem, mechanism, the objection handler ("free, in your browser, with no account"), and the strongest sentence in the listing: *"gets caught here instead of being shown to you as fine."* That line was buried three paragraphs down in the first draft. A reader who bounces never reaches a differentiator, however good it is.

**The honesty is the marketing.** `NO BADGE: nothing signed was found here. That means unverified, not clean.` Competitors omit the fourth state because it sounds like a limitation. Naming it is what makes the other three credible, and it is the sentence the target professional said turned a maybe into an install.

**Every limitation is converted, not hidden.** The AI section and "IT TELLS YOU WHAT IT CANNOT CONFIRM" both take a constraint and make it the reason to trust the tool. `Any AI image detector that claims a verdict on an unsigned JPEG is guessing` competes directly against the category's biggest overclaim.

### SEO

**Front-loaded, not stuffed.** High-intent terms land in the first two sentences and recur naturally: C2PA, Content Credentials, content authenticity, verify, signed, altered, certificate, provenance, AI.

**Long-tail phrasing throughout**, matching how people actually search: "who signed a photo", "whether it was altered", "certificate chain", "trusted timestamp", "AI image detector", "content provenance", "image metadata", "verify photo authenticity".

**Audience terms earn their place.** "WHO USES IT" captures journalist, picture desk, photographer, studio, researcher, moderator, archivist and legal team as searchable terms while doing real persuasive work rather than sitting as a keyword list.

**No format enumeration, deliberately.** An earlier draft listed sixteen file
extensions on the reasoning that each one catches "verify [format] C2PA"
queries. Chrome rejected v1.1.1 for it on 2026-08-05 (Yellow Argon, keyword
stuffing), quoting that line back verbatim. The policy example is "lists of
sites/brands/keywords without substantial added value", and a bare run of
extensions is exactly that: it ranks, but it tells a reader nothing. Format
coverage is now one sentence of prose naming no extensions at all, and the
enumeration lives in the README where it is useful and where store policy does
not reach. **Do not put it back.**

**No brand roll-call, deliberately.** The v1.2.3 draft described the CAI
known-certificate list by naming the vendors behind its roots: "Adobe, Leica,
Nikon, Canon, Sony, Fujifilm, Microsoft and Truepic". Chrome rejected it on
2026-09-03, again under Spam and Placement in the Store (Yellow Argon), quoting
those eight names back verbatim. Google's spam FAQ is explicit: "When listing
supported websites or brands in the description, do not list more than five",
and any single keyword should appear fewer than five times. The trust section
now says what the list does for the reader (mainstream cameras and software
read as trusted) and names no vendor. The vendor names live in the trust list
JSON and the CHANGELOG, where they are facts rather than search bait. **Do not
put them back.** The one brand mention that stays is the ABOUT paragraph, which
is a required non-affiliation disclaimer, not a feature claim.

**Audience terms are scenarios, not a roll-call.** The same section once named
eight professions in a row, which reads as a keyword list even though it is
punctuated as prose. It is now two concrete situations plus a general one.

**What is deliberately absent:** "detects AI", "deepfake detector", "proves authenticity". They rank, and they are false on unsigned media, which is most media. The AI section turns that into the differentiator instead. A listing that overclaims gets pulled, and this product's entire premise is not overclaiming.

---

# Privacy tab (Chrome Web Store Developer Dashboard)

Paste-ready. Each field is under the 1,000 character limit. Every statement was
checked against the v1.2.3 source, not from memory, because a justification that
does not match the code is a rejection.

## Single purpose

```
Verifieddit verifies the authenticity and provenance of images, videos, audio files and PDFs on any webpage, by reading and cryptographically validating the C2PA Content Credentials embedded in those files.

Every feature and permission serves that one purpose. The badges, the provenance panel and the right-click item are the same verification presented in different places. The AI row reports a digitalSourceType value read out of the manifest being verified; it is one field of the credential, not a separate detection product. Trust list management configures which signing certificates the verification trusts. The link to Trusteddit is an ordinary outbound hyperlink to the publisher's signing service and performs no function inside the extension.

No feature exists for any unrelated purpose, and no permission is exercised for any unrelated purpose.
```

## storage justification

```
Stores the user's own settings and the trust lists that verification is checked against, using chrome.storage.local and chrome.storage.session only.

Three things are kept: the auto-scan preference, the opt-in for the durable-credential check, and the cached trust lists (both the lists bundled with the extension and any the user imports). Certificate validation cannot happen without the trust anchors being available locally, and the user's preferences must survive a browser restart to be useful.

Nothing here is synced to a server, transmitted, or shared. No browsing history, no verification results, and no record of which media the user inspected is stored. Ephemeral engine-initialisation errors are held in chrome.storage.session so the popup can show a banner if the C2PA engine fails to load, and the browser clears that automatically on close.
```

## activeTab justification

```
Scopes verification work to the single tab the user is acting on.

When the user clicks the toolbar icon, the popup reports on media in the currently active tab. When the user selects "Verify with Verifieddit" from the right-click menu, the extension inspects the media element in that tab. activeTab limits both to the one tab involved in that interaction, rather than granting standing access to every open tab.

Without it, the popup could not tell the user what is on the page in front of them, and the context-menu item could not resolve which media element was clicked. It is used for no other purpose, and it grants nothing when the user is not interacting with the extension.
```

## contextMenus justification

```
Adds a single item, "Verify with Verifieddit.", to the right-click menu on image, video and audio elements.

Automatic scanning is a preference the user can turn off, and many users prefer to keep it off and check individual files deliberately. The context-menu item is how they do that: right-click any media element, and the extension verifies that file's C2PA Content Credentials and opens the result.

It is registered only for image, video and audio contexts, so it does not appear on ordinary page text or links. It adds no other menu entries, no submenus, and no items unrelated to verification.
```

## alarms justification

```
Schedules a periodic refresh of trust lists the user has imported, so certificate validation is checked against current anchors rather than a stale copy.

One alarm is registered, "trustListRefreshAlarm", at a 24 hour interval (TRUSTLIST_UPDATE_INTERVAL = 1440 minutes). It only re-fetches lists that carry a download_url, which means only lists the user has explicitly imported from a URL. The trust lists bundled with the extension set no download_url and are never re-fetched.

Refreshes are additionally restricted to an allowlist of hosts. Revoked or newly added signing anchors are the difference between a correct and an incorrect trust verdict, so a periodic refresh is part of verifying accurately. The permission is used for nothing else.
```

## offscreen justification

```
Hosts the C2PA WebAssembly verification engine in an offscreen document, because a Manifest V3 service worker cannot run it.

Verification is performed by the C2PA WASM toolkit, which needs a DOM context for image decoding (createImageBitmap, OffscreenCanvas) and a persistent execution context while a file is parsed. An MV3 service worker provides neither and is terminated aggressively. The offscreen document is created with reason DOM_PARSER solely to run this engine.

It renders nothing the user sees, hosts no UI, and makes no network requests of its own. It exists only while verification runs. Without it, the extension could not verify a single file in Chrome; this permission is the mechanism by which the extension's one purpose is carried out.
```

## Host permission justification

```
Content Credentials can be embedded in media on any website, so the extension must be able to read media on whatever page the user is viewing.

The content script looks at image, video and audio elements already loaded on the current page and reads their bytes to parse the C2PA manifest embedded inside them. Verification then runs locally in WebAssembly. Narrowing this to a list of sites would mean the extension could only verify media on sites we chose in advance, which defeats its single purpose: the whole point is that authenticity can be checked wherever the user encounters a file.

The access is used for nothing else. No page content is collected, no browsing history is recorded, no data is transmitted, and no analytics exist anywhere in the codebase. Media bytes are read, parsed locally, and discarded.
```

Expect the host permission to trigger an in-depth review. That is normal for
`<all_urls>` and is not a sign anything is wrong; the justification above states
the necessity and the limits plainly.

## Are you using remote code?

**Select: No, I am not using remote code.**

Verified against the built package: zero occurrences of `eval`, `new Function`
or `importScripts`; one `WebAssembly.compileStreaming` compiling the packaged
`c2pa.wasm`; three `new Worker` calls loading the packaged
`c2pa-web.worker.js`; and no remote script or wasm origin. If the field accepts
a justification anyway:

```
No remote code is used. Every executable byte ships inside the package.

The C2PA verification engine is the packaged file c2pa.wasm, compiled from the local extension URL with WebAssembly.compileStreaming. Its worker is the packaged file c2pa-web.worker.js, loaded from the extension's own origin. There are no <script> tags referencing external files, no modules pointing at external files, and no eval() or new Function() anywhere in the shipped bundle.

The manifest CSP is "script-src 'self' 'wasm-unsafe-eval'". 'wasm-unsafe-eval' is required to compile the packaged WebAssembly module; it does not permit remote code, and no remote origin is fetched for script or wasm.

The extension does contact the network to read the bytes of media already displayed on the page, and, only if the user opts in, to check a credential registration. Neither returns executable code.
```

## Data usage declaration

Declare **Website content**, used for **App functionality**.

Do not tick a blanket "collects no data". Three things can leave the device, all
disclosed in the published privacy policy:

| What | When | Policy |
|---|---|---|
| URL of one media file | User clicks "Inspect on Verifieddit" | 2.1 |
| A fixed surface name (`?src=`) | User clicks the Trusteddit link | 2.8 |
| Perceptual hash of one image | Only if the user opts in to the durable-credential check | 2.9 |

None is sold, used for advertising, or transferred to third parties. A
declaration that contradicts your own published policy is a straightforward
rejection, and the policy is public at verifieddit.com/privacy.
