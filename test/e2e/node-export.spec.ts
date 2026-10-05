import { test, expect, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Copy and CSV export must actually work in a loaded extension.
 *
 * `exportActions.ts` and `provenanceCsv.ts` carry 21 unit tests between them,
 * but a unit test cannot see the two things that break these buttons in the
 * real product: the diagram's `onPointerDown` swallowing the click before it
 * reaches the control (#141), and `navigator.clipboard.writeText` refusing
 * without transient activation. Both are only observable through real input in
 * a real browser, so every click here goes through `page.mouse` rather than
 * `element.click()`, which would not grant activation.
 *
 * The user-visible claim under test is "v1.2.5 lacks the ability to copy their
 * text content or export their content as a csv file". Point EXT_PATH at a
 * v1.2.5 build and these fail because the controls do not exist at all.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const DEMO_URL = process.env.DEMO_URL ?? 'http://localhost:3000/demo-corpus/'
const FIXTURE = '07-edge-realworld-cbc-signed'

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-export-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 1800 },
    acceptDownloads: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  // Reading the clipboard back is the only way to prove the text really landed
  // there rather than the button merely flipping its own label.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

async function openOverlay (ctx: BrowserContext, page: Page): Promise<Frame> {
  await page.waitForTimeout(2_000)
  const sw = ctx.serviceWorkers()[0]
  if (sw != null) await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })

  await page.goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6_000)
  await page.evaluate((f) => {
    const img = [...document.querySelectorAll('img')].find(i => (i.currentSrc ?? i.src).includes(f))
    img?.scrollIntoView({ block: 'center' })
  }, FIXTURE)
  await page.waitForTimeout(3_000)
  await page.evaluate((f) => {
    const t = [...document.querySelectorAll('img')].find(i => (i.currentSrc ?? i.src).includes(f))
    const r = t!.getBoundingClientRect()
    const near = [...document.querySelectorAll('div[c2pa-icon]')].find((icon) => {
      const ir = icon.getBoundingClientRect()
      return Math.abs(ir.top - r.top) < 200 && Math.abs(ir.right - r.right) < 200
    })
    ;(near as HTMLElement).click()
  }, FIXTURE)
  await page.waitForFunction(() => {
    const d = [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')
    return d != null && d.style.visibility === 'visible'
  }, { timeout: 10_000 })
  await page.waitForTimeout(2_000)

  const frame = page.frames().find(f => f.url().includes('iframe.html'))
  expect(frame, 'overlay iframe must be present').toBeTruthy()
  return frame!
}

/** Runs `fn` against the provenance diagram's shadow root, inside the frame. */
async function inDiagram<T> (frame: Frame, fn: string, arg: string): Promise<T> {
  return await frame.evaluate(([body, a]) => {
    const g = document.querySelector('c2pa-overlay')?.shadowRoot
      ?.querySelector('c2pa-provenance-graph') as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null
    const root = g?.shadowRoot
    if (root == null) throw new Error('provenance graph shadow root not found')
    // eslint-disable-next-line no-new-func
    return new Function('root', 'arg', body)(root, a)
  }, [fn, arg]) as T
}

/** Frame-space rect of a control, found by aria-label inside the shadow root. */
async function rectOf (frame: Frame, label: string): Promise<{ x: number, y: number }> {
  const r = await inDiagram<{ x: number, y: number } | null>(frame, `
    const b = [...root.querySelectorAll('button')].find(e => (e.getAttribute('aria-label') || '') === arg)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  `, label)
  expect(r, `control with aria-label "${label}" must exist in the diagram`).toBeTruthy()
  return r!
}

/** Current visible label of a control, to read the "Copied" acknowledgement. */
async function textOf (frame: Frame, label: string): Promise<string> {
  return await inDiagram<string>(frame, `
    const b = [...root.querySelectorAll('button')].find(e => (e.getAttribute('aria-label') || '') === arg)
    return b ? (b.textContent || '').trim() : ''
  `, label)
}

/** Real mouse click on a diagram control, so the copy gets transient activation. */
async function clickControl (page: Page, frame: Frame, label: string): Promise<void> {
  const r = await rectOf(frame, label)
  const el = await frame.frameElement()
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(300)
  const bb = await el.boundingBox()
  expect(bb, 'overlay iframe must have a box').toBeTruthy()

  const point = { x: bb!.x + r.x, y: bb!.y + r.y }
  const vp = page.viewportSize()!
  expect(point.y, `"${label}" is below the viewport (${point.y} vs ${vp.height})`).toBeLessThan(vp.height)
  const hit = await page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px as number, py as number) as HTMLElement | null
    return e == null ? 'null' : `${e.tagName}.${e.className}`
  }, [point.x, point.y])
  expect(hit, `click on "${label}" must land on the overlay iframe`).toContain('c2paDialog')

  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(500)
}

/** Reads the system clipboard back through the page. */
async function clipboard (page: Page): Promise<string> {
  return await page.evaluate(async () => await navigator.clipboard.readText())
}

