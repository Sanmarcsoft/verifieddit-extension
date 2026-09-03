#!/usr/bin/env node
/*
 * Firefox functional smoke test.
 *
 * Why this exists instead of a Playwright project: Playwright cannot install
 * WebExtensions into Firefox at all. geckodriver can, via the non-standard
 * WebDriver endpoint POST /session/:id/moz/addon/install with temporary:true,
 * which is the same mechanism `web-ext run` uses. So the Chrome side stays on
 * Playwright (test/e2e) and the Gecko side is driven from here.
 *
 * What it proves that `web-ext lint` cannot: that the C2PA WASM engine actually
 * initialises inside a Firefox MV3 *event page* (Chrome runs it in an offscreen
 * document, which Firefox has no equivalent for), and that verdict badges reach
 * the DOM. Lint is a static gate; this is the behavioural one.
 *
 * The extension ships with auto-scan OFF, so a passive page load would prove
 * nothing. Build the bundle under test with AUTO_SCAN=true so it self-triggers:
 *
 *   AUTO_SCAN=true TRUST_DEV_FIXTURES=true bun run build
 *   bun run serve:fixtures &
 *   node scripts/firefox-smoke.mjs
 *
 * Usage: node scripts/firefox-smoke.mjs [--url URL] [--min N] [--source-dir DIR]
 *                                       [--firefox PATH] [--headed]
 * Exit code 0 = pass, 1 = fail.
 */

import { execSync, spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const URL_UNDER_TEST = arg('url', 'http://localhost:3000/demo-corpus/')
const MIN_BADGES = Number(arg('min', '5'))
const SOURCE_DIR = path.resolve(repoRoot, arg('source-dir', 'dist/firefox'))
const FIREFOX_BIN = arg('firefox', '/Applications/Firefox.app/Contents/MacOS/firefox')
const HEADED = process.argv.includes('--headed')
const CLICK_PROBE = process.argv.includes('--click')
const PORT = Number(arg('port', '4444'))
const BASE = `http://127.0.0.1:${PORT}`

// Badge contract: src/icon.ts appends a div carrying the `c2pa-icon` attribute
// to document.body for every media element it reaches a verdict on.
const BADGE_SELECTOR = '[c2pa-icon]'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wd (method, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = json?.value?.message ?? JSON.stringify(json)
    throw new Error(`${method} ${endpoint} -> ${res.status}: ${err}`)
  }
  return json.value
}

