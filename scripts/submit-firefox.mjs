#!/usr/bin/env node
/*
 * Sign and upload a new Firefox version to addons.mozilla.org.
 *
 * SCOPE: this automates *subsequent* releases. The FIRST listed submission must
 * go through the Developer Hub by hand, because the AMO signing API carries the
 * package only — it cannot set listing metadata (name, summary, categories,
 * screenshots, privacy policy) and cannot attach the source archive that AMO
 * requires for bundled code. Once the listing exists and the source archive has
 * been accepted once, version bumps can ship from here.
 * The manual first-submission walkthrough lives in the publisher's internal notes.
 *
 * Credentials come from `pass` and are handed to web-ext through the
 * environment, never through argv — argv is visible in `ps` to every user on
 * the box, which is the same reason bin/sovereign-image-build.sh takes its
 * secrets on stdin.
 *
 * Usage:
 *   node scripts/submit-firefox.mjs [--channel listed|unlisted] [--dry-run]
 */

import { execFileSync, execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distDir = path.join(repoRoot, 'dist', 'firefox')
const releasesDir = path.join(repoRoot, 'releases')

const ISSUER_ENTRY = 'sanmarcsoft/amo/jwt-issuer'
const SECRET_ENTRY = 'sanmarcsoft/amo/jwt-secret'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const CHANNEL = arg('channel', 'listed')
const DRY_RUN = process.argv.includes('--dry-run')

function fail (msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function readPass (entry) {
  const res = spawnSync('pass', ['show', entry], { encoding: 'utf8' })
  if (res.status !== 0) return null
  const value = (res.stdout ?? '').split('\n')[0].trim()
  return value.length > 0 ? value : null
}

// ── Credentials ─────────────────────────────────────────────────────────────
const issuer = readPass(ISSUER_ENTRY)
const secret = readPass(SECRET_ENTRY)

if (issuer === null || secret === null) {
  console.error(`
✗ AMO credentials not found in pass.

  Missing: ${issuer === null ? ISSUER_ENTRY : ''}${issuer === null && secret === null ? ' and ' : ''}${secret === null ? SECRET_ENTRY : ''}

  To create them:

    1. Sign in at https://addons.mozilla.org/ with the SanMarcSoft Mozilla
       account (create one if this is the first time; AMO requires the account
       to have accepted the Developer Agreement).

    2. Go to https://addons.mozilla.org/developers/addon/api/key/
       and choose "Generate new credentials".

    3. AMO shows a JWT issuer (looks like "user:12345678:123") and a secret
       (a long hex string). THE SECRET IS SHOWN EXACTLY ONCE — copy it before
       leaving the page.

    4. Store both:

         pass insert ${ISSUER_ENTRY}
         pass insert ${SECRET_ENTRY}

  Treat the secret like a signing key: it can publish code under the
  SanMarcSoft name to every Firefox user who has the add-on installed.
`)
  process.exit(1)
}

// A JWT issuer is always of the form user:<numeric id>:<numeric key id>.
// Catching a swapped issuer/secret here beats a 401 halfway through an upload.
if (!/^user:\d+:\d+$/.test(issuer)) {
  fail(`${ISSUER_ENTRY} does not look like an AMO JWT issuer (expected "user:<id>:<id>"). Are the two entries swapped?`)
}
if (secret.length < 32) {
  fail(`${SECRET_ENTRY} looks too short to be an AMO JWT secret.`)
}

// ── Package ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(distDir)) {
  fail(`${distDir} does not exist. Run: bun run package:firefox`)
}

const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'))
const version = manifest.version
const sourceZip = path.join(releasesDir, `verifieddit-firefox-${version}-source.zip`)

console.log(`  add-on  : ${manifest.name}`)
console.log(`  id      : ${manifest.browser_specific_settings?.gecko?.id}`)
console.log(`  version : ${version}`)
console.log(`  channel : ${CHANNEL}`)
console.log(`  issuer  : ${issuer}`)
console.log(`  secret  : (${secret.length} chars, withheld)`)

// Re-run the same gates package-firefox.mjs applies, so a hand-edited dist can
// never be signed and pushed to real users.
console.log('\n── Re-running the packaging gate')
try {
  execSync('node scripts/package-firefox.mjs --skip-build', { cwd: repoRoot, stdio: 'inherit' })
} catch {
  fail('Packaging gate failed — refusing to sign.')
}

if (!fs.existsSync(sourceZip)) {
  fail(`Source archive missing: ${sourceZip}`)
}

// Refuse to publish a build that did not come from a clean, tagged tree.
const describe = execSync('git describe --tags --always --dirty', { cwd: repoRoot, encoding: 'utf8' }).trim()
if (describe.endsWith('-dirty')) {
  fail(`Working tree is dirty (${describe}). Commit and tag before publishing to a public store.`)
}
console.log(`\n  git     : ${describe}`)

if (DRY_RUN) {
  console.log('\n✓ Dry run: all preflight checks passed. Re-run without --dry-run to upload.')
  process.exit(0)
}

// ── Sign + upload ───────────────────────────────────────────────────────────
console.log(`\n── Uploading to AMO (${CHANNEL})`)
const res = spawnSync('bunx', [
  '--bun', 'web-ext', 'sign',
  '--source-dir', distDir,
  '--artifacts-dir', releasesDir,
  '--channel', CHANNEL,
  '--upload-source-code', sourceZip
], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // web-ext reads these; keeps both values out of argv and out of `ps`.
    WEB_EXT_API_KEY: issuer,
    WEB_EXT_API_SECRET: secret
  }
})

if (res.status !== 0) {
  console.error(`
✗ Upload failed.

  If web-ext rejected --upload-source-code, your web-ext predates that flag.
  Re-run without it and attach ${path.basename(sourceZip)} manually at
  https://addons.mozilla.org/developers/ , or upgrade web-ext.

  A 401 means the credentials are wrong or were revoked. A 409 means this
  version already exists on AMO — bump the version in package.json and
  src/manifest.firefox.v3.json and rebuild.
`)
  process.exit(res.status ?? 1)
}

console.log(`
✓ Version ${version} uploaded to AMO on the ${CHANNEL} channel.
  Track review status at https://addons.mozilla.org/developers/addons
`)
