/*
 * @contentauth/c2pa-web 0.11+ ships the web worker as a standalone file
 * (dist/c2pa_worker.js) instead of the old inline-blob IIFE. Firefox MV3 forbids
 * blob: workers (and strips blob: from the extension-page CSP), so we package the
 * shipped worker file and point c2pa-web at it via the library's native
 * `workerSrc` config option (see src/c2pa.ts init()). This copies the worker into
 * public/ so it is bundled as a chrome-/moz-extension:// URL (allowed by 'self').
 *
 * Runs in prebuild so the packaged worker always matches the installed SDK.
 * (Replaces the 0.9.x inline-IIFE extraction + the __C2PA_WORKER_URL__ patch,
 * both obsolete now that c2pa-web exposes workerSrc natively.)
 */
import fs from 'node:fs'
import path from 'node:path'

const src = 'node_modules/@contentauth/c2pa-web/dist/c2pa_worker.js'
const out = 'public/c2pa-web.worker.js'

if (!fs.existsSync(src)) {
  console.error(
    'extract-c2pa-worker: worker file not found at', src,
    '\n(@contentauth/c2pa-web dist layout changed — update this path.)',
  )
  process.exit(1)
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.copyFileSync(src, out)
console.log(`extract-c2pa-worker: copied ${src} -> ${out} (${fs.statSync(out).size} bytes)`)