/** Expands the first node and returns its label, for aria-label lookups. */
async function expandFirstNode (frame: Frame): Promise<string> {
  const label = await inDiagram<string>(frame, `
    const node = root.querySelector('.node[data-node-id]')
    if (!node) throw new Error('no .node rendered')
    const toggle = node.querySelector('button.toggle')
    if (!toggle) throw new Error('node has no toggle button')
    toggle.click()
    const h = node.querySelector('.node-title')
    return h ? (h.textContent || '').trim() : ''
  `, '')
  expect(label, 'expanded node must have a title to address its controls by').toBeTruthy()
  return label
}

test.describe('provenance copy and CSV export', () => {
  test('toolbar Copy puts the whole chain on the clipboard as CSV', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      const frame = await openOverlay(ctx, page)
      await clickControl(page, frame, 'Copy provenance chain as CSV')

      expect(await textOf(frame, 'Copy provenance chain as CSV'), 'button must acknowledge the copy').toBe('Copied')

      const text = await clipboard(page)
      const lines = text.trim().split('\n')
      expect(lines.length, `clipboard must hold a header plus at least one row, got: ${JSON.stringify(text.slice(0, 200))}`).toBeGreaterThan(1)
      expect(lines[0], 'first line must be a comma-separated header').toContain(',')
    } finally {
      await ctx.close()
    }
  })

  // The panel is a cross-origin iframe: without clipboard-write delegated to it,
  // Chrome refuses the Clipboard API and logs a permissions-policy violation in
  // the extension's error pane on every Copy, even though the fallback copies.
  test('Copy uses the Clipboard API without a permissions-policy violation', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      const violations: string[] = []
      const watch = (text: string): void => { if (/permissions policy violation/i.test(text) && /clipboard/i.test(text)) violations.push(text) }
      page.on('console', (msg) => { watch(msg.text()) })
      page.on('pageerror', (err) => { watch(String(err)) })

      const frame = await openOverlay(ctx, page)
      const allow = await page.evaluate(() => [...document.querySelectorAll('iframe')].find(f => f.className === 'c2paDialog')?.getAttribute('allow') ?? '')
      expect(allow, 'the panel iframe must be allowed to write to the clipboard').toContain('clipboard-write')
      expect(allow, 'and must keep its fullscreen permission').toContain('fullscreen')

      await clickControl(page, frame, 'Copy provenance chain as CSV')
      expect(await textOf(frame, 'Copy provenance chain as CSV')).toBe('Copied')
      await page.waitForTimeout(500)
      expect(violations, 'Copy must not log a clipboard permissions-policy violation').toEqual([])
    } finally {
      await ctx.close()
    }
  })

  test('toolbar CSV downloads a dated provenance file', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      const frame = await openOverlay(ctx, page)

      const pending = page.waitForEvent('download', { timeout: 20_000 })
      await clickControl(page, frame, 'Export provenance chain as CSV')
      const download = await pending

      expect(
        download.suggestedFilename(),
        'download must be named from the asset and dated, not a generic export.csv'
      ).toMatch(/-provenance-\d{4}-\d{2}-\d{2}\.csv$/)

      const body = fs.readFileSync(await download.path(), 'utf8')
      expect(body.trim().split('\n').length, 'downloaded CSV must have a header plus rows').toBeGreaterThan(1)
    } finally {
      await ctx.close()
    }
  })

  test('an expanded node copies its own text content', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      const frame = await openOverlay(ctx, page)
      const label = await expandFirstNode(frame)
      await page.waitForTimeout(600)

      await clickControl(page, frame, `Copy details for ${label}`)
      expect(await textOf(frame, `Copy details for ${label}`), 'node Copy must acknowledge').toBe('Copied')

      const text = await clipboard(page)
      expect(text.length, 'clipboard must not be empty').toBeGreaterThan(0)
      expect(text, "copied text must describe the node it came from").toContain(label)
    } finally {
      await ctx.close()
    }
  })

  test('an expanded node exports its own content as a CSV FILE', async () => {
    test.setTimeout(180_000)
    const { ctx, page } = await launch()
    try {
      const frame = await openOverlay(ctx, page)
      const label = await expandFirstNode(frame)
      await page.waitForTimeout(600)

      // The node's CSV button used to copy to the clipboard while the toolbar's
      // CSV button, one control away, downloaded a file. Pressing "CSV" and
      // getting no file is the defect; a download is the whole assertion.
      const pending = page.waitForEvent('download', { timeout: 20_000 })
      await clickControl(page, frame, `Export details for ${label} as CSV`)
      const download = await pending

      expect(
        download.suggestedFilename(),
        'a single step must download as its own dated CSV file'
      ).toMatch(/-step-\d{4}-\d{2}-\d{2}\.csv$/)

      const body = fs.readFileSync(await download.path(), 'utf8')
      const lines = body.trim().split('\n')
      expect(lines.length, `node CSV must have a header plus rows, got: ${JSON.stringify(body.slice(0, 200))}`).toBeGreaterThan(1)
      expect(lines[0], 'first line must be a comma-separated header').toContain(',')
    } finally {
      await ctx.close()
    }
  })
})
