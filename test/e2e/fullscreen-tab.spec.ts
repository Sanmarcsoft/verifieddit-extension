import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * "Full screen" in the toolbar popup must hand the chain to a real tab.
 *
 * The popup mounts the diagram straight into a ~380px window, so
 * requestFullscreen is refused and the CSS fallback's `inset: 0` expands
 * against a viewport the diagram already filled. Nothing visibly happened, and
 * every layer reported success, which is exactly why this needs a probe that
 * asserts on the OUTCOME (a tab appears) rather than on a handler running.
 *
 * The real browser-action popup cannot be opened by Playwright. What is
 * verified here is the component contract the popup depends on, plus the
 * destination page, both in a real Chrome with real user activation.
 */

// EXT_PATH is set by nobody: not e2e.yml, not playwright.config.ts, not any
// package script. Reading it bare left every arg as the string "undefined",
// so Chrome loaded no extension, no MV3 service worker ever registered, and
// the wait below sat until the test timed out. Same fallback as its siblings
// node-resize.spec.ts and node-export.spec.ts (#180).
const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')

const GRAPH = {
  nodes: [
    { id: 'a', kind: 'origin', label: 'Origin capture', validationState: 'valid', isActive: false },
    { id: 'b', kind: 'current', label: 'This asset', validationState: 'current', isActive: true }
  ],
  edges: [{ id: 'e', source: 'a', target: 'b' }]
}

async function launch () {
  // Fail here, loudly, rather than 180 seconds later on a bare timeout.
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`built extension must exist at ${EXT_PATH}; run "bun run build" first`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-tab-'))
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 1000 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  await new Promise(r => setTimeout(r, 2000))
  let [sw] = ctx.serviceWorkers()
  if (sw == null) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 })
  return { ctx, sw, extensionId: new URL(sw.url()).host }
}

test('popup-mode Full screen asks the host for a tab instead of silently doing nothing', async () => {
  test.setTimeout(180_000)
  const { ctx, extensionId } = await launch()
  try {
    const page = await ctx.newPage()
    page.on('pageerror', e => console.log('  PAGEERR', e.message.slice(0, 200)))
    await page.setViewportSize({ width: 400, height: 900 })
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)

    const setup = await page.evaluate(async (graph) => {
      const slot = document.createElement('div')
      document.body.appendChild(slot)
      const el = document.createElement('c2pa-provenance-graph') as HTMLElement & { graph?: unknown, shadowRoot: ShadowRoot | null }
      el.graph = graph
      // Exactly what popup.ts sets at its mount site.
      el.setAttribute('fullscreen-mode', 'tab')
      ;(window as any).__events = []
      el.addEventListener('provenance-open-in-tab', (ev: Event) => {
        const d = (ev as CustomEvent).detail
        ;(window as any).__events.push({ nodes: d?.graph?.nodes?.length ?? 0 })
      })
      slot.appendChild(el)
      await new Promise(r => setTimeout(r, 900))
      const root = el.shadowRoot!
      const btn = [...root.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Full screen') as HTMLButtonElement | undefined
      const br = btn!.getBoundingClientRect()
      ;(window as any).__frame = root.querySelector('.frame')
      return {
        buttonFound: btn != null,
        fullscreenEnabled: document.fullscreenEnabled,
        btnPoint: { x: br.left + br.width / 2, y: br.top + br.height / 2 }
      }
    }, GRAPH)
    console.log('setup ' + JSON.stringify(setup))
    expect(setup.buttonFound, 'the Full screen control must exist').toBe(true)

    // Real click: requestFullscreen needs transient activation, and a synthetic
    // click would fail for a reason that has nothing to do with this fix.
    await page.mouse.click(setup.btnPoint.x, setup.btnPoint.y)
    await page.waitForTimeout(1200)

    const after = await page.evaluate(() => ({
      events: (window as any).__events,
      documentFullscreenElement: document.fullscreenElement != null,
      frameClass: ((window as any).__frame as HTMLElement).className
    }))
    console.log('after ' + JSON.stringify(after))

    expect(after.events.length, 'pressing Full screen in tab mode must ask the host to open a tab').toBe(1)
    expect(after.events[0].nodes, 'the whole chain must travel with the request').toBe(GRAPH.nodes.length)
    expect(after.documentFullscreenElement, 'tab mode must not call the Fullscreen API at all').toBe(false)
    expect(after.frameClass, 'tab mode must not apply the dead in-place fallback').not.toContain('fullscreen')
  } finally {
    await ctx.close()
  }
})

test('the handed-off chain renders in a real tab', async () => {
  test.setTimeout(180_000)
  const { ctx, sw, extensionId } = await launch()
  try {
    await sw.evaluate(async (graph) => {
      const area = (chrome.storage as any).session ?? chrome.storage.local
      await area.set({ diagramHandoff: graph })
    }, GRAPH)

    const tab = await ctx.newPage()
    tab.on('pageerror', e => console.log('  TABERR', e.message.slice(0, 200)))
    await tab.goto(`chrome-extension://${extensionId}/diagram.html`, { waitUntil: 'domcontentloaded' })
    await tab.waitForTimeout(1500)

    const rendered = await tab.evaluate(() => {
      const el = document.querySelector('c2pa-provenance-graph') as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null
      const root = el?.shadowRoot
      return {
        elementPresent: el != null,
        nodeCount: root == null ? 0 : root.querySelectorAll('.node[data-node-id]').length,
        hasFullscreenButton: root == null ? false : [...root.querySelectorAll('button')].some(b => (b.textContent || '').trim() === 'Full screen'),
        title: document.title,
        emptyState: document.body.textContent?.includes('No provenance chain') ?? false
      }
    })
    console.log('rendered ' + JSON.stringify(rendered))

    expect(rendered.emptyState, 'the handed-off graph must be found, not the empty state').toBe(false)
    expect(rendered.elementPresent, 'the diagram must mount in the tab').toBe(true)
    expect(rendered.nodeCount, 'every node in the chain must render').toBe(GRAPH.nodes.length)
    expect(rendered.hasFullscreenButton, 'full screen must still be available in the tab, where it works').toBe(true)
  } finally {
    await ctx.close()
  }
})
