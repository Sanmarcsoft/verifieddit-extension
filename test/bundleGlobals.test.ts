/**
 * Node-global guard.
 *
 * 1.4.1 was published with a bundle that read `global.setTimeout` at the top of
 * a shared chunk. A browser has no `global`, so the background script, the
 * validator and the page script all stopped on their first line: "Uncaught
 * ReferenceError: global is not defined" (reported by M, 2026-10-06).
 *
 * The source was fine and every test passed. The release was built in a
 * checkout whose node_modules was a symlink to another checkout, and with that
 * layout rollup-plugin-node-polyfills leaves `global` unshimmed without any
 * warning. The tests ran against a different build, so nothing looked at the
 * files that shipped.
 *
 * So the check is on the output, not the source: a shipped script may use
 * `global` only where the build has also defined it.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { unshimmedGlobals, scanDir } from '../scripts/check-bundle-globals.mjs'

const repoRoot = join(import.meta.dir, '..')

// The first lines of the chunk that shipped in 1.4.1, and of the same chunk
// from a correct build.
const BROKEN = 'import{a as t}from"./chunk-a.js";function r(){}var l=r,p=r;"function"==typeof global.setTimeout&&(l=setTimeout),"function"==typeof global.clearTimeout&&(p=clearTimeout);var _=global.performance||{};'
const GOOD = 'import{a as t}from"./chunk-a.js";var e="undefined"!=typeof global?global:"undefined"!=typeof self?self:"undefined"!=typeof window?window:{};function r(){}var i=r,s=r;"function"==typeof e.setTimeout&&(i=setTimeout);var _=e.performance||{};'

describe('shipped scripts never read a Node global the browser lacks', () => {
  it('flags the chunk that shipped in 1.4.1', () => {
    expect(unshimmedGlobals(BROKEN)).toEqual(['global.setTimeout', 'global.clearTimeout', 'global.performance'])
  })

  it('accepts the same chunk from a correct build', () => {
    expect(unshimmedGlobals(GOOD)).toEqual([])
  })

  it('does not mistake a property or a longer name for the global', () => {
    expect(unshimmedGlobals('a.global.x=1;var myglobal={};myglobal.y=2;$global.z=3')).toEqual([])
  })

  it('flags an index read as well as a member read', () => {
    expect(unshimmedGlobals('var p=global["process"]')).toEqual(['global['])
  })

  it('leaves the bare existence test alone, which cannot throw', () => {
    expect(unshimmedGlobals('var g="undefined"!=typeof global?global:self')).toEqual([])
  })

  for (const target of ['chrome', 'firefox']) {
    const dir = join(repoRoot, 'dist', target)
    it.skipIf(!existsSync(dir))(`dist/${target} is clean`, () => {
      expect(scanDir(dir)).toEqual([])
    })
  }
})
