/*
 * Regenerate the reference manifest JSON for every asset in the demo corpus,
 * plus the human-facing comparison page.
 *
 *   node scripts/generate-corpus-manifests.mjs
 *
 * Ground truth comes from c2patool, the c2pa-rs reference implementation, not
 * from us. That is the whole point: these files are what the extension's own
 * verdict gets compared against, so they have to be produced by something with
 * no stake in the extension being right.
 *
 * Every asset is read TWICE, because a C2PA verdict is not a property of the
 * file alone:
 *
 *   bare     c2patool with no trust anchors at all. Pure structural and
 *            cryptographic integrity: do the hashes match, does the signature
 *            verify, is the claim intact. Every signer reads as untrusted here,
 *            including our own, because there is nothing to trust against.
 *   anchored c2patool with the public Trusteddit anchors. This is the question
 *            "is this signer one we recognise", asked separately.
 *
 * Reporting only the bare pass is how you end up staring at 42 yellow warnings
 * and concluding the corpus is broken. Reporting only the anchored pass hides
 * the tamper detection, which is the part that actually matters.
 *
 * Output:
 *   <dir>/manifests/<basename>.json   full manifest store from the bare pass,
 *                                     including validation_status and
 *                                     validation_results
 *   <corpus>/REFERENCE-NOTES.md       one row per asset, both verdicts
 *   <corpus>/reference-corpus.html    the same thing with the media inline
 *
 * c2patool is deliberately not a devDependency. It is a Rust binary; install it
 * with `brew install c2patool` or from the c2pa-rs releases page.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.resolve(here, '..', 'test', 'fixtures', 'demo-corpus')

/**
 * The production Trusteddit anchors, fetched once rather than 47 times.
 * Public by design: no key, ever. See api.trusteddit.com/v1/trust/anchors.
 */
const ANCHOR_URL = 'https://api.trusteddit.com/v1/trust/anchors'
const anchorFile = path.join(os.tmpdir(), 'trusteddit-anchors.pem')

function fetchAnchors () {
  try {
    execFileSync('curl', ['-fsS', '-o', anchorFile, ANCHOR_URL], { stdio: ['ignore', 'pipe', 'pipe'] })
    const pem = fs.readFileSync(anchorFile, 'utf8')
    const count = (pem.match(/BEGIN CERTIFICATE/g) ?? []).length
    if (count === 0) throw new Error('no certificates in response')
    console.log(`anchors: ${count} certificates from ${ANCHOR_URL}`)
    return true
  } catch (err) {
    // Not fatal. The bare pass still produces the reference JSON; we just
    // cannot answer the "do we recognise this signer" half, so say so loudly
    // rather than silently emitting a page that claims everything is untrusted.
    console.warn(`WARNING: could not fetch trust anchors (${err.message}).`)
    console.warn('The anchored column will read "(not checked)".')
    return false
  }
}

const haveAnchors = fetchAnchors()

/** Directories holding media, each paired with where its manifests belong. */
const ASSET_DIRS = [
  { media: 'c2pa-official/jpeg', manifests: 'c2pa-official/manifests' },
  { media: 'c2pa-official/pdf', manifests: 'c2pa-official/manifests' },
  { media: 'c2pa-official/video', manifests: 'c2pa-official/manifests' },
  { media: 'cai-example-assets/images', manifests: 'cai-example-assets/images/manifests' },
  { media: 'cai-example-assets/videos', manifests: 'cai-example-assets/videos/manifests' },
  { media: 'iptc-vmh/video', manifests: 'iptc-vmh/manifests' },
  { media: '.', manifests: 'manifests' }
]

const MEDIA_RE = /\.(jpg|jpeg|png|webp|gif|tif|tiff|avif|heic|mp4|mov|m4a|mp3|wav|pdf|svg)$/i

