import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * A hostile page must not be able to take over the panel's channel (Forge F3).
 *
 * The panel is an extension page, iframe.html, that any page can also frame for
 * itself. The background used to route a tab's verification result to whichever
 * such frame connected last. So a page that framed iframe.html after ours had
 * loaded received the result, and the real panel never opened.
 *
 * This spec plays that page: it frames iframe.html itself, then the reader
 * clicks a badge. The real panel must open with the result, and the page's own
 * frame must receive nothing.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const PAGE_URL = 'http://localhost:3000/multi-ingredient/'

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-hijack-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1500, height: 1700 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

/** The relay state each panel frame reports on its <html> element, real and hostile alike. */
async function relayStates (page: Page): Promise<{ real: string | null, hostile: string | null }> {
  const out: { real: string | null, hostile: string | null } = { real: null, hostile: null }
  for (const frame of page.frames()) {
    if (!frame.url().endsWith('/iframe.html')) continue
    const element = await frame.frameElement()
    const hostile = await element.evaluate((el) => el.id === 'hostile-frame')
    const state = await frame.evaluate(() => document.documentElement.dataset.vdOverlay ?? 'no-state').catch((e: Error) => `unreadable: ${e.message.slice(0, 80)}`)
    if (hostile) out.hostile = state; else out.real = state
  }
  return out
}

test('a page that frames the panel itself cannot take the verification result', async () => {
  test.setTimeout(120_000)
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    const extensionId = new URL(sw.url()).host
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })

    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await expect.poll(async () => await page.evaluate(() => document.querySelectorAll('div[c2pa-icon]').length), { timeout: 45_000 }).toBe(3)

    // The page frames the panel for itself, after the real one has connected.
    await page.evaluate(async (id) => {
      const frame = document.createElement('iframe')
      frame.id = 'hostile-frame'
      frame.src = `chrome-extension://${id}/iframe.html`
      frame.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;opacity:0.01'
      document.body.appendChild(frame)
      await new Promise((resolve) => { frame.onload = resolve })
    }, extensionId)
    await page.waitForTimeout(1_500)

    // The reader clicks the first badge.
    await page.evaluate(() => { (document.querySelector('div[c2pa-icon]') as HTMLElement).click() })

    // The real panel opens.
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('iframe')].find((f) => f.className === 'c2paDialog')
      return d != null && d.style.visibility === 'visible'
    }, { timeout: 10_000 })

    const states = await relayStates(page)
    console.log('[hijack] relay states:', JSON.stringify(states))
    expect(states.real, 'the real panel must have been given the result').toMatch(/^applied@/)
    expect(states.hostile ?? '', 'the page\'s own frame must be given nothing').not.toMatch(/^(applied|buffered)/)
  } finally {
    await ctx.close()
  }
})
