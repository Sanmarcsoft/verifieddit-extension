import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Icon-only badges (#184) must change badges that are already on the page.
 *
 * The unit tests pin the drawing. What they cannot see is the wiring: the
 * content script has to hear the switch through chrome.storage and redraw each
 * badge it has already placed, without a reload. That only happens in a loaded
 * extension, so this reads the badge's real background before and after.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const DEMO_URL = process.env.DEMO_URL ?? 'http://localhost:3000/demo-corpus/'

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-icononly-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 1800 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

/** The decoded badge drawings currently on the page. */
async function badges (page: Page): Promise<string[]> {
  return await page.evaluate(() => [...document.querySelectorAll('div[c2pa-icon]')]
    .map((el) => decodeURIComponent((el as HTMLElement).style.backgroundImage))
    .filter((art) => art.includes('data-part="pin"')))
}

test('the icon-only switch redraws badges already on the page, and back again', async () => {
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true, iconOnlyBadges: false }) })

    await page.goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await expect.poll(async () => (await badges(page)).length, { timeout: 45_000 }).toBeGreaterThan(0)
    const coloured = await badges(page)
    expect(coloured.every((art) => !art.includes('data-verdict='))).toBe(true)
    expect(coloured.some((art) => art.includes('data-part="cr"'))).toBe(true)

    await sw.evaluate(async () => { await chrome.storage.local.set({ iconOnlyBadges: true }) })
    await expect.poll(async () => (await badges(page)).every((art) => !art.includes('data-part="cr"')), { timeout: 10_000 }).toBe(true)
    const plain = await badges(page)
    // The page may still be scanning, so more badges can appear; none may vanish.
    expect(plain.length).toBeGreaterThanOrEqual(coloured.length)
    expect(plain.some((art) => art.includes('data-verdict='))).toBe(true)
    // Black and white only: no fill or stroke other than #FFFFFF, #000000 or none.
    for (const art of plain) {
      const paints = [...art.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1])
      expect(paints.every((p) => p === '#FFFFFF' || p === '#000000' || p === 'none')).toBe(true)
    }
    await page.screenshot({ path: 'test/e2e/results/icon-only-on.png' })

    await sw.evaluate(async () => { await chrome.storage.local.set({ iconOnlyBadges: false }) })
    await expect.poll(async () => (await badges(page)).some((art) => art.includes('data-part="cr"')), { timeout: 10_000 }).toBe(true)
  } finally {
    await ctx.close()
  }
})