function c2patool (file, { anchors = false } = {}) {
  const args = anchors ? [file, 'trust', '--trust_anchors', anchorFile] : [file]
  try {
    const out = execFileSync('c2patool', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    // c2patool prints a banner before the JSON on some paths.
    const start = out.indexOf('{')
    return { ok: true, json: JSON.parse(start > 0 ? out.slice(start) : out) }
  } catch (err) {
    const stderr = String(err.stderr ?? err.message ?? '').trim()
    return { ok: false, error: stderr.split('\n').slice(0, 3).join(' ') }
  }
}

function statusCodes (store) {
  const codes = (store.validation_status ?? []).map((v) => v.code)
  return codes.length === 0 ? [] : [...new Set(codes)]
}

/** Collapse a manifest store into the few facts worth putting in a table. */
function summarise (store) {
  const key = store.active_manifest
  const m = store.manifests?.[key] ?? {}
  const assertions = (m.assertions ?? []).map((a) => a.label)
  return {
    title: m.title ?? '',
    generator: m.claim_generator ?? '',
    ingredients: (m.ingredients ?? []).length,
    assertions: assertions.length,
    aiTrained: assertions.some((l) => String(l).includes('training-mining')) ||
      JSON.stringify(m.assertions ?? []).includes('trainedAlgorithmicMedia'),
    status: statusCodes(store)
  }
}

/*
 * Severity, worst first. Ordering is the whole point: adobe-20220124-E-dat-CA
 * reports BOTH signingCredential.untrusted and assertion.dataHash.mismatch, and
 * calling that a warning because "untrusted" matched first would paint a
 * detected tamper the same colour as a self-signed certificate.
 */
const BROKEN_RE = /mismatch|missing|invalid|failed|revoked|malformed/i
const EXPIRED_RE = /expired/i
const UNTRUSTED_RE = /untrusted/i

function severity (codes, hasCredentials) {
  if (!hasCredentials) return 'none'
  if (codes.some((c) => BROKEN_RE.test(c))) return 'bad'
  if (codes.some((c) => EXPIRED_RE.test(c))) return 'expired'
  if (codes.some((c) => UNTRUSTED_RE.test(c))) return 'warn'
  return 'good'
}

const SEVERITY_LABEL = {
  none: 'no Content Credentials',
  bad: 'integrity failure',
  expired: 'certificate expired',
  warn: 'signer not recognised',
  good: 'valid and trusted'
}

const rows = []
let written = 0
let noCredentials = 0

for (const { media, manifests } of ASSET_DIRS) {
  const mediaDir = path.join(CORPUS, media)
  if (!fs.existsSync(mediaDir)) continue
  const manifestDir = path.join(CORPUS, manifests)
  fs.mkdirSync(manifestDir, { recursive: true })

  for (const name of fs.readdirSync(mediaDir).sort()) {
    const full = path.join(mediaDir, name)
    if (!fs.statSync(full).isFile() || !MEDIA_RE.test(name)) continue

    const rel = path.relative(CORPUS, full)
    const res = c2patool(full)
    const base = name.replace(/\.[^.]+$/, '')
    const outFile = path.join(manifestDir, `${base}.json`)

    if (res.ok) {
      fs.writeFileSync(outFile, JSON.stringify(res.json, null, 2) + '\n')
      written++
      const s = summarise(res.json)
      let anchored = ['(not checked)']
      if (haveAnchors) {
        const a = c2patool(full, { anchors: true })
        anchored = a.ok ? statusCodes(a.json) : [a.error]
      }
      rows.push({
        rel,
        manifest: path.relative(CORPUS, outFile),
        ...s,
        anchored,
        severity: severity(haveAnchors ? anchored : s.status, true)
      })
    } else {
      noCredentials++
      rows.push({
        rel,
        manifest: '(none)',
        title: '',
        generator: '',
        ingredients: 0,
        assertions: 0,
        aiTrained: false,
        status: [res.error],
        anchored: [],
        severity: 'none'
      })
    }
    process.stdout.write(`${res.ok ? 'OK  ' : 'NONE'} ${rel}\n`)
  }
}

const fmt = (codes) => codes.length === 0 ? '`(clean)`' : codes.map((c) => `\`${c}\``).join('<br>')

const notes = [
  '# Reference notes for the demo corpus',
  '',
  '> Generated by `node scripts/generate-corpus-manifests.mjs`. Do not edit by hand.',
  `> Regenerated ${new Date().toISOString().slice(0, 10)} with \`c2patool\` as ground truth.`,
  '',
  'Every row is what **c2patool**, the c2pa-rs reference implementation, reports',
  'for that asset. The extension is expected to agree. Where it does not, the',
  'reference is right and we are wrong until proven otherwise.',
  '',
  '## The two columns are two different questions',
  '',
  '**Bare** is c2patool with no trust anchors: are the hashes intact, does the',
  'signature verify, is the claim well formed. Every signer reads as',
  '`signingCredential.untrusted` here, ours included, because there is nothing to',
  'trust against. Ignore that code in this column and read the rest.',
  '',
  '**Anchored** is the same asset checked against the public Trusteddit anchors',
  `(${ANCHOR_URL}). A signer that stays`,
  '`untrusted` here is genuinely not one Trusteddit recognises. Most of the public',
  'test files are signed with test certificates that are deliberately in no',
  'production trust list, so "untrusted" is the correct verdict for them, not a bug.',
  '',
  '**Neither column is the extension\'s answer.** Verifieddit ships six trust lists',
  'and 82 entities, including the CAI known-certificate anchors added in #160, so',
  'it recognises signers these anchors alone do not. Expect the extension to be',
  '*more* permissive on the Adobe, Truepic and CAI assets. What it must never do is',
  'disagree on the integrity codes.',
  '',
  '| Asset | Reference JSON | Title | Claim generator | Ingr. | Assert. | Bare | Anchored | Verdict |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.rel}\` | \`${r.manifest}\` | ${r.title || '-'} | ${r.generator || '-'} | ${r.ingredients} | ${r.assertions} | ${fmt(r.status)} | ${r.manifest === '(none)' ? '-' : fmt(r.anchored)} | ${SEVERITY_LABEL[r.severity]} |`),
  '',
  `**${rows.length} assets. ${written} carry Content Credentials, ${noCredentials} do not.**`,
  '',
  ...Object.keys(SEVERITY_LABEL).map((k) => {
    const n = rows.filter((r) => r.severity === k).length
    return n === 0 ? null : `- ${n} ${SEVERITY_LABEL[k]}`
  }).filter(Boolean),
  ''
].join('\n')

fs.writeFileSync(path.join(CORPUS, 'REFERENCE-NOTES.md'), notes)

/*
 * reference-corpus.html: every asset on one page next to its verdict.
 *
 * index.html is deliberately left alone. Three e2e specs count badges on it
 * (auto-scan-default-off, no-credentials-no-badge, cr-click), and changing the
 * asset count under them would turn a green gate into a meaningless one.
 */
const GROUPS = [
  {
    prefix: 'c2pa-official/',
    title: 'C2PA public test files',
    source: 'https://spec.c2pa.org/public-testfiles/',
    note: 'The conformance corpus. The adobe-20220124-* names encode the construction: C a claim, A a parent asset, I an ingredient, and E-sig / E-clm / E-dat / E-uri a deliberately broken signature, claim, data hash or URI reference. The E-* and X* assets are the ones that must come back red.'
  },
  {
    prefix: 'cai-example-assets/',
    title: 'CAI example assets',
    source: 'https://contentauth.github.io/example-assets/',
    note: 'Content Authenticity Initiative sample media, including generative output from Firefly, ChatGPT and Sora that should surface an AI-origin declaration.'
  },
  {
    prefix: 'iptc-vmh/',
    title: 'IPTC Video Metadata Hub',
    source: 'https://iptc.org/standards/video-metadata-hub/',
    note: 'Video assertions: minimal and maximal VMH payloads, a generator assertion, and the uncredentialed original for contrast.'
  },
  {
    prefix: '',
    title: 'Curated fixtures',
    source: '',
    note: 'The eight hand-built fixtures the e2e suite asserts against. Deliberately not all green: 04 is an untrusted signer, 05 has tampered pixels, 06 carries no credentials at all, and 08 is the only asset in the whole corpus that the Trusteddit anchors actually validate.'
  }
]

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const VIDEO_RE = /\.(mp4|mov)$/i
const PDF_RE = /\.pdf$/i
const used = new Set()
const sections = []

for (const g of GROUPS) {
  const members = rows.filter((r) => !used.has(r.rel) && r.rel.startsWith(g.prefix))
  members.forEach((r) => used.add(r.rel))
  if (members.length === 0) continue

  const cards = members.map((r) => {
    const media = VIDEO_RE.test(r.rel)
      ? `<video src="${esc(r.rel)}" controls preload="metadata"></video>`
      : PDF_RE.test(r.rel)
        ? `<a class="pdf" href="${esc(r.rel)}">PDF<br>${esc(path.basename(r.rel))}</a>`
        : `<img src="${esc(r.rel)}" alt="${esc(r.rel)}" loading="lazy">`
    const codeList = (codes) => codes.length === 0
      ? '<span class="clean">clean</span>'
      : codes.map((c) => esc(c)).join('<br>')
    const verdicts = r.severity === 'none'
      ? '<div class="row"><span class="k">c2patool</span><span class="v">no Content Credentials</span></div>'
      : `<div class="row"><span class="k">bare</span><span class="v">${codeList(r.status)}</span></div>
          <div class="row"><span class="k">anchored</span><span class="v">${codeList(r.anchored)}</span></div>`
    const jsonLink = r.manifest === '(none)'
      ? '<span class="dim">no manifest to read</span>'
      : `<a href="${esc(r.manifest)}" target="_blank">reference JSON</a>`
    return `      <figure class="asset">
        ${media}
        <figcaption>
          <code class="name">${esc(path.basename(r.rel))}</code>
          <div class="chip ${r.severity}">${esc(SEVERITY_LABEL[r.severity])}</div>
          <div class="meta">${esc(r.generator || 'no claim generator')}</div>
          <div class="meta">${r.ingredients} ingredient(s), ${r.assertions} assertion(s)${r.aiTrained ? ' &middot; <b>AI declared</b>' : ''}</div>
          <div class="verdicts">${verdicts}</div>
          <div class="links">${jsonLink}</div>
        </figcaption>
      </figure>`
  }).join('\n')

  sections.push(`    <section>
      <h2>${esc(g.title)} <span class="count">${members.length} assets</span></h2>
      ${g.source !== '' ? `<p class="src">Source: <a href="${esc(g.source)}" target="_blank">${esc(g.source)}</a></p>` : ''}
      <p class="note">${esc(g.note)}</p>
      <div class="grid">
${cards}
      </div>
    </section>`)
}

const tally = Object.keys(SEVERITY_LABEL)
  .map((k) => ({ k, n: rows.filter((r) => r.severity === k).length }))
  .filter((t) => t.n > 0)
  .map((t) => `<span class="chip ${t.k}">${t.n} ${esc(SEVERITY_LABEL[t.k])}</span>`)
  .join(' ')

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reference corpus - Verifieddit vs c2patool</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #1e293b; }
  h1 { margin: 0 0 6px; font-size: 22px; }
  h2 { font-size: 16px; margin: 34px 0 4px; }
  .count { font-weight: 400; color: #64748b; font-size: 13px; }
  .src, .note, .lede { margin: 4px 0; font-size: 13px; color: #475569; max-width: 92ch; line-height: 1.5; }
  .lede { font-size: 14px; color: #334155; }
  .tally { margin: 14px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 16px; margin: 14px 0 0; }
  .asset { margin: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  .asset img, .asset video { width: 100%; height: 170px; object-fit: contain; background: #f1f5f9; border-radius: 4px; display: block; }
  .pdf { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 170px; background: #f1f5f9; border-radius: 4px; font-size: 12px; text-align: center; }
  figcaption { margin-top: 8px; }
  .name { font-size: 12px; font-weight: 600; word-break: break-all; display: block; }
  .chip { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .chip.good    { background: #dcfce7; color: #166534; }
  .chip.warn    { background: #fef3c7; color: #92400e; }
  .chip.expired { background: #ffedd5; color: #9a3412; }
  .chip.bad     { background: #fee2e2; color: #991b1b; }
  .chip.none    { background: #f1f5f9; color: #475569; }
  .meta { font-size: 11px; color: #64748b; margin-top: 4px; word-break: break-word; }
  .verdicts { margin-top: 7px; border-top: 1px solid #f1f5f9; padding-top: 6px; }
  .row { display: flex; gap: 6px; font-size: 10.5px; margin-top: 3px; }
  .k { flex: 0 0 58px; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; }
  .v { font-family: ui-monospace, SFMono-Regular, monospace; color: #334155; }
  .clean { color: #166534; font-weight: 600; }
  .links { margin-top: 7px; font-size: 12px; }
  .dim { color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
  <h1>Reference corpus</h1>
  <p class="lede">
    ${rows.length} assets, each paired with the manifest <strong>c2patool</strong> reads from it.
    c2patool is the c2pa-rs reference implementation, so where the extension's badge
    disagrees with the JSON linked here, the reference is right and the extension is
    wrong until proven otherwise.
  </p>
  <p class="lede">
    Every asset is read twice, because a C2PA verdict is not a property of the file alone.
    <b>Bare</b> is c2patool with no trust anchors: hashes, signature, claim structure.
    Every signer reads <code>signingCredential.untrusted</code> there, ours included,
    because there is nothing to trust against, so ignore that one code in that row.
    <b>Anchored</b> re-runs the check against the public Trusteddit anchors, which
    answers the separate question of whether the signer is one we recognise.
  </p>
  <p class="lede">
    <b>Neither row is the extension's answer.</b> Verifieddit ships six trust lists and
    82 entities, including the CAI known-certificate anchors, so it recognises signers
    these anchors alone do not. Expect it to be <i>more</i> permissive on the Adobe,
    Truepic and CAI assets. What it must never do is disagree on the integrity codes:
    a <span class="chip bad">integrity failure</span> here has to be an error there.
  </p>
  <p class="tally">${tally}</p>
  <p class="lede">
    Summary table: <a href="REFERENCE-NOTES.md">REFERENCE-NOTES.md</a> &middot;
    The curated 8-fixture page the e2e suite asserts against: <a href="index.html">index.html</a>
  </p>
${sections.join('\n')}
</body>
</html>
`

fs.writeFileSync(path.join(CORPUS, 'reference-corpus.html'), html)

console.log(`\n${rows.length} assets, ${written} manifests written, ${noCredentials} without credentials`)
for (const k of Object.keys(SEVERITY_LABEL)) {
  const n = rows.filter((r) => r.severity === k).length
  if (n > 0) console.log(`  ${String(n).padStart(3)} ${SEVERITY_LABEL[k]}`)
}
console.log(`notes: ${path.join(CORPUS, 'REFERENCE-NOTES.md')}`)
console.log(`page:  ${path.join(CORPUS, 'reference-corpus.html')}`)
