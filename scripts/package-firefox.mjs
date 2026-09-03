#!/usr/bin/env node
/*
 * Package the Firefox add-on for addons.mozilla.org.
 *
 * scripts/package-release.sh cannot be reused: it is Chrome-hardcoded end to
 * end (dist/chrome paths, and a verify step that reads `minimum_chrome_version`,
 * a key the Gecko manifest does not have).
 *
 * Produces two artifacts in releases/, because AMO requires BOTH for a bundled
 * add-on:
 *   1. verifieddit-firefox-<version>.zip        — the add-on itself
 *   2. verifieddit-firefox-<version>-source.zip — the source-code submission,
 *      mandatory whenever the uploaded code is minified/bundled (we ship a
 *      rollup + terser build, so it always applies).
 *
 * Gates, in order: build -> manifest assertions -> addons-linter -> package.
 * Any failure exits non-zero before an artifact is written.
 *
 * Usage: node scripts/package-firefox.mjs [--skip-build]
 */

import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distDir = path.join(repoRoot, 'dist', 'firefox')
const releasesDir = path.join(repoRoot, 'releases')

/*
 * addons-linter is pinned deliberately. 7.x reports the manifest's
 * `data_collection_permissions` block as a hard error
 * (DATA_COLLECTION_PERMISSIONS_PROP_RESERVED) — a stale false positive that
 * would block a correct submission. 10.x is the version class AMO itself runs
 * and accepts the key. Never loosen this to a floating range.
 */
const ADDONS_LINTER = 'addons-linter@10.10.0'

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit', ...opts })

function fail (msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function step (msg) {
  console.log(`\n[1m── ${msg}[0m`)
}

// ── 1. Build ────────────────────────────────────────────────────────────────
if (!process.argv.includes('--skip-build')) {
  step('Building (production, auto-scan off)')
  sh('bun run build')
} else {
  console.log('── Skipping build (--skip-build)')
}

if (!fs.existsSync(distDir)) fail(`${distDir} does not exist — build first.`)

// ── 2. Manifest assertions ──────────────────────────────────────────────────
step('Verifying Gecko manifest')
const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'))
const gecko = manifest.browser_specific_settings?.gecko

const checks = [
  ['manifest_version is 3', manifest.manifest_version === 3],
  ['name is within AMO\'s 45-char limit', typeof manifest.name === 'string' && manifest.name.length <= 45],
  ['gecko.id is set', typeof gecko?.id === 'string' && gecko.id.length > 0],
  ['gecko.strict_min_version is set', typeof gecko?.strict_min_version === 'string'],
  // background.type:module needs FF >= 112 and storage.session needs FF >= 115,
  // so anything below 115 makes the linter (rightly) flag incompatible APIs.
  ['strict_min_version >= 115', parseFloat(gecko?.strict_min_version ?? '0') >= 115],
  ['data_collection_permissions declared', gecko?.data_collection_permissions !== undefined],
  ['background uses scripts, not service_worker', Array.isArray(manifest.background?.scripts) && manifest.background.service_worker === undefined],
  ['no chrome-only offscreen permission', !(manifest.permissions ?? []).includes('offscreen')]
]

let bad = false
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) bad = true
}

// Every web-accessible resource must actually exist, or the reviewer sees a
// package referencing files it does not ship (a stale "iframe.js" entry did
// exactly this before #141).
for (const entry of manifest.web_accessible_resources ?? []) {
  for (const res of entry.resources ?? []) {
    if (res.includes('*')) continue
    const exists = fs.existsSync(path.join(distDir, res))
    console.log(`  ${exists ? '✓' : '✗'} web_accessible_resource exists: ${res}`)
    if (!exists) bad = true
  }
}

// The Gecko bundle must not merely guard chrome.offscreen — it must not mention
// it, or AMO reports UNSUPPORTED_API against the shipped file.
const bgSource = fs.readFileSync(path.join(distDir, 'background.js'), 'utf8')
const offscreenFree = !bgSource.includes('offscreen')
console.log(`  ${offscreenFree ? '✓' : '✗'} background.js free of chrome.offscreen references`)
if (!offscreenFree) bad = true

if (bad) fail('Gecko manifest verification failed.')

console.log(`\n  name    : ${manifest.name} (${manifest.name.length} chars)`)
console.log(`  version : ${manifest.version}`)
console.log(`  id      : ${gecko.id}`)
console.log(`  min FF  : ${gecko.strict_min_version}`)

