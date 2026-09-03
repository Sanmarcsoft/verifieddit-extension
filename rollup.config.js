/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import alias from '@rollup/plugin-alias'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import resolve from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import terser from '@rollup/plugin-terser'
import 'dotenv/config'
import { ESLint } from 'eslint'
import path, { dirname } from 'path'
import copy from 'rollup-plugin-copy'
import nodePolyfills from 'rollup-plugin-node-polyfills'
import typescript from 'rollup-plugin-typescript2'
import { fileURLToPath } from 'url'

// Get the directory name when using ESM
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(fileURLToPath(import.meta.url))

/*
  - Build 2 bundles in the dist/chrome folder with supporting files:
    - background.js
    - content.js
    - popup.js
    - options.js (optional)

  - Copy the dist/chrome folder to dist/firefox

  - Copy the browser-specific manifest.json files to their respective folders

  Occasionally, when running rollup, you may get an error like this from rollup-plugin-typescript2:
  [!] (plugin rpt2) Error: EPERM: operation not permitted, rename

  Re-running rollup seems to fix it.
  I did not see a cause/solution at https://github.com/ezolenko/rollup-plugin-typescript2/issues

*/

const DEBUG = process.env.NODE_ENV?.toUpperCase() !== 'PRODUCTION'

const COPYRIGHT = `/*!
*  Copyright (c) Microsoft Corporation.
*  Licensed under the MIT license.
*/`

/*
  Common output options for each bundle
*/
const output = {
  // in debug, we want to see the sourcemap inline to let chrome dev tools debug through the original TS source
  // using separate source map files is blocked by chrome for some reason and requires user interaction to enable
  sourcemap: DEBUG ? 'inline' : false,
  // Put the webextension-polyfill code in a separate file
  // manualChunks: { "webextension-polyfill": ["webextension-polyfill"], },

  // TODO: don't add copyright to webextension-polyfill.js
  // TODO: for now this separate bundle will be webextension-polyfill, in the future it may contain additional polyfills
  chunkFileNames: 'chunk-[name]-[hash].js',

  // put a copyright banner at the top of the bundle
  banner: DEBUG ? undefined : COPYRIGHT
}

/*
  Files to watch for changes and recompile the bundle
*/
const watch = {
  include: ['src/**', '.env', 'public/**'],
  clearScreen: true
}

/*
  Common plugin options for each bundle
  - replace variables from .env with their values since the browser cannot access .env
  - bundle node modules (resolve)
  - convert commonjs modules to esm (commonjs)
  - minify the production bundle (terser)
  - compile typescript to javascript (typescript)

  `target` inlines process.env.BROWSER_TARGET so browser-specific branches fold
  away at build time instead of merely being skipped at runtime. Firefox has no
  chrome.offscreen API at all, and AMO's validator reports every *textual*
  reference to it as UNSUPPORTED_API even when the call is guarded — so the
  Gecko bundle has to be free of the identifier, not just of the behaviour.
*/
const makePlugins = (target) => [
  replace({
    preventAssignment: true,
    // #121: only inline an explicit allowlist of env vars. Spreading the whole
    // process.env would bake the build machine's secrets (tokens, paths) into
    // the public CRX. Never add a secret-bearing var here.
    ...['NODE_ENV', 'AUTO_SCAN', 'TRUST_DEV_FIXTURES'].reduce((acc, key) => {
      acc[`process.env.${key}`] = JSON.stringify(process.env[key] ?? '')
      return acc
    }, {}),
    'process.env.BROWSER_TARGET': JSON.stringify(target)
  }),
  json(),
  resolve({ browser: true }),
  commonjs(),
  nodePolyfills(),
  // minify the bundle in production
  !DEBUG &&
  terser({
    output: {
      comments: function (node, comment) {
        // remove all comment except those starting with '!'
        return comment.value.startsWith('!')
      }
    }
  }),
  typescript({ tsconfig: 'tsconfig.json' }),
  {
    /*
      This will allow the watch command to recompile the bundle when these files change.
      Rollup, by default, will only watch the entry file and its imports.
      Note: the files below must also be included in the watch.include paths array above
    */
    /** TODO: Add public folder */
    name: 'watch-json',
    buildStart () {
      [
        '.env',
        'src/manifest.chrome.v3.json',
        'src/manifest.firefox.v3.json',
        'public/options.css',
        'public/options.html',
        'public/popup.css',
        'public/popup.html'
      ].forEach((file) => {
        this.addWatchFile(path.resolve(__dirname, file))
      })
    }
  }
  // eslint()
]

