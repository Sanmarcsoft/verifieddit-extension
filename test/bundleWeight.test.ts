/**
 * Bundle weight guard.
 *
 * M directive 2026-09-07, restated after the reference corpus landed: test data
 * may live in this repo, but must never be bundled into the shipped extension.
 * test/media and test/fixtures are now ~121 MB of photos, video, audio and PDFs;
 * the Chrome Web Store package must stay logic + icons + WASM.
 *
 * Four independent checks, so a regression is caught before anything is uploaded:
 *   1. rollup.config.js copies only public/, the WASM and the manifests
 *   2. public/ is copied verbatim, so it must hold no fixtures either
 *   3. if dist/ exists, it contains no fixture media and stays under the ceiling
 *   4. the AMO source archive's allowlist excludes test/
 *
 * Check 4 exists because the source zip is the one shipped artifact built from an
 * allowlist rather than from dist/. Adding 'test' to that array would send the
 * whole corpus to Mozilla without touching rollup or dist at all, so neither of
 * the other checks would notice.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const MEDIA_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm', '.avi']
/*
 * Icons and UI art are legitimately shipped, so .png and .svg are deliberately
 * absent from this list. Everything else the corpus contains is a fixture format:
 * the C2PA reference assets include PDFs, AVIF, GIF and audio, none of which the
 * extension has any reason to carry.
 */
const FIXTURE_EXT = [
  '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.avif', '.gif', '.tif', '.tiff', '.dng',
  '.mp4', '.mov', '.webm', '.avi',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg',
  '.pdf'
]

function walk (dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe('shipped bundle carries no test media', () => {
  it('rollup copy targets never reference test/', () => {
    const config = readFileSync(join(repoRoot, 'rollup.config.js'), 'utf8')
    const copyBlock = config.match(/copy\(\{[\s\S]*?\}\)/)
    expect(copyBlock, 'Could not find the copy({...}) plugin block in rollup.config.js').toBeTruthy()
    expect(
      copyBlock![0],
      'rollup must not copy test/ into the bundle. Test images stay in the repo for development ' +
      'and E2E only; the shipped extension must remain logic + icons + WASM.'
    ).not.toContain('test/')
  })

  it('public/ holds no photo or video fixtures', () => {
    const offenders = walk(join(repoRoot, 'public'))
      .filter((f) => FIXTURE_EXT.includes(extname(f).toLowerCase()))
    expect(
      offenders,
      'public/ is copied verbatim into the bundle, so photo/video fixtures placed there ship to users.'
    ).toEqual([])
  })

  const distDir = join(repoRoot, 'dist')
  const distExists = existsSync(distDir)

  it.skipIf(!distExists)('built dist/ holds no photo or video fixtures', () => {
    const offenders = walk(distDir)
      .filter((f) => FIXTURE_EXT.includes(extname(f).toLowerCase()))
      .map((f) => f.slice(repoRoot.length + 1))
    expect(offenders, 'These media files would ship in the extension package.').toEqual([])
  })

  it('no single public/ file is heavy enough to be an unreferenced asset', () => {
    /*
     * public/ is copied verbatim into both browser targets, so a heavy file here
     * ships twice. The cause of this check: icons/Verifieddit_logo.png, a 1.29 MB
     * 1024x1024 master byte-identical to the repo-root copy, referenced by nothing.
     * Every runtime icon load names an .svg or a vd{16,32,48,128}.png, and the
     * manifest declares only the vd sizes. It was costing users 2.58 MB across the
     * two targets for an asset no code path could reach.
     *
     * The ceiling is deliberately far above the real maximum (c2pa-web.worker.js at
     * ~37 KB) so it flags a master-artwork mistake rather than policing normal churn.
     */
    const LIMIT = 256 * 1024
    const heavy = walk(join(repoRoot, 'public'))
      .map((f) => [f.slice(repoRoot.length + 1), statSync(f).size] as const)
      .filter(([, size]) => size > LIMIT)
    expect(
      heavy,
      'Files this large in public/ are usually source artwork that belongs in the ' +
      'repo root, not in the shipped bundle. Reference the sized icons instead.'
    ).toEqual([])
  })

  it.skipIf(!distExists)('built dist/ stays under 30 MB', () => {
    const bytes = walk(distDir).reduce((sum, f) => sum + statSync(f).size, 0)
    const mb = bytes / 1024 / 1024
    expect(
      mb,
      `dist/ is ${mb.toFixed(1)} MB. It is dominated by c2pa.wasm (~8 MB per browser target); ` +
      'a large jump usually means test assets leaked into the copy targets.'
    ).toBeLessThan(30)
  })
})

describe('AMO source archive excludes test data', () => {
  const packager = readFileSync(join(repoRoot, 'scripts', 'package-firefox.mjs'), 'utf8')

  it('builds the source zip from an explicit allowlist', () => {
    // If this stops being an allowlist the rest of the block cannot protect anything.
    expect(
      packager,
      'package-firefox.mjs must keep building the source archive from a named list of paths.'
    ).toContain('const sourceEntries = [')
  })

  it('the allowlist does not include test/', () => {
    const list = packager.match(/const sourceEntries = \[([\s\S]*?)\]/)
    expect(list, 'Could not find the sourceEntries array.').toBeTruthy()
    const entries = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(entries.length, 'sourceEntries parsed as empty.').toBeGreaterThan(0)
    expect(
      entries.filter((e) => e === 'test' || e.startsWith('test/')),
      'The AMO source archive would carry test/media and test/fixtures (~121 MB). ' +
      'Reviewers need the sources that build the add-on, not the corpus.'
    ).toEqual([])
  })
})

describe('media extension list', () => {
  it('covers the formats the sample dataset uses', () => {
    for (const ext of ['.jpg', '.png', '.webp', '.mp4']) {
      expect(MEDIA_EXT).toContain(ext)
    }
  })
})
