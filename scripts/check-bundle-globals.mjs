#!/usr/bin/env node
/*
 * Refuse to ship a script that reads a Node global the browser does not have.
 *
 * `global.x` and `global[x]` throw "global is not defined" in a browser unless
 * the build put a definition in front of them. rollup-plugin-node-polyfills is
 * meant to, and silently does not when node_modules is a symlink into another
 * checkout: that is how 1.4.1 shipped dead on arrival. A correct build rewrites
 * every such read to a local name, so in shipped output any read that is left
 * is a defect. `typeof global` on its own is safe and is left alone.
 *
 * Usage: node scripts/check-bundle-globals.mjs <dir> [<dir>...]
 * Exit code 0 = clean, 1 = at least one script would throw, 2 = bad invocation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const READ = /(?<![.\w$])global(?:\.[A-Za-z_$][\w$]*|\[)/g

/** Every unshimmed read of `global` in one script, in source order. */
export function unshimmedGlobals (code) {
  return code.match(READ) ?? []
}

function scripts (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...scripts(full))
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out.sort()
}

/** `{ file, reads }` for every script under `dir` that would throw. */
export function scanDir (dir) {
  const bad = []
  for (const file of scripts(dir)) {
    const reads = unshimmedGlobals(fs.readFileSync(file, 'utf8'))
    if (reads.length > 0) bad.push({ file: path.relative(dir, file), reads: [...new Set(reads)] })
  }
  return bad
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2)
  if (dirs.length === 0) {
    console.error('usage: check-bundle-globals.mjs <dir> [<dir>...]')
    process.exit(2)
  }
  let failed = false
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      console.error(`✗ ${dir} does not exist`)
      process.exit(2)
    }
    const bad = scanDir(dir)
    if (bad.length === 0) {
      console.log(`  OK: no script in ${dir} reads an undefined Node global.`)
      continue
    }
    failed = true
    console.error(`✗ ${dir}: these scripts would stop with "global is not defined":`)
    for (const { file, reads } of bad) console.error(`    ${file}: ${reads.join(', ')}`)
  }
  if (failed) {
    console.error('  Build from a checkout with its own node_modules (bun install --frozen-lockfile), never a symlinked one.')
    process.exit(1)
  }
}
