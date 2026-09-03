/*
 * Allow extension-origin worker URLs in @contentauth/c2pa-web.
 *
 * c2pa-web 0.11 validates workerSrc with a hard https-only check:
 *
 *     if (e.protocol !== "https:")
 *       throw new Error(`Worker source URL must use https, but got ${e.protocol}`);
 *
 * We pass chrome.runtime.getURL('c2pa-web.worker.js'), whose protocol is
 * chrome-extension: (or moz-extension: on Firefox). Neither is https:, so
 * createC2pa() REJECTS, `c2pa` stays null, and every validation returns "no
 * manifest" — the extension silently reports that signed assets are unsigned.
 * That is the worst possible failure for a provenance verifier, and it is
 * invisible: the UI looks like a confident negative answer, not an error.
 *
 * We cannot simply drop workerSrc. The default path builds the worker from a
 * blob:/data: URL, which is exactly what #136 removed: Firefox MV3 forbids
 * blob: workers in the extension page CSP.
 *
 * An extension-packaged worker is same-origin and ships inside the signed
 * bundle, so it is at least as trustworthy as an https URL. The check is
 * widened, never removed: anything that is not https or an extension origin
 * still throws.
 *
 * Fails hard when the expected source is absent, so a c2pa-web upgrade can
 * never silently un-patch this and reintroduce the silent-negative bug.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

const DIST = 'node_modules/@contentauth/c2pa-web/dist'

const NEEDLE = 'if (e.protocol !== "https:")'
const PATCHED = 'if (e.protocol !== "https:" && e.protocol !== "chrome-extension:" && e.protocol !== "moz-extension:")'
const MARKER = 'moz-extension:'

const candidates = readdirSync(DIST).filter((f) => f.endsWith('.js'))
let patched = 0
let already = 0

for (const file of candidates) {
  const path = join(DIST, file)
  const source = readFileSync(path, 'utf-8')
  if (!source.includes('Worker source URL must use https')) continue

  if (source.includes(MARKER)) {
    already++
    console.log(`patch-c2pa-worker-scheme: already applied (${file})`)
    continue
  }

  if (!source.includes(NEEDLE)) {
    console.error(
      `patch-c2pa-worker-scheme: FAILED — found the https worker error in ${file} ` +
      'but not the expected check. c2pa-web changed its worker validation; ' +
      're-derive this patch before shipping, or the extension will silently ' +
      'report every signed asset as unsigned.'
    )
    process.exit(1)
  }

  writeFileSync(path, source.replace(NEEDLE, PATCHED))
  patched++
  console.log(`patch-c2pa-worker-scheme: patched ${file}`)
}

if (patched === 0 && already === 0) {
  console.error(
    'patch-c2pa-worker-scheme: FAILED — no c2pa-web dist file contains the ' +
    'worker-scheme check. The dependency layout changed; re-derive this patch.'
  )
  process.exit(1)
}