// ── 3. Lint ─────────────────────────────────────────────────────────────────
step(`Linting with ${ADDONS_LINTER}`)
let lintOut
try {
  lintOut = execFileSync('bunx', ['--bun', ADDONS_LINTER, '--output', 'json', distDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
} catch (err) {
  // addons-linter exits non-zero when it finds errors; the JSON is still on stdout.
  lintOut = err.stdout ?? ''
}
let lint
try {
  lint = JSON.parse(lintOut)
} catch {
  fail(`Could not parse addons-linter output:\n${lintOut.slice(0, 2000)}`)
}

const { errors = 0, warnings = 0, notices = 0 } = lint.summary ?? {}
console.log(`  errors=${errors} warnings=${warnings} notices=${notices}`)
for (const e of lint.errors ?? []) console.log(`  ERROR   ${e.code}: ${e.message}`)
const warnCodes = new Map()
for (const w of lint.warnings ?? []) warnCodes.set(w.code, (warnCodes.get(w.code) ?? 0) + 1)
for (const [code, n] of warnCodes) console.log(`  warning ${code} x${n}`)

if (errors > 0) fail(`addons-linter reported ${errors} error(s) — AMO would reject this.`)

// ── 4. Package ──────────────────────────────────────────────────────────────
step('Packaging')
fs.mkdirSync(releasesDir, { recursive: true })
const version = manifest.version
const addonZip = path.join(releasesDir, `verifieddit-firefox-${version}.zip`)
const sourceZip = path.join(releasesDir, `verifieddit-firefox-${version}-source.zip`)

// web-ext build writes the zip itself, so no `zip(1)` dependency (it is not
// installed on every host in this estate).
for (const f of [addonZip, sourceZip]) if (fs.existsSync(f)) fs.unlinkSync(f)

sh(`bunx --bun web-ext build --source-dir "${distDir}" --artifacts-dir "${releasesDir}" --filename "verifieddit-firefox-${version}.zip" --overwrite-dest`)

/*
 * Source archive. src/build-info.ts and public/c2pa-web.worker.js are generated
 * at build time AND gitignored, so a `git archive` would omit them and the
 * reviewer's rebuild would report commit "unknown". Include them explicitly.
 */
step('Building AMO source archive')
const sourceEntries = [
  'src', 'public', 'scripts', 'patches',
  'package.json', 'bun.lock', 'rollup.config.js', 'tsconfig.json',
  'update-version.js', 'LICENSE', 'README.md', 'AMO_REVIEWER_NOTES.md'
].filter((p) => fs.existsSync(path.join(repoRoot, p)))

const missing = ['src/build-info.ts', 'public/c2pa-web.worker.js']
  .filter((p) => !fs.existsSync(path.join(repoRoot, p)))
if (missing.length > 0) {
  fail(`Generated files missing from source archive: ${missing.join(', ')}. Run a build first.`)
}

// `zip(1)` is absent on some hosts in this estate, so fall back to python3's
// zipfile module rather than failing the release on a missing CLI.
let haveZip = true
try {
  execSync('command -v zip', { stdio: 'ignore' })
} catch {
  haveZip = false
}

if (haveZip) {
  sh(`zip -q -r -X "${sourceZip}" ${sourceEntries.map((e) => `"${e}"`).join(' ')} -x "*/node_modules/*" "*/.DS_Store"`)
} else {
  const py = `
import os, sys, zipfile
out, roots = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root in roots:
        if os.path.isfile(root):
            z.write(root, root); continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != 'node_modules']
            for fn in filenames:
                if fn == '.DS_Store': continue
                p = os.path.join(dirpath, fn)
                z.write(p, p)
`
  execFileSync('python3', ['-c', py, sourceZip, ...sourceEntries], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
}

const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2)
const sha = (f) => execSync(`shasum -a 256 "${f}"`, { encoding: 'utf8' }).split(' ')[0]

console.log('\n[1m── Artifacts[0m')
for (const f of [addonZip, sourceZip]) {
  console.log(`  ${path.basename(f)}`)
  console.log(`    size   ${mb(f)} MB`)
  console.log(`    sha256 ${sha(f)}`)
}
console.log('\n✓ Ready for upload at https://addons.mozilla.org/developers/addon/submit/upload-listed')
console.log('  Attach the -source.zip under "Source code" when prompted.')
