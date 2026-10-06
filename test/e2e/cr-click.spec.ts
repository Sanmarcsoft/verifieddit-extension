import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Regression gate for the CR-overlay click path (issue #65).
 *
 * The bug sequence this spec protects against:
 *  1. CrIcon.onClick used addEventListener — content-script-isolated-world
 *     listeners sometimes fail to fire on user click (verified rc9 & rc10,
 *     see CDP DOMDebugger.getEventListeners → []).
 *  2. Click handler routed MSG_OPEN_OVERLAY through MSG_FORWARD_TO_CONTENT,
 *     which is relayed via chrome.tabs.sendMessage (content scripts only);
 *     the overlay iframe is an extension-page, not a content script, so it
 *     never heard the message.
 *  3. public/iframe.html no longer contained <c2pa-overlay></c2pa-overlay>
 *     after the May-2025 rename commit, so overlayFrame's querySelector
 *     returned null and the overlay could not be populated.
 *
 * This spec loads the built dist/chrome directory (NOT the stale repo copy),
 * navigates to the deployed demo (or a local equivalent), clicks the CR icon
 * on the real-world CBC fixture, and asserts:
 *  - the icon's `onclick` property is a function (IDL handler attached)
 *  - the c2paDialog iframe lands topmost, in-viewport, at a real size
 *  - the c2paDialog iframe visibility transitions to `visible` within 2 s
 *  - the <c2pa-overlay> shadow DOM contains the expected signer text
 */

const EXT_PATH = path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const DEMO_URL = process.env.DEMO_URL ?? 'https://www.verifieddit.com/demo'
const CBC_FIXTURE_URL_FRAGMENT = '07-edge-realworld-cbc-signed'

async function launchWithExtension (): Promise<{ ctx: BrowserContext, page: Page, consoleLogs: string[] }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-e2e-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  })
  const consoleLogs: string[] = []
  const page = ctx.pages()[0] ?? await ctx.newPage()
  page.on('console', (msg) => { consoleLogs.push(msg.text()) })
  for (const sw of ctx.serviceWorkers()) sw.on('console', (msg) => { consoleLogs.push(`[SW] ${msg.text()}`) })
  ctx.on('serviceworker', (sw) => sw.on('console', (msg) => { consoleLogs.push(`[SW] ${msg.text()}`) }))
  return { ctx, page, consoleLogs }
}

