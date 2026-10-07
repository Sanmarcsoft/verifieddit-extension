import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Auto-scan must badge an image that was still loading when it came into view.
 *
 * Found on 2026-10-07 in real Chrome with the published 1.4.2 (#204): the
 * public self-test page showed no badges at all, while the same photographs
 * served from localhost got one each. An image that has not picked a source
 * yet reports an empty `currentSrc`; the first-sight handler skipped it, and
 * because it was already in view nothing ever looked at it again. Every other
 * spec loads its fixtures from localhost, where an image is complete before
 * the handler runs, so none of them could see this.
 *
 * This spec holds the image back for two and a half seconds, which is what a
 * real network does, and expects the badge anyway.
 */

const EXT_PATH = path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const ORIGIN = 'http://localhost:3000'
const IMAGE = '/demo-corpus/01-greentrust-jpeg.jpg'
const PAGE = '/slow-image-page'

async function launchWithExtension (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-e2e-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1200, height: 800 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  return { ctx, page }
}

async function openPage (page: Page, delayMs: number): Promise<void> {
  await page.route(`${ORIGIN}${PAGE}`, async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><title>slow image</title><body style="margin:40px"><img id="pic" src="${IMAGE}" width="400" height="533"></body>`
    })
  })
  await page.route(`${ORIGIN}${IMAGE}`, async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.continue()
  })
  await page.goto(`${ORIGIN}${PAGE}`, { waitUntil: 'domcontentloaded' })
}

const badgeCount = async (page: Page): Promise<number> =>
  await page.evaluate(() => document.querySelectorAll('.c2pa-icon-container').length)

test.describe('auto-scan and slow images (#204)', () => {
  test.setTimeout(90_000)
  let ctx: BrowserContext
  let page: Page

  test.beforeEach(async () => {
    ({ ctx, page } = await launchWithExtension())
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
    // The extension writes its own default for autoScan when it is installed.
    // Setting it before that write lands loses the race about one run in four,
    // and the page script then never scans. Wait for the default, then set it.
    await sw.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const stored = await chrome.storage.local.get('autoScan')
        if (stored.autoScan !== undefined) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await chrome.storage.local.set({ autoScan: true })
    })
  })

  test.afterEach(async () => { await ctx.close() })

  test('control: an image that loads at once gets its badge', async () => {
    await openPage(page, 0)
    await expect.poll(async () => await badgeCount(page), { timeout: 30_000 }).toBe(1)
  })

  test('an image still loading when it comes into view gets its badge once it has loaded', async () => {
    await openPage(page, 2500)
    // Still loading: in view, sized by its attributes, no source picked yet.
    expect(await page.evaluate(() => (document.getElementById('pic') as HTMLImageElement).complete)).toBe(false)
    await expect.poll(async () => await badgeCount(page), { timeout: 30_000 }).toBe(1)
  })
})
