import { test, expect, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Recovering a stripped video's credential in the browser (#197).
 *
 * What is real: the browser, the extension, its engine, the video files, the
 * frame it grabs and the fingerprints it computes. What is stood in for: the
 * registry, answered from inside the extension's offscreen page (the page the
 * requests come from, which Playwright cannot route).
 *
 * The stand-in is not lenient. It holds the fingerprints the SIGNER's own code
 * computed for the original clip (signer-fingerprints.json) and applies the
 * registry's rule: within 8 bits of 64 on pHash, cross-checked on dHash within
 * the same variant. So a pass here means the browser, decoding a re-encoded
 * copy with its own decoder and hashing it with our TypeScript, lands on what
 * the signer registered with Python.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const BASE = 'http://localhost:3000'
const WARM_URL = `${BASE}/multi-ingredient/`
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'durable-video')
const MANIFEST_ID = 'e2e-video-0001'
const SIGNER = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'signer-fingerprints.json'), 'utf8'))
const CREDENTIAL_B64 = fs.readFileSync(path.join(FIXTURES, 'registered-credential.c2pa')).toString('base64')

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
  const target = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/offscreen.html'))
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

/** The registry, with one video registered, answering by its real matching rule. Records every outbound request. */
const REGISTRY = `(() => {
  const real = fetch
  const signer = ${JSON.stringify(SIGNER)}
  const stored = { '': { phash: signer.phash, dhash: signer.dhash }, '-centre': signer.variants.centre, '-vertical': signer.variants.vertical }
  const bits = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b); let n = 0; while (x) { n += Number(x & 1n); x >>= 1n } return n }
  globalThis.__sent = []
  globalThis.fetch = (url, init) => {
    const u = String(url)
    if (!u.startsWith('http://localhost:3000/')) globalThis.__sent.push({ url: u, method: init?.method ?? 'GET', hasBody: init?.body != null })
    if (u.startsWith('https://manifests.sanmarcsoft.com/v1/matches/byBinding')) {
      const q = new URL(u).searchParams
      const hits = Object.entries(stored)
        .map(([variant, fp]) => ({ variant, d: bits(q.get('value'), fp[q.get('alg')]), cross: bits(q.get('crossValue'), fp[q.get('crossAlg')]) }))
        .filter((h) => h.d <= 8 && h.cross <= 8)
        .sort((a, b) => a.d - b.d)
      const matches = hits.slice(0, 1).map((h) => ({ manifestId: '${MANIFEST_ID}', similarityScore: Math.round(100 * (1 - h.d / 64)), algorithm: q.get('alg') + h.variant }))
      return Promise.resolve(new Response(JSON.stringify({ matches }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.startsWith('https://manifests.sanmarcsoft.com/v1/manifests/${MANIFEST_ID}')) {
      if (u.includes('format=json')) return Promise.resolve(new Response(JSON.stringify({ manifestId: '${MANIFEST_ID}', signerCn: 'sign-testing.trusteddit.com', signedAt: '2026-10-06 12:15:00+00:00', filename: 'scene.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } }))
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
  recoveryDetail?: string
  recoveredFrom?: { manifestId: string, medium?: string, signerCn: string | null, similarityScore: number } | null
  hasManifest: boolean
}

/** What a right-click Verify asks the engine. */
async function verify (ctx: BrowserContext, file: string, probe: boolean): Promise<Outcome> {
  return await ctx.serviceWorkers()[0].evaluate(async ({ url, probe }) => {
    const r = await chrome.runtime.sendMessage({ action: 'MSG_C2PA_VALIDATE_URL', data: url, recover: true, probe })
    return { name: r?.name, recoveryChecked: r?.recoveryChecked, recoveryMedium: r?.recoveryMedium, recoveryDetail: r?.recoveryDetail, recoveredFrom: r?.recoveredFrom, hasManifest: r?.manifestStore != null }
  }, { url: `${BASE}/durable-video/${file}`, probe })
}

test('a stripped video is found again from one frame, in the browser, however a platform reshaped it', async () => {
  test.setTimeout(180_000)
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    // Verifying anything brings the engine's offscreen page up.
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })
    await page.goto(WARM_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await expect.poll(async () => await page.evaluate(() => document.querySelectorAll('div[c2pa-icon]').length), { timeout: 45_000 }).toBeGreaterThan(0)

    const inOffscreen = await offscreen(ctx, page)
    expect(await inOffscreen(REGISTRY)).toBe('ready')
    const sent = async (): Promise<Array<{ url: string, method: string, hasBody: boolean }>> =>
      JSON.parse(await inOffscreen('JSON.stringify(globalThis.__sent)') as string)

    // With the online check off, nothing is asked of anyone.
    const off = await verify(ctx, 'scene.webm', false)
    expect(off.name).toBe('No Manifest')
    expect(off.recoveryChecked).toBe(false)
    expect(off.recoveryMedium).toBe('video')
    expect(await sent()).toEqual([])

    // With it on, each copy is found, and the registered credential is read.
    for (const file of ['scene.webm', 'scene-padded.webm', 'scene-vertical.webm', 'scene-logo.webm']) {
      const found = await verify(ctx, file, true)
      expect(found.hasManifest, `${file}: the registered credential must be read`).toBe(true)
      expect(found.recoveredFrom?.manifestId, file).toBe(MANIFEST_ID)
      expect(found.recoveredFrom?.medium, file).toBe('video')
      expect(found.recoveredFrom?.signerCn, file).toBe('sign-testing.trusteddit.com')
    }

    // A different video is looked for and not found.
    const other = await verify(ctx, 'other.webm', true)
    expect(other.name).toBe('No Manifest')
    expect(other.recoveryChecked).toBe(true)
    expect(other.recoveredFrom ?? null).toBeNull()

    // Only the registry was contacted, only by GET, and never with a body: no video, no frame.
    const all = await sent()
    expect(all.length).toBeGreaterThan(0)
    for (const request of all) {
      expect(new URL(request.url).host).toBe('manifests.sanmarcsoft.com')
      expect(request.method).toBe('GET')
      expect(request.hasBody).toBe(false)
    }
  } finally {
    await ctx.close()
  }
})
