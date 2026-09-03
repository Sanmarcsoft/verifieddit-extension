/*
 * Headless end-to-end verifier test. Loads the built Chrome extension
 * (dist/chrome) into a real headless Chromium, drives the actual background
 * MSG_VALIDATE_URL flow (offscreen c2pa-web engine + WebCrypto trust check),
 * and prints the resulting verdict for one or more media URLs. No manual
 * browser testing required.
 *
 *   node scripts/e2e-verify.mjs <url> [<url> ...]
 *
 * Requires: `npx playwright install chromium` once. Exit code is non-zero if
 * any URL fails to validate (engine error), so it can gate CI.
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(here, '..', 'dist', 'chrome')
const DEFAULT_URL = 'https://www.verifieddit.com/test-images/interop/Pixel%20Camera%20Prod%20L2-MAH-Images/PXL_20250814_180141200.MP.jpg'
const urls = process.argv.slice(2)
if (urls.length === 0) urls.push(DEFAULT_URL)

const ctx = await chromium.launchPersistentContext('/tmp/vd-e2e-profile', {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox']
})

let sw = ctx.serviceWorkers()[0]
if (sw == null) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const extId = new URL(sw.url()).host
const page = await ctx.newPage()
await page.goto(`chrome-extension://${extId}/options.html`)
await page.waitForTimeout(2000) // let the trust-list init settle

let failures = 0
for (const url of urls) {
  const r = await page.evaluate(async (u) => {
    try { return await chrome.runtime.sendMessage({ action: 'MSG_VALIDATE_URL', data: u }) } catch (e) { return { error: String(e) } }
  }, url)
  const trusted = r?.trustList != null
  const codes = r?.manifestStore?.validationStatus ?? []
  console.log('\n• ' + url)
  if (r?.error != null || r?.message != null) {
    console.log('  ENGINE ERROR:', r.error ?? r.message)
    failures++
    continue
  }
  console.log('  signer      :', r?.manifestStore?.manifests?.[r?.manifestStore?.activeManifest]?.signatureInfo?.issuer ?? '(unknown)')
  console.log('  certChain    :', (r?.certChain?.length ?? 0) + ' certs')
  console.log('  trust        :', trusted ? `TRUSTED — ${r.trustList.entity?.name} (${r.trustList.tlInfo?.name})` : 'not in trust list')
  console.log('  validation   :', codes.length > 0 ? JSON.stringify(codes) : '(clean)')
  const p = r?.durablePillars
  if (p != null) {
    console.log('  durable      :', `P1 signed+ts=${p.signedAndTimestamped} | P2 watermark=${p.trustmark} | P3 manifestStore=${p.manifestStore} | count=${p.count}/3`)
  }
  console.log('  storeProbe   :', r?.manifestStoreVerified === true ? 'REGISTERED (P3 verified)' : 'no match / not probed')
}

await ctx.close()
process.exit(failures > 0 ? 1 : 0)
