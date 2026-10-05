import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import rollupConfig from '../rollup.config.js'

const repoRoot = join(import.meta.dir, '..')

function getOutputDirs (bundle: any): string[] {
  const outputs = Array.isArray(bundle.output) ? bundle.output : [bundle.output]
  return outputs.map((o: any) => o?.dir ?? o?.file ?? '')
}

function getInputs (bundle: any): string[] {
  if (Array.isArray(bundle.input)) return bundle.input
  if (typeof bundle.input === 'string') return [bundle.input]
  if (bundle.input != null && typeof bundle.input === 'object') return Object.values(bundle.input)
  return []
}

describe('Firefox browser target bundles', () => {
  it('includes popup.ts, options.ts, and background.ts as inputs in dist/firefox bundles', () => {
    const firefoxBundles = (rollupConfig as any[]).filter((bundle) => {
      const dirs = getOutputDirs(bundle)
      return dirs.some((dir) => dir.startsWith('dist/firefox'))
    })

    const allFirefoxInputs = new Set(firefoxBundles.flatMap(getInputs))

    expect(allFirefoxInputs.has('src/background.ts')).toBe(true)
    expect(allFirefoxInputs.has('src/popup.ts')).toBe(true)
    expect(allFirefoxInputs.has('src/options.ts')).toBe(true)
  })

  it('configures makePlugins("firefox") for all dist/firefox bundles targeting background, popup, or options', () => {
    const firefoxBundles = (rollupConfig as any[]).filter((bundle) => {
      const dirs = getOutputDirs(bundle)
      return dirs.some((dir) => dir.startsWith('dist/firefox'))
    })

    const targetInputs = ['src/popup.ts', 'src/options.ts', 'src/background.ts']

    for (const bundle of firefoxBundles) {
      const inputs = getInputs(bundle)
      if (targetInputs.some((target) => inputs.includes(target))) {
        const replacePlugin = bundle.plugins.flat().find((p: any) => p != null && p.name === 'replace')
        expect(replacePlugin).toBeDefined()
        const replaced = replacePlugin.transform.call({}, 'process.env.BROWSER_TARGET', 'test.js')
        const code = typeof replaced === 'object' ? replaced?.code : replaced
        expect(code).toBe('"firefox"')
      }
    }
  })

  it('declares the Firefox bundle inputs in rollup.config.js source text', () => {
    const configSource = readFileSync(join(repoRoot, 'rollup.config.js'), 'utf8')
    const ffMatch = configSource.match(/const backgroundFF = \{[\s\S]*?input:\s*\[([\s\S]*?)\]/)
    expect(ffMatch).not.toBeNull()
    const inputContent = ffMatch?.[1] ?? ''
    expect(inputContent).toContain('src/background.ts')
    expect(inputContent).toContain('src/popup.ts')
    expect(inputContent).toContain('src/options.ts')
  })
})
