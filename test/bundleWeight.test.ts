/**
 * Bundle weight guard.
 *
 * M directive 2026-09-07: test images may live in this repo, but must never be
 * bundled into the shipped extension. test/media and test/fixtures are ~57 MB of
 * photos and video; the Chrome Web Store package must stay logic + icons + WASM.
 *
 * Two independent checks, so a regression is caught even before a build:
 *   1. rollup.config.js copies only public/, the WASM and the manifests
 *   2. if dist/ exists, it contains no photo or video files
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const MEDIA_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm', '.avi']
// Icons and UI art are legitimately shipped; photo/video fixtures are not.
const FIXTURE_EXT = ['.jpg', '.jpeg', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm', '.avi']

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

describe('media extension list', () => {
  it('covers the formats the sample dataset uses', () => {
    for (const ext of ['.jpg', '.png', '.webp', '.mp4']) {
      expect(MEDIA_EXT).toContain(ext)
    }
  })
})
