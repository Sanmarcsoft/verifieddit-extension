/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

/**
 * Single owner of "what differs between Chrome and Firefox".
 *
 * Before this module the engine differences were scattered across four places
 * with no common owner — the Firefox manifest, the `c2paProxy -> c2pa` rollup
 * alias, the `BROWSER_TARGET` build flag read inline in background.ts, and
 * (#149) the messaging path that reaches the overlay iframe. Answering "what
 * differs between the two builds?" meant grepping four unrelated files and
 * hoping the list was complete. It was not: #149 shipped a packaged, linter-
 * clean Gecko build whose overlay never opened.
 *
 * Everything engine-specific that lives in `src/` belongs here, behind a name
 * that says what the capability IS rather than which browser has it.
 *
 * Known engine differences, and where each is handled:
 *
 * | Difference                          | Owner                                |
 * |-------------------------------------|--------------------------------------|
 * | Manifest shape (MV3 dialects)       | `src/manifest.{chrome,firefox}.v3.json` |
 * | c2pa entry point (proxy vs direct)  | rollup alias, `rollup.config.js`     |
 * | `chrome.offscreen` availability     | `IS_FIREFOX` below, used by background.ts |
 * | runtime.sendMessage frame fan-out   | `RUNTIME_MESSAGE_REACHES_SIBLING_FRAMES` below |
 */

// Build-time browser target, inlined by rollup's replace plugin so the branches
// below are constant-folded rather than evaluated at runtime. 'chrome' is the
// default; the Gecko bundle is built with 'firefox'.
//
// The `: string` annotation is load-bearing. `replace` runs ahead of rpt2, so
// TypeScript sees the already-substituted literal and rejects the comparison as
// non-overlapping (TS2367). Widening to string keeps the check legal for tsc
// while leaving terser a literal it can still fold away.
const BROWSER_TARGET: string = process.env.BROWSER_TARGET ?? 'chrome'

/**
 * True on the Gecko bundle.
 *
 * Consumers must keep using this as a plain `if (IS_FIREFOX) return` guard and
 * nothing cleverer. Rollup propagates the literal across the module boundary and
 * terser then drops the dead branch entirely, which is required rather than
 * merely tidy: AMO's validator reports every *textual* `chrome.offscreen`
 * reference as UNSUPPORTED_API even when it is unreachable at runtime, so the
 * identifier has to be absent from the shipped bundle. `scripts/package-firefox.mjs`
 * asserts this on the built artifact.
 */
export const IS_FIREFOX = BROWSER_TARGET === 'firefox'

/**
 * Whether `chrome.runtime.sendMessage()` from a content script is delivered to
 * an extension page hosted as an iframe **in the same tab** (#149).
 *
 * Chrome fans a runtime message out to every extension context holding a
 * `runtime.onMessage` listener — service worker, popup, options page, and
 * embedded extension pages. Gecko does not deliver to the embedded frame. The
 * send resolves without throwing, so the failure is completely silent: the
 * click registers, no error surfaces anywhere, and the overlay simply never
 * opens.
 *
 * Nothing in the codebase should branch on this. It exists to name the
 * difference and to point at the fix, because the tempting shape ("just
 * sendMessage, it works in Chrome") is exactly what shipped a dead UI to a
 * packaged build. The overlay payload is relayed through the background over a
 * named port instead — see PORT_OVERLAY_FRAME in constants.ts — which is one
 * code path that is correct on both engines.
 */
export const RUNTIME_MESSAGE_REACHES_SIBLING_FRAMES = !IS_FIREFOX