async function waitForDriver (timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/status`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`geckodriver did not start on ${BASE}`)
}

let driver
let sessionId

async function main () {
  console.log(`[smoke] extension : ${SOURCE_DIR}`)
  console.log(`[smoke] target    : ${URL_UNDER_TEST}`)
  console.log(`[smoke] firefox   : ${FIREFOX_BIN}`)
  console.log(`[smoke] threshold : >= ${MIN_BADGES} badges\n`)

  /*
   * geckodriver is deliberately NOT a devDependency: its postinstall downloads
   * a platform binary, which would both churn bun.lock and break offline/CI
   * installs for everyone who never runs this test. Fail with instructions
   * instead of failing obscurely inside spawn().
   */
  try {
    execSync('command -v geckodriver', { stdio: 'ignore' })
  } catch {
    throw new Error(
      'geckodriver not found on PATH.\n' +
      '       Install it with:  bun add -g geckodriver\n' +
      '       (kept out of devDependencies on purpose — it downloads a binary at install time)'
    )
  }

  driver = spawn('geckodriver', ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
  driver.stderr.on('data', (d) => {
    const s = String(d)
    if (/error|fatal/i.test(s)) process.stderr.write(`[geckodriver] ${s}`)
  })
  await waitForDriver()

  const args = HEADED ? [] : ['-headless']
  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': { binary: FIREFOX_BIN, args }
      }
    }
  }
  const session = await wd('POST', '/session', caps)
  sessionId = session.sessionId
  const v = session.capabilities?.browserVersion ?? 'unknown'
  console.log(`[smoke] Firefox ${v}, session ${sessionId}`)

  const addonId = await wd('POST', `/session/${sessionId}/moz/addon/install`, {
    path: SOURCE_DIR,
    temporary: true
  })
  console.log(`[smoke] installed add-on: ${addonId}`)

  // The event page initialises the WASM engine and fetches trust lists on
  // startup; give it a beat before the page starts asking it for verdicts.
  await sleep(3000)

  await wd('POST', `/session/${sessionId}/url`, { url: URL_UNDER_TEST })

  /*
   * Badge COUNT is a weak signal. CrIcon is created with a default 'img' status
   * before validation runs and only changes once a verdict lands, so eight
   * badges can mean "eight verdicts" or "eight placeholders and a dead engine".
   * Status is not exposed as an attribute — it is baked into the icon's SVG data
   * URL — so distinct verdicts show up as distinct srcs. The demo corpus spans
   * valid / warning / error / no-credentials on purpose, so a healthy run has
   * several. One distinct src across the whole corpus means nothing validated.
   */
  const probe = `
    const badges = Array.from(document.querySelectorAll(${JSON.stringify(BADGE_SELECTOR)}));
    const srcs = badges.map(b => b.style.backgroundImage || '');
    return {
      images: document.querySelectorAll('img').length,
      badges: badges.length,
      titles: badges.map(b => b.title || '').filter(Boolean).slice(0, 12),
      distinctIcons: Array.from(new Set(srcs.filter(Boolean))).length
    };
  `

  /*
   * Wait for VERDICTS, not badges.
   *
   * CrIcon is appended with a placeholder 'img' status the moment an image
   * enters the viewport, long before the engine has said anything about it, so
   * `badges >= MIN_BADGES` goes true almost immediately and says nothing about
   * whether validation ran. Breaking on it and clicking straight away races the
   * engine: mediaRecord.state.c2pa is still unset, inject.ts's click handler
   * takes its silent else branch, and the overlay never opens — which reads
   * exactly like a broken messaging path.
   *
   * The demo corpus spans several verdict types, so >1 distinct icon means real
   * results have landed. Badge count remains the floor for the final assertion;
   * this only decides when it is fair to click.
   */
  let last = { images: 0, badges: 0, titles: [], distinctIcons: 0 }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    last = await wd('POST', `/session/${sessionId}/execute/sync`, { script: probe, args: [] })
    if (last.badges >= MIN_BADGES && last.distinctIcons > 1) break
    await sleep(1000)
  }

  console.log(`\n[smoke] images on page : ${last.images}`)
  console.log(`[smoke] badges rendered: ${last.badges}`)
  console.log(`[smoke] distinct verdict icons: ${last.distinctIcons} (1 means nothing validated — all placeholders)`)
  for (const t of last.titles) console.log(`         - ${t}`)

  /*
   * --click: does clicking a badge actually open the overlay?
   *
   * Worth probing separately because it exercises a path lint cannot see and
   * that Chrome and Firefox implement differently. The overlay UI lives in
   * iframe.html, an extension page embedded as an iframe in the tab, and the
   * click is delivered by runtime.sendMessage fanning out to extension
   * contexts. Badges rendering proves the engine works; it says nothing about
   * whether that fan-out reaches an embedded extension page in Gecko.
   */
  if (CLICK_PROBE) {
    console.log('\n[smoke] --- click probe ---')
    const before = await wd('POST', `/session/${sessionId}/execute/sync`, {
      script: `
        const frames = Array.from(document.querySelectorAll('iframe'));
        return {
          iframes: frames.length,
          extFrames: frames.filter(f => (f.src||'').startsWith('moz-extension://')).map(f => ({
            src: (f.src||'').slice(-24),
            display: getComputedStyle(f).display,
            visibility: getComputedStyle(f).visibility,
            w: f.getBoundingClientRect().width,
            h: f.getBoundingClientRect().height
          }))
        };`,
      args: []
    })
    console.log(`[smoke] before click: ${before.iframes} iframe(s), ${before.extFrames.length} extension iframe(s)`)
    for (const f of before.extFrames) console.log(`         ${JSON.stringify(f)}`)

    const clicked = await wd('POST', `/session/${sessionId}/execute/sync`, {
      script: `
        const b = document.querySelector('[c2pa-icon]');
        if (!b) return { clicked: false, reason: 'no badge found' };
        b.click();
        return { clicked: true, hasOnclick: typeof b.onclick === 'function' };`,
      args: []
    })
    console.log(`[smoke] click dispatched: ${JSON.stringify(clicked)}`)

    await sleep(3000)

    const after = await wd('POST', `/session/${sessionId}/execute/sync`, {
      script: `
        const frames = Array.from(document.querySelectorAll('iframe'));
        const ext = frames.filter(f => (f.src||'').startsWith('moz-extension://'));
        return {
          iframes: frames.length,
          extFrames: ext.map(f => ({
            display: getComputedStyle(f).display,
            visibility: getComputedStyle(f).visibility,
            w: Math.round(f.getBoundingClientRect().width),
            h: Math.round(f.getBoundingClientRect().height)
          })),
          toasts: document.querySelectorAll('[c2pa-toast]').length
        };`,
      args: []
    })
    console.log(`[smoke] after click : ${after.iframes} iframe(s), ${after.extFrames.length} extension iframe(s), ${after.toasts} toast(s)`)
    for (const f of after.extFrames) console.log(`         ${JSON.stringify(f)}`)

    /*
     * Step into the extension iframe and read the relay state it publishes on
     * <html data-vd-relay> (#149).
     *
     * Without this, a failure here says only "the overlay did not open", which
     * is the same symptom for a dead messaging path, a frame that never loaded,
     * and a background that could not resolve a tab to route to. The relay
     * state tells them apart:
     *
     *   ready:<tabId>  background registered us and can route     -> look elsewhere
     *   unroutable     port connected, background resolved no tab -> routing bug
     *   connected      port opened, background never acknowledged -> onConnect bug
     *   disconnected   background went away, not yet reconnected
     *   no-context     extension context is dead
     *   (absent)       overlayFrame.js never ran in this frame
     */
    let relayState = '(unreadable)'
    let engineResult = '(not probed)'
    try {
      const frames = await wd('POST', `/session/${sessionId}/elements`, {
        using: 'css selector', value: 'iframe[src^="moz-extension://"]'
      })
      if (frames.length > 0) {
        await wd('POST', `/session/${sessionId}/frame`, { id: frames[0] })
        relayState = await wd('POST', `/session/${sessionId}/execute/sync`, {
          script: `return (document.documentElement.dataset.vdRelay || "(absent)")
                        + " | payload=" + (document.documentElement.dataset.vdOverlay || "(never arrived)");`,
          args: []
        })

        /*
         * Ask the background to validate a known-good corpus image and report
         * what comes back.
         *
         * This frame is an extension page, so it has chrome.runtime and can
         * exercise the engine end to end. Everything outside the extension only
         * sees the *effect* of validation (an icon changing), which is why a
         * dead engine reads as "badges rendered, click does nothing" instead of
         * as an error. This asks the engine directly and returns its own words.
         */
        await wd('POST', `/session/${sessionId}/timeouts`, { script: 30000 })
        engineResult = await wd('POST', `/session/${sessionId}/execute/async`, {
          script: `
            const url = arguments[0], done = arguments[arguments.length - 1];
            try {
              chrome.runtime.sendMessage({ action: 'MSG_VALIDATE_URL', data: url })
                .then(r => done(JSON.stringify({
                  got: r === undefined ? 'undefined' : typeof r,
                  hasManifestStore: !!(r && r.manifestStore),
                  message: r && r.message ? String(r.message) : null,
                  keys: r && typeof r === 'object' ? Object.keys(r).slice(0, 10) : null
                })))
                .catch(e => done(JSON.stringify({ threw: String((e && e.message) || e) })));
            } catch (e) { done(JSON.stringify({ syncThrew: String((e && e.message) || e) })); }
          `,
          args: [`${URL_UNDER_TEST.replace(/\/$/, '')}/01-greentrust-jpeg.jpg`]
        })
        await wd('POST', `/session/${sessionId}/frame/parent`, {})
      } else {
        relayState = '(no extension iframe found)'
      }
    } catch (err) {
      relayState = `(probe failed: ${err.message})`
    }
    console.log(`[smoke] relay state : ${relayState}`)
    console.log(`[smoke] engine probe: ${engineResult}`)

    const overlayVisible = after.extFrames.some(
      (f) => f.display !== 'none' && f.visibility !== 'hidden' && f.w > 0 && f.h > 0
    )
    console.log(`[smoke] OVERLAY VISIBLE: ${overlayVisible ? 'YES' : 'NO'}`)
    if (!overlayVisible) {
      console.error('\nFAIL: badge click did not open a visible overlay.')
      console.error(`Relay state was "${relayState}" — see the table in this script for what that means.`)
      return 1
    }
  }

  if (last.badges < MIN_BADGES) {
    console.error(`\nFAIL: expected >= ${MIN_BADGES} badges, got ${last.badges}.`)
    console.error('The add-on installed but produced no verdicts — the C2PA engine')
    console.error('likely failed to initialise in the Firefox event page.')
    return 1
  }
  console.log(`\nPASS: ${last.badges} verdict badges rendered in Firefox ${v}.`)
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  console.error(`\nFAIL: ${err.message}`)
  process.exitCode = 1
} finally {
  try { if (sessionId) await wd('DELETE', `/session/${sessionId}`) } catch { /* best effort */ }
  driver?.kill()
}