/*
  Common error handler for each bundle
*/
const onwarn = (warning, warn) => {
  // suppress circular dependency warnings in production
  if (warning.code === 'CIRCULAR_DEPENDENCY' && !DEBUG) return
  warn(warning)
}

/*
  Tree-shaking policy.

  `moduleSideEffects: []` declares that NO module has side effects, so rollup
  drops every bare `import './x'`. Our Lit components register themselves with
  `customElements.define` at module scope, and that registration IS the side
  effect. Drop the module and the custom tag is never defined: it still parses,
  still accepts JS properties, and renders nothing at all — no shadow root, no
  error, no fallback. That is exactly how <c2pa-provenance-graph> shipped inert
  (#140): webComponents.js kept the template `<c2pa-provenance-graph .graph=…>`
  while every byte of provenanceDiagram.ts was shaken out of the bundle.

  Components declared inside an entry module were never affected, which is why
  this only bit the one component extracted to its own file.

  Keep side effects for our own sources; node_modules stay aggressively shaken.
*/
const treeshake = { moduleSideEffects: (id) => /[\\/]src[\\/]/.test(id) }

/*
  background.js (Chrome v3)
*/
const backgroundC = {
  input: ['src/background.ts', 'src/popup.ts', 'src/options.ts', 'src/c2pa.ts', 'src/overlayFrame.ts', 'src/webComponents.ts', 'src/components/toggle.ts'],
  treeshake,
  output: {
    dir: 'dist/chrome',
    format: 'esm',
    ...output
  },
  watch,
  plugins: [
    copy({
      targets: [
        { src: 'public/*', dest: 'dist/chrome' },
        { src: 'node_modules/@contentauth/c2pa-web/dist/resources/c2pa_bg.wasm', dest: 'dist/chrome', rename: 'c2pa.wasm' },
        { src: 'dist/chrome', dest: 'dist', rename: 'firefox' },
        { src: 'src/manifest.chrome.v3.json', dest: 'dist/chrome', rename: 'manifest.json' },
        { src: 'src/manifest.firefox.v3.json', dest: 'dist/firefox', rename: 'manifest.json' }
      ],
      // Wait for the bundle to be written to disk before copying the files, otherwise the firefox folder will be empty
      hook: 'writeBundle'
    }),
    ...makePlugins('chrome')
  ],
  onwarn
}

/*
  background.js (Firefox v3)
*/
const backgroundFF = {
  input: ['src/background.ts'],
  treeshake,
  output: {
    dir: 'dist/firefox',
    format: 'esm',
    ...output
  },
  watch,
  plugins: [
    alias({
      entries: [
        { find: './c2paProxy', replacement: './c2pa' }
      ]
    }),
    ...makePlugins('firefox')
  ],
  onwarn
}

/*
  content.js
*/
const content = {
  input: 'src/content.ts',
  treeshake,
  output: {
    file: 'dist/chrome/content.js',
    format: 'iife', // always iife as this code is injected into the tab and not imported
    ...output
  },
  watch,
  plugins: makePlugins('chrome'),
  onwarn
}

/*
  inject.js
*/
const inject = {
  input: 'src/inject.ts',
  treeshake,
  output: {
    file: 'dist/chrome/inject.js',
    name: 'inject',
    format: 'iife', // always iife as this code is injected into the tab and not imported
    ...output
  },
  watch,
  plugins: makePlugins('chrome'),
  onwarn
}

export default [content, inject, backgroundC, backgroundFF]

// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
function eslint (options = {}) {
  const eslint = new ESLint({ fix: true, ignore: false, ...options })
  return {
    name: 'rollup-plugin-eslint',
    async writeBundle () {
      const results = await eslint.lintFiles(['dist/chrome/**/*.js']) // Adjust the glob pattern to match your files
      await ESLint.outputFixes(results)
    }
  }
}
