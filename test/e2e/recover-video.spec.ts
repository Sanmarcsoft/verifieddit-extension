import { test, expect, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Recovering a stripped video's credential (#195), in the loaded extension.
 *
 * What is real: the browser, the extension, its engine, the video file and the
 * registered credential it reads. What is stood in for: the two network
 * answers. The Verifieddit service's reply and the registry's record are served
 * from inside the extension's offscreen page, where the requests are made,
 * because that page is not one Playwright can route.
 *
 * It proves the two things that matter: with the video switch off the file is
 * never sent, and with it on the file is sent once and the registered
 * credential is read and shown as recovered.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const WARM_URL = 'http://localhost:3000/multi-ingredient/'
const VIDEO_URL = 'http://localhost:3000/durable-video/pattern-no-credentials.mp4'
const MANIFEST_ID = 'e2e-video-0001'
const CREDENTIAL_B64 = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'durable-video', 'pattern.registered.c2pa')).toString('base64')

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-video-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

/** Run an expression in the extension's offscreen page, which Playwright does not list. */
async function offscreen (ctx: BrowserContext, page: Page): Promise<(expression: string) => Promise<unknown>> {
  const cdp: CDPSession = await ctx.browser()?.newBrowserCDPSession() ?? await ctx.newCDPSession(page)
  const targets = (await cdp.send('Target.getTargets')).targetInfos
  const target = targets.find((t) => t.url.endsWith('/offscreen.html'))
  expect(target, 'the offscreen page must exist once something has been verified').toBeTruthy()
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target!.targetId, flatten: false })
  let next = 1
  return async (expression: string) => {
    const id = next++
    const answer = new Promise<unknown>((resolve) => {
      const onMessage = (event: { message: string }): void => {
        const message = JSON.parse(event.message)
        if (message.id !== id) return
        cdp.off('Target.receivedMessageFromTarget', onMessage)
        resolve(message.result?.result?.value)
      }
      cdp.on('Target.receivedMessageFromTarget', onMessage)
    })
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }) })
    return await answer
  }
}

/** Answer the service and the registry from inside the offscreen page, and count uploads. */
const STAND_INS = `(() => {
  const real = fetch
  globalThis.__uploads = []
  globalThis.fetch = (url, init) => {
    const u = String(url)
    if (u === 'https://api.verifieddit.com/api/v1/verify') {
      const file = init?.body?.get?.('file')
      globalThis.__uploads.push({ method: init?.method, type: file?.type, size: file?.size, credentials: init?.credentials })
      return Promise.resolve(new Response(JSON.stringify({ durable: { recovery: { status: 'recovered', method: 'watermark', algorithm: 'videoseal', similarityScore: 96, manifestId: '${MANIFEST_ID}', signerCn: 'sign-testing.trusteddit.com', signedAt: '2026-10-06 12:15:00+00:00' } } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.startsWith('https://manifests.sanmarcsoft.com/v1/manifests/${MANIFEST_ID}')) {
      const bytes = Uint8Array.from(atob('${CREDENTIAL_B64}'), (c) => c.charCodeAt(0))
      return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'application/c2pa' } }))
    }
    return real(url, init)
  }
  return 'ready'
})()`

interface Outcome {
  name?: string
  recoveryChecked?: boolean
  recoveryMedium?: string
  recovered?: { manifestId: string } | null
  recoveredFrom?: { manifestId: string, medium?: string, signerCn: string | null } | null
  validationStatus?: string[]
  hasManifest: boolean
}

/** What a right-click Verify asks the engine, with the two switches as given. */
async function verify (ctx: BrowserContext, switches: { probe: boolean, upload: boolean }): Promise<Outcome> {
  const sw = ctx.serviceWorkers()[0]
  return await sw.evaluate(async ({ url, probe, upload }) => {
    const r = await chrome.runtime.sendMessage({ action: 'MSG_C2PA_VALIDATE_URL', data: url, recover: true, probe, upload })
    return {
      name: r?.name,
      recoveryChecked: r?.recoveryChecked,
      recoveryMedium: r?.recoveryMedium,
      recovered: r?.recovered,
      recoveredFrom: r?.recoveredFrom,
      validationStatus: r?.manifestStore?.validationStatus,
      hasManifest: r?.manifestStore != null
    }
  }, { url: VIDEO_URL, ...switches })
}

test('a stripped video is sent only with both switches on, and its credential comes back marked as recovered', async () => {
  test.setTimeout(120_000)
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    // Verifying anything brings the engine's offscreen page up.
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })
    await page.goto(WARM_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await expect.poll(async () => await page.evaluate(() => document.querySelectorAll('div[c2pa-icon]').length), { timeout: 45_000 }).toBeGreaterThan(0)

    const inOffscreen = await offscreen(ctx, page)
    expect(await inOffscreen(STAND_INS)).toBe('ready')
    const uploads = async (): Promise<Array<{ method: string, type: string, size: number, credentials: string }>> =>
      JSON.parse(await inOffscreen('JSON.stringify(globalThis.__uploads)') as string)

    // Online check on, video switch off: the video stays in the browser.
    const held = await verify(ctx, { probe: true, upload: false })
    expect(held.name).toBe('No Manifest')
    expect(held.recoveryChecked).toBe(false)
    expect(held.recoveryMedium).toBe('video')
    expect(await uploads()).toEqual([])

    // Video switch on, online check off: still nothing leaves.
    await verify(ctx, { probe: false, upload: true })
    expect(await uploads()).toEqual([])

    // Both on: one upload of the file, without cookies.
    const found = await verify(ctx, { probe: true, upload: true })
    const sent = await uploads()
    expect(sent.length).toBe(1)
    expect(sent[0]).toEqual({ method: 'POST', type: 'video/mp4', size: fs.statSync(path.resolve(__dirname, '..', 'fixtures', 'durable-video', 'pattern-no-credentials.mp4')).size, credentials: 'omit' })

    // The registered credential was read by the engine and is marked as recovered.
    expect(found.hasManifest, 'the registered credential must be read, not just summarised').toBe(true)
    expect(found.recoveredFrom?.manifestId).toBe(MANIFEST_ID)
    expect(found.recoveredFrom?.medium).toBe('video')
    expect(found.recoveredFrom?.signerCn).toBe('sign-testing.trusteddit.com')
  } finally {
    await ctx.close()
  }
})
