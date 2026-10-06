import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * A composite with two credentialed sources must be read and drawn (#184).
 *
 * test/provenanceGraph.test.ts pins the graph built from the fixture's store.
 * This proves the same thing end to end: the engine in the loaded extension
 * reads the real file, each image gets its own badge, and the panel names the
 * source that was edited and the source that was added.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const PAGE_URL = process.env.MULTI_URL ?? 'http://localhost:3000/multi-ingredient/'

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-multi-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1500, height: 1700 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

test('a composite shows its edited source and its added source in the panel', async () => {
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })

    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    // One badge per image: the composite and each of its two sources.
    await expect.poll(async () => await page.evaluate(() => document.querySelectorAll('div[c2pa-icon]').length), { timeout: 45_000 }).toBe(3)

    // All three are signed by Trusteddit and declared as generated artwork, so every
    // badge is the trusted AI badge: none reads "signer not known" or "changed".
    // Polled: a badge is a neutral placeholder until its file has been checked.
    const fills = async (): Promise<Array<string | undefined>> => await page.evaluate(() => [...document.querySelectorAll('div[c2pa-icon]')]
      .map((el) => (decodeURIComponent((el as HTMLElement).style.backgroundImage).match(/data-part="pin" fill="([^"]+)"/) ?? [])[1]))
    await expect.poll(fills, { timeout: 30_000 }).toEqual(['#A78BFA', '#A78BFA', '#A78BFA'])

    // The composite is the first image on the page; its badge is the nearest one.
    await page.evaluate(() => {
      const r = document.getElementById('composite')!.getBoundingClientRect()
      const near = [...document.querySelectorAll('div[c2pa-icon]')].find((icon) => {
        const ir = icon.getBoundingClientRect()
        return Math.abs(ir.top - r.top) < 100 && Math.abs(ir.right - r.right) < 100
      })
      ;(near as HTMLElement).click()
    })
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
      return d != null && d.style.visibility === 'visible'
    }, { timeout: 10_000 })

    const frame = page.frames().find(f => f.url().includes('iframe.html'))
    expect(frame, 'overlay iframe must be present').toBeTruthy()
    const panelText = async (): Promise<string> => await frame!.evaluate(() => {
      const out: string[] = []
      const walk = (root: Document | ShadowRoot): void => {
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot != null) walk(el.shadowRoot)
        out.push(root.textContent ?? '')
      }
      walk(document)
      return out.join(' ')
    })
    await expect.poll(async () => (await panelText()).includes('b-added.jpg'), { timeout: 15_000 }).toBe(true)
    const text = await panelText()
    expect(text).toContain('a-base.jpg')
    expect(text).toContain('parentOf')
    expect(text).toContain('componentOf')
    await page.screenshot({ path: 'test/e2e/results/multi-ingredient-panel.png' })
  } finally {
    await ctx.close()
  }
})
