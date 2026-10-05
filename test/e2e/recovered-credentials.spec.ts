import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * Recovering the credentials of a stripped image (#184), in a real browser,
 * against the real registry. The fixture is a picture whose Content Credentials
 * were removed; a credential for it is registered at manifests.sanmarcsoft.com.
 *
 * Reported by M on 2026-10-05 against 1.4.1: Verify recovered it but clicking the
 * badge showed only the short note, and a second Verify after a reload found
 * nothing. This spec reproduces that flow and prints what the extension did.
 */

const EXT_PATH = path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const PAGE_URL = 'http://localhost:3000/durable/index.html'
const IMG_URL = 'http://localhost:3000/durable/durable-test-stripped.jpg'

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-e2e-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-dev-shm-usage']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

/** What right-click, "Verify with Verifieddit" does: fire the menu's click in the service worker. */
async function verifyViaContextMenu (ctx: BrowserContext): Promise<string> {
  const sw = ctx.serviceWorkers()[0]
  return await sw.evaluate(async (srcUrl) => {
    // Headless Chrome has no "last focused window", so find the tab by its address.
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((t) => (t.url ?? '').includes('/durable/'))
    const events = chrome.contextMenus.onClicked as unknown as { dispatch?: (info: unknown, tab: unknown) => void }
    if (tab == null) return `no tab among ${tabs.length}`
    if (typeof events.dispatch !== 'function') return 'no dispatch on contextMenus.onClicked'
    events.dispatch({ menuItemId: 'verify', srcUrl, frameId: 0, mediaType: 'image', editable: false, pageUrl: tab.url }, tab)
    return `dispatched to tab ${String(tab.id)}`
  }, IMG_URL)
}

async function badge (page: Page): Promise<{ found: boolean, title: string | null }> {
  return await page.evaluate(() => {
    const icon = document.querySelector('div[c2pa-icon]') as HTMLElement | null
    return { found: icon != null, title: icon?.title ?? null }
  })
}

async function clickBadgeAndDescribe (page: Page): Promise<{ overlay: boolean, toast: string | null }> {
  await page.evaluate(() => { (document.querySelector('div[c2pa-icon]') as HTMLElement | null)?.click() })
  await page.waitForTimeout(4_000)
  return await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
    const toast = document.querySelector('[c2pa-toast]') as HTMLElement | null
    return { overlay: dialog != null && dialog.style.visibility === 'visible', toast: toast?.innerText ?? null }
  })
}

test.describe('recovering a stripped image', () => {
  // FIXME(#184): in headless CI the dispatched menu click reaches the service worker
  // ("dispatched to tab N") but no badge of any kind appears, so this test cannot yet
  // tell a working build from a broken one. Kept as the written-down flow; not a gate
  // until the trigger is understood. The fault it was written for was found another
  // way: the registry returns the whole signed file labelled application/c2pa.
  test.fixme('Verify recovers the credential, the badge opens the full panel, and it works again after a reload', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      await page.waitForTimeout(2_000)
      const sw = ctx.serviceWorkers()[0]
      expect(sw, 'extension service worker must register').toBeTruthy()
      await sw.evaluate(async () => { await chrome.storage.local.set({ manifestStoreProbe: true }) })

      const round = async (label: string): Promise<{ title: string | null, overlay: boolean, toast: string | null }> => {
        await page.goto(PAGE_URL, { waitUntil: 'load' })
        await page.bringToFront()
        await page.waitForTimeout(2_000)
        console.log(`[recovered ${label}] trigger: ${await verifyViaContextMenu(ctx)}`)
        await page.waitForFunction(() => document.querySelector('div[c2pa-icon]') != null, { timeout: 45_000 }).catch(() => {})
        await page.waitForTimeout(2_000)
        const b = await badge(page)
        const after = await clickBadgeAndDescribe(page)
        console.log(`[recovered ${label}] badge=${JSON.stringify(b)} click=${JSON.stringify(after)}`)
        return { title: b.title, ...after }
      }

      const first = await round('first')
      const second = await round('after reload')

      for (const [label, r] of [['first', first], ['after reload', second]] as const) {
        expect(r.title, `${label}: the badge must say the label was removed and a copy found`).toContain('Label removed, copy found')
        expect(r.toast, `${label}: the short note must not replace the panel`).toBeNull()
        expect(r.overlay, `${label}: clicking the badge must open the full panel`).toBe(true)
      }
    } finally {
      await ctx.close()
    }
  })
})