test.describe('CR overlay click (issue #65)', () => {
  test('clicking the CR icon on the CBC fixture opens the overlay panel', async () => {
    test.setTimeout(120_000)
    expect(fs.existsSync(EXT_PATH), `dist/chrome must exist at ${EXT_PATH}`).toBe(true)
    expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json'))).toBe(true)

    const { ctx, page, consoleLogs } = await launchWithExtension()
    try {
      // Give the SW a moment to register before we navigate
      await page.waitForTimeout(2_000)

      // rc11.7 / #86 — fresh installs now default to auto-scan OFF. This
      // spec exercises the auto-scan pipeline end-to-end, so enable it
      // explicitly before navigating. A separate spec
      // (test/e2e/auto-scan-default-off.spec.ts) asserts the default-OFF
      // behaviour on a pristine profile.
      const extSw = ctx.serviceWorkers()[0]
      if (extSw != null) {
        await extSw.evaluate(() => {
          return chrome.storage.local.set({ autoScan: true })
        })
      }

      await page.goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 60_000 })

      // Let inject.ts scan the page and for the SW to validate each image
      await page.waitForTimeout(6_000)

      // Scroll the CBC fixture into view
      await page.evaluate((fragment) => {
        const img = [...document.querySelectorAll('img')]
          .find(i => (i.currentSrc || i.src).includes(fragment))
        img?.scrollIntoView({ block: 'center' })
      }, CBC_FIXTURE_URL_FRAGMENT)
      await page.waitForTimeout(4_000)

      // Assert the CR icon exists, is near the image, and has an IDL onclick
      const pre = await page.evaluate((fragment) => {
        const imgs = [...document.querySelectorAll('img')]
        const cbc = imgs.find(i => (i.currentSrc || i.src).includes(fragment))
        if (cbc == null) return { found: false }
        const imgR = cbc.getBoundingClientRect()
        const icons = [...document.querySelectorAll('div[c2pa-icon]')]
        const near = icons.find((icon) => {
          const ir = icon.getBoundingClientRect()
          return Math.abs(ir.top - imgR.top) < 200 && Math.abs(ir.right - imgR.right) < 200
        })
        return {
          found: near != null,
          iconCount: icons.length,
          onclickType: near != null ? typeof (near as HTMLElement & { onclick: unknown }).onclick : 'none',
          iconTitle: near != null ? (near as HTMLElement).title : null
        }
      }, CBC_FIXTURE_URL_FRAGMENT)

      expect(pre.found, 'CR icon must exist near CBC fixture').toBe(true)
      // Cross-world view of el.onclick can come back as either 'function' or
      // 'object' depending on how Playwright bridges the content-script
      // isolated world back to the page world. Both are acceptable; we just
      // need it to be *not* the absent values ('none' / 'null' / 'undefined').
      expect(
        ['function', 'object'].includes(pre.onclickType ?? 'none'),
        `icon.onclick must be set (IDL handler, not addEventListener); got ${String(pre.onclickType)}`
      ).toBe(true)
      expect(pre.iconTitle).toContain(CBC_FIXTURE_URL_FRAGMENT)

      // Click via IDL — click() — exercises the onclick property directly
      await page.evaluate((fragment) => {
        const imgs = [...document.querySelectorAll('img')]
        const cbc = imgs.find(i => (i.currentSrc || i.src).includes(fragment))
        const imgR = cbc!.getBoundingClientRect()
        const icons = [...document.querySelectorAll('div[c2pa-icon]')]
        const near = icons.find((icon) => {
          const ir = icon.getBoundingClientRect()
          return Math.abs(ir.top - imgR.top) < 200 && Math.abs(ir.right - imgR.right) < 200
        })
          ; (near as HTMLElement).click()
      }, CBC_FIXTURE_URL_FRAGMENT)

      // Wait for overlay iframe to become visible (ResizeObserver + MSG_DISPLAY_C2PA_OVERLAY roundtrip)
      // The options are the THIRD argument. They used to be passed second, as
      // the page function's argument, so the 5 s limit never applied and a panel
      // that did not open hung the test until its own two-minute limit.
      await page.waitForFunction(() => {
        const d = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
        return d != null && d.style.visibility === 'visible'
      }, undefined, { timeout: 8_000 }).catch(async (error: Error) => {
        // Say what the panel frame knew, so a failure here explains itself.
        const states = await Promise.all(page.frames().filter((f) => f.url().endsWith('/iframe.html'))
          .map(async (f) => await f.evaluate(() => `relay=${document.documentElement.dataset.vdRelay ?? ''} overlay=${document.documentElement.dataset.vdOverlay ?? ''}`).catch(() => 'unreadable')))
        throw new Error(`the panel did not open after the click; panel frame state: ${JSON.stringify(states)}; ${error.message}`)
      })

      // Give the iframe a moment to populate via MSG_DISPLAY_C2PA_OVERLAY
      await page.waitForTimeout(2_000)

      // rc11.2 / #70 — the iframe must actually be visually visible, not a
      // 302×2 transparent slit hidden behind the page content. Assert:
      //   1. elementsFromPoint(centre) returns the iframe as top-of-stack.
      //   2. the iframe has non-trivial width AND height (≥ 180×120 px).
      //   3. the iframe rect overlaps the current viewport.
      const stacking = await page.evaluate(() => {
        const d = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
        if (d == null) return null
        const r = d.getBoundingClientRect()
        const cx = r.x + r.width / 2
        const cy = r.y + r.height / 2
        const top = document.elementsFromPoint(cx, cy)[0]
        return {
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          topIsIframe: top === d,
          topTag: top?.tagName,
          topCls: (top as HTMLElement | null)?.className?.toString().slice(0, 80),
          inViewport: r.width > 0 && r.height > 0 &&
            r.right > 0 && r.bottom > 0 &&
            r.left < window.innerWidth && r.top < window.innerHeight
        }
      })
      expect(stacking, 'overlay iframe must exist for stacking check').not.toBeNull()
      expect(stacking!.inViewport, `overlay iframe must land inside the viewport; got rect ${JSON.stringify(stacking!.rect)}`).toBe(true)
      expect(stacking!.rect.w, 'overlay width must be ≥ 180 px').toBeGreaterThanOrEqual(180)
      expect(stacking!.rect.h, `overlay height must be ≥ 120 px; got ${stacking!.rect.h} — probably <c2pa-overlay> host had display:inline or iframe had no min-height`).toBeGreaterThanOrEqual(120)
      expect(stacking!.topIsIframe, `overlay iframe must be topmost at its centre; got ${stacking!.topTag}.${stacking!.topCls} — probably a page element has a higher z-index or the overlay is transparent`).toBe(true)

      // The click path is already proven above by observable state: the icon
      // carried an IDL onclick, the dialog iframe went visible, and it landed
      // topmost at a real size. Asserting on `CrIcon onclick fired` /
      // `overlayFrame: MSG_OPEN_OVERLAY received` console strings instead made
      // this spec fail whenever a cleanup pass stripped a console.log, which is
      // exactly what happened — the markers no longer exist anywhere in src/.
      // Test the behaviour, not the instrumentation.

      // Read the overlay iframe's shadow DOM content (same-world via Playwright's frame access)
      const iframeFrame = page.frames().find(f => f.url().includes('iframe.html'))
      expect(iframeFrame, 'overlay iframe must be present in page frames').toBeTruthy()

      const panel = await iframeFrame!.evaluate(() => {
        const overlay = document.querySelector('c2pa-overlay') as unknown as { shadowRoot: ShadowRoot | null, c2paResult?: unknown, signer?: string, trustList?: string }
        return {
          hasOverlay: overlay != null,
          hasShadow: overlay?.shadowRoot != null,
          shadowText: (overlay?.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          signer: overlay?.signer ?? null,
          trustList: overlay?.trustList ?? null
        }
      })

      expect(panel.hasOverlay, '<c2pa-overlay> must exist in iframe body').toBe(true)
      expect(panel.hasShadow, '<c2pa-overlay>.shadowRoot must be populated').toBe(true)
      expect(panel.signer, 'signer must be parsed from the CBC manifest').toBe('CBC/Radio-Canada')
      // #160 bundled the CAI known-certificate anchors, so the CBC signer now
      // chains to a root the extension ships and reads as trusted. This pair
      // asserted 'unknown' from 2026-04-24, which was correct only while those
      // anchors were absent. The suite runs on pull_request only, so #160
      // merged without ever exercising it and the staleness surfaced here.
      // Assert the list the signer actually matches: a real regression would
      // read 'unknown' again, or name a different list.
      expect(panel.trustList, 'CBC chains to a CAI known-certificate root (#160)').toBe('CAI Known Certificates')
      expect(panel.shadowText, 'overlay must show the signer').toContain('CBC/Radio-Canada')
      expect(panel.shadowText, 'overlay must name the trust list that matched').toMatch(/CAI Known Certificates/i)

      // rc11.3 / #74 — the overlay's "For more details" inspection copy must
      // point at Verifieddit, not the upstream Microsoft Content Integrity
      // page. Assert both the user-visible text and the absence of the old
      // microsoft.com host in any link-bearing attribute of the shadow tree.
      const linkAudit = await iframeFrame!.evaluate(() => {
        const overlay = document.querySelector('c2pa-overlay') as unknown as { shadowRoot: ShadowRoot | null }
        const root = overlay?.shadowRoot
        const text = (root?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const allEls = root != null ? Array.from(root.querySelectorAll('*')) : []
        const hasMicrosoftHost = allEls.some((el) => {
          for (const a of el.getAttributeNames()) {
            const v = el.getAttribute(a) ?? ''
            if (v.includes('contentintegrity.microsoft.com')) return true
          }
          return false
        }) || text.includes('contentintegrity.microsoft.com')
        return { text, hasMicrosoftHost }
      })
      expect(linkAudit.text, 'overlay must not mention "Microsoft Content Integrity"').not.toMatch(/microsoft content integrity/i)
      expect(linkAudit.text, 'overlay must offer a Verifieddit details page').toMatch(/verifieddit/i)
      expect(linkAudit.hasMicrosoftHost, 'no attribute or text may reference contentintegrity.microsoft.com').toBe(false)

      // The ingredient-diagram assertions that used to live here targeted
      // `.ingredient-diagram svg` and a collapsible headed "Ingredients". Both
      // are gone: src/ingredientDiagram.ts was deleted and the section is now
      // "Provenance chain", rendering <c2pa-provenance-graph>. That surface is
      // covered properly by test/e2e/provenance-graph.spec.ts, which asserts
      // the component painted one .node card per graph node — the check that
      // would have caught the tree-shaking bug (#140) this spec could not see.

      // rc11.7 / #86 — auto-scan must be OFF on a fresh install so users
      // don't see CR icons on every page without asking. The only reason
      // icons appear in this test is that we explicitly clicked the CBC
      // badge earlier; they got auto-rendered during the earlier rc11 /
      // rc11.1 test-setup. For the dedicated no-auto-scan assertion, a
      // second test spins up a fresh context with zero prior interaction
      // and asserts zero icons — that lives in test/e2e/auto-scan.spec.ts
      // (not added here to keep the cr-click spec focused).

      // rc11.4 / #76 — the overlay must be space-efficient. With all four
      // collapsible sections closed, the panel height must be below an
      // "all-closed ceiling" (< 400 px). In rc11.2 the sections each carried
      // a 160 px min-height because the rc11.2 #70 fix applied min-sizing to
      // sharedStyles, which bled into <c2pa-collapsible>. Panel height was
      // ~800 px with every section closed, leaving vast empty space.
      const closedHeight = await page.evaluate(() => {
        const d = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
        return d?.getBoundingClientRect().height ?? 0
      })
      // Budget raised 400 -> 640 for #110: the collapsed panel now carries the
      // Durable Content Credentials block (three pillars plus a self-assertion
      // warning) above the collapsibles. Raised again 640 -> 1100 for #141: the
      // provenance graph moved out of the collapsibles into the panel body, so
      // its frame is part of the closed height by design. Both are the feature,
      // not bloat. The ceiling is kept so the panel cannot creep unnoticed.
      expect(closedHeight, `overlay height with all collapsibles closed must be < 1100 px; got ${closedHeight}`).toBeLessThan(1100)
      expect(closedHeight, `overlay height must be ≥ 120 px (still usable); got ${closedHeight}`).toBeGreaterThanOrEqual(120)
    } finally {
      await ctx.close()
    }
  })
})
