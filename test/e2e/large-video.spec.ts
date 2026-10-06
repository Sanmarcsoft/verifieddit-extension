import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Verifying a video without downloading it into memory (#197), in the loaded
 * extension, against a real server that honours range requests.
 *
 * Measured before this work: the engine reads a signed video up to about
 * 950 MB and from roughly 1 GB reports it as having no credentials. Now the
 * credential is read from its own box and the contents are checked as a
 * stream, so size no longer decides the answer.
 *
 * The signed video is a test pattern signed by the Trusteddit testing signer.
 * Two more files are made here at run time and removed afterwards: a copy with
 * one byte of picture data changed, and a 700 MB file (sparse on disk) that is
 * the signed video with empty boxes appended.
 */

const EXT_PATH = process.env.EXT_PATH ?? path.resolve(__dirname, '..', '..', 'dist', 'chrome')
const BASE = 'http://localhost:3000'
const DIR = path.resolve(__dirname, '..', 'fixtures', 'durable-video')
const SIGNED = path.join(DIR, 'pattern-signed.mp4')
const TAMPERED = path.join(DIR, 'zz-tampered.mp4')
const HUGE = path.join(DIR, 'zz-huge.mp4')
const HUGE_BYTES = 700 * 1024 * 1024

test.beforeAll(() => {
  const signed = fs.readFileSync(SIGNED)
  // One byte of picture data changed: find the mdat box and flip a byte inside it.
  const tampered = Buffer.from(signed)
  let at = 0
  while (at + 8 <= tampered.length) {
    const size = tampered.readUInt32BE(at)
    if (tampered.toString('latin1', at + 4, at + 8) === 'mdat') { tampered[at + 200] ^= 1; break }
    at += size
  }
  fs.writeFileSync(TAMPERED, tampered)
  // The signed video followed by empty 'free' boxes up to 700 MB. Sparse: the zeros take no disk.
  const fd = fs.openSync(HUGE, 'w')
  fs.writeSync(fd, signed, 0, signed.length, 0)
  let pos = signed.length
  while (pos < HUGE_BYTES) {
    const n = Math.min(200 * 1024 * 1024, HUGE_BYTES - pos)
    const header = Buffer.alloc(8); header.writeUInt32BE(n, 0); header.write('free', 4, 'latin1')
    fs.writeSync(fd, header, 0, 8, pos)
    pos += n
  }
  fs.ftruncateSync(fd, pos)
  fs.closeSync(fd)
})

test.afterAll(() => {
  for (const f of [TAMPERED, HUGE]) fs.rmSync(f, { force: true })
})

async function launch (): Promise<{ ctx: BrowserContext, page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifieddit-large-'))
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  })
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() }
}

interface Outcome { name?: string, message?: string, hasManifest: boolean, contents?: { state: string, bytes: number, note?: string }, codes?: string[], seconds: number }

/** Ask the engine as the background does. `asked` is a right-click Verify; without it, this is auto-scan. */
async function verify (ctx: BrowserContext, file: string, opts: { asked: boolean, inPieces: boolean }): Promise<Outcome> {
  return await ctx.serviceWorkers()[0].evaluate(async ({ url, asked, inPieces, pageUrl }) => {
    const started = Date.now()
    const r = await chrome.runtime.sendMessage({ action: 'MSG_C2PA_VALIDATE_URL', data: url, recover: asked, probe: false, pageUrl, inPieces })
    return { name: r?.name, message: r?.message, hasManifest: r?.manifestStore != null, contents: r?.contentsCheck, codes: r?.manifestStore?.validationStatus, seconds: (Date.now() - started) / 1000 }
  }, { url: `${BASE}/durable-video/${file}`, asked: opts.asked, inPieces: opts.inPieces, pageUrl: `${BASE}/durable-video/` })
}

test('a video is verified in pieces: credential from its own box, contents as a stream', async () => {
  test.setTimeout(240_000)
  const { ctx, page } = await launch()
  try {
    await page.waitForTimeout(2_000)
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
    await sw.evaluate(async () => { await chrome.storage.local.set({ autoScan: true }) })
    await page.goto(`${BASE}/multi-ingredient/`, { waitUntil: 'networkidle', timeout: 60_000 })
    await expect.poll(async () => await page.evaluate(() => document.querySelectorAll('div[c2pa-icon]').length), { timeout: 45_000 }).toBeGreaterThan(0)

    // The reader asked: the credential is read and the contents are checked. They match.
    const verified = await verify(ctx, 'pattern-signed.mp4', { asked: true, inPieces: true })
    expect(verified.hasManifest).toBe(true)
    expect(verified.contents?.state).toBe('verified')
    expect((verified.codes ?? []).filter((c) => /bmffHash/i.test(c))).toEqual([])

    // Nobody asked (auto-scan): the credential is read, the contents are not downloaded, and it says so.
    const unasked = await verify(ctx, 'pattern-signed.mp4', { asked: false, inPieces: true })
    expect(unasked.hasManifest).toBe(true)
    expect(unasked.contents?.state).toBe('not-checked')
    expect((unasked.codes ?? []).filter((c) => /bmffHash/i.test(c))).toEqual([])

    // One changed byte of picture data: the stream check catches it.
    const changed = await verify(ctx, 'zz-tampered.mp4', { asked: true, inPieces: true })
    expect(changed.hasManifest).toBe(true)
    expect(changed.contents?.state).toBe('changed')
    expect(changed.codes).toContain('assertion.bmffHash.mismatch')

    // A 700 MB file takes this path on its own, by its size. On auto-scan the
    // credential is read in moments, without downloading the file.
    const huge = await verify(ctx, 'zz-huge.mp4', { asked: false, inPieces: false })
    expect(huge.hasManifest, huge.message).toBe(true)
    expect(huge.contents?.state).toBe('not-checked')
    expect(huge.contents?.bytes).toBe(HUGE_BYTES)
    expect(huge.seconds).toBeLessThan(20)

    // Asked, the same 700 MB is hashed as a stream. Boxes were appended after
    // signing, so the honest answer is that it no longer matches.
    const hugeAsked = await verify(ctx, 'zz-huge.mp4', { asked: true, inPieces: false })
    expect(hugeAsked.hasManifest, hugeAsked.message).toBe(true)
    expect(hugeAsked.contents?.state).toBe('changed')
    console.log(`[large-video] 700 MB: credential only ${huge.seconds.toFixed(1)}s, full stream check ${hugeAsked.seconds.toFixed(1)}s`)
  } finally {
    await ctx.close()
  }
})
