/*
 * Sync the bundled trust anchors with the official C2PA Conformance Program lists.
 *
 *   bun scripts/sync-c2pa-trust-lists.ts [--from <dir>] [--check]
 *
 * Source of truth is the C2PA conformance repo:
 *   trust-list/C2PA-TRUST-LIST.pem      -> src/trust-anchors/default-trust-list.json
 *   trust-list/C2PA-TSA-TRUST-LIST.pem  -> src/trust-anchors/default-tsa-trust-list.json
 *
 * Plus the CAI known-certificate anchors (what Adobe's own Verify trusts):
 *   https://contentcredentials.org/trust/anchors.pem -> src/trust-anchors/cai-known-anchors.json
 *
 * The conformance list alone is NOT sufficient: as of 2026-09-01 it carries a
 * single Adobe cert (the vault-a-or2 issuing CA) while real Photoshop, Firefly
 * and Lightroom output chains through Adobe Product Services G3/G4 to
 * Adobe Root CA G2 - which only the CAI anchors list contains. Shipping only
 * the conformance list made every legitimate Adobe-signed asset render as
 * valid-but-untrusted.
 *
 * Why this exists: the bundled default list was hand-maintained and drifted.
 * As of 2026-08-01 it carried 18 of the 29 official anchors, so assets signed by
 * eleven conformant CAs (Huawei, Huanyu, Verimago, Snowball, Encypher,
 * TrustAsia, RealReel) rendered as valid-but-untrusted. `download_url` is empty
 * on that list, so the runtime auto-refresh never repaired it — only a rebuild
 * can. A generator plus a `--check` gate makes the drift impossible to miss.
 *
 * `--check` exits non-zero when the committed JSON differs from what the PEMs
 * imply, so CI can fail on drift instead of shipping a stale trust list.
 */

import { X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = 'https://raw.githubusercontent.com/Sanmarcsoft/c2pa-org-conformance-public/main'
const CAI_ANCHORS_URL = 'https://contentcredentials.org/trust/anchors.pem'
const ANCHOR_DIR = resolve(import.meta.dir, '..', 'src', 'trust-anchors')

/** Matches LOCAL_TRUST_TSA_LIST_NAME in src/constants.ts — checkTSATrustListInclusion filters on it. */
const TSA_LIST_NAME = 'Local TSA Anchors'

interface Jwk { kty: string, x5c: string[] }
interface TrustedEntity {
  name: string
  display_name: string
  contact: string
  isCA: boolean
  jwks: { keys: Jwk[] }
}
interface TrustList {
  name: string
  download_url: string
  description: string
  website: string
  last_updated: string
  entities: TrustedEntity[]
}

/** Split a PEM bundle into individual certificate blocks. */
function splitPem (pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
}

/** Base64 DER body of a PEM block, newlines stripped — the x5c wire form. */
function toX5c (pemBlock: string): string {
  return pemBlock.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
}

/**
 * Parse an RFC 4514-ish subject into its RDN components. Node renders the
 * subject one RDN per line; values may contain escaped commas.
 */
function subjectParts (cert: X509Certificate): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of cert.subject.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/\\,/g, ',')
  }
  return out
}

/** "Google LLC - Google C2PA Media Services 1P ICA G3" — org-qualified, like the hand-written list. */
function entityName (cert: X509Certificate): { name: string, display: string } {
  const p = subjectParts(cert)
  const cn = p.CN ?? '(no CN)'
  const org = p.O ?? ''
  return { name: org !== '' && org !== cn ? `${org} - ${cn}` : cn, display: cn }
}

function buildTrustList (pem: string, meta: Omit<TrustList, 'entities'>): TrustList {
  const entities: TrustedEntity[] = []
  const seen = new Set<string>()

  for (const block of splitPem(pem)) {
    const x5c = toX5c(block)
    if (seen.has(x5c)) continue
    seen.add(x5c)

    const cert = new X509Certificate(block)
    const { name, display } = entityName(cert)
    entities.push({
      name,
      display_name: display,
      contact: 'https://c2pa.org',
      isCA: cert.ca,
      jwks: { keys: [{ kty: cert.publicKey.asymmetricKeyType === 'ec' ? 'EC' : 'RSA', x5c: [x5c] }] }
    })
  }

  entities.sort((a, b) => a.name.localeCompare(b.name))
  return { ...meta, entities }
}

async function loadPem (name: string, fromDir: string | null): Promise<string> {
  // The CAI anchors are not in the conformance repo; a --from dir may still
  // override them (trust-list/anchors.pem) for offline runs.
  if (fromDir != null) {
    const p = join(fromDir, 'trust-list', name)
    if (existsSync(p)) return await readFile(p, 'utf8')
    if (name !== 'anchors.pem') throw new Error(`missing ${p}`)
  }
  const url = name === 'anchors.pem' ? CAI_ANCHORS_URL : `${REPO}/trust-list/${name}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`)
  return await res.text()
}

async function main (): Promise<void> {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const fromIdx = argv.indexOf('--from')
  let fromDir = fromIdx >= 0 ? argv[fromIdx + 1] : null
  let cloned: string | null = null

  // No local checkout given: shallow-clone the conformance repo so --check works
  // offline-ish in CI without pinning raw.githubusercontent availability twice.
  if (fromDir == null && check) {
    cloned = await mkdtemp(join(tmpdir(), 'c2pa-conf-'))
    const proc = Bun.spawn(['git', 'clone', '--depth', '1', '--quiet',
      'https://github.com/Sanmarcsoft/c2pa-org-conformance-public.git', cloned])
    if (await proc.exited !== 0) throw new Error('clone of the conformance repo failed')
    fromDir = cloned
  }

  try {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

    const targets: Array<[string, string, Omit<TrustList, 'entities'>]> = [
      ['C2PA-TRUST-LIST.pem', 'default-trust-list.json', {
        name: 'C2PA Trust List',
        download_url: '',
        description: 'Official C2PA trust anchors, generated from trust-list/C2PA-TRUST-LIST.pem in Sanmarcsoft/c2pa-org-conformance-public. Do not edit by hand — run bun scripts/sync-c2pa-trust-lists.ts.',
        website: 'https://github.com/Sanmarcsoft/c2pa-org-conformance-public',
        last_updated: stamp
      }],
      ['anchors.pem', 'cai-known-anchors.json', {
        name: 'CAI Known Certificates',
        download_url: '',
        description: 'CAI known-certificate anchors (contentcredentials.org/trust/anchors.pem), the list the Content Credentials Verify site trusts. Carries the production roots (Adobe Root CA G2, Leica, Nikon, Canon, Sony, Microsoft, Truepic) absent from the conformance list. Do not edit by hand - run bun scripts/sync-c2pa-trust-lists.ts.',
        website: 'https://contentcredentials.org/verify',
        last_updated: stamp
      }],
      ['C2PA-TSA-TRUST-LIST.pem', 'default-tsa-trust-list.json', {
        name: TSA_LIST_NAME,
        download_url: '',
        description: 'Official C2PA TSA trust anchors, generated from trust-list/C2PA-TSA-TRUST-LIST.pem in Sanmarcsoft/c2pa-org-conformance-public. Named "Local TSA Anchors" so checkTSATrustListInclusion picks it up. Do not edit by hand.',
        website: 'https://github.com/Sanmarcsoft/c2pa-org-conformance-public',
        last_updated: stamp
      }]
    ]

    let drift = false
    for (const [pemName, jsonName, meta] of targets) {
      const list = buildTrustList(await loadPem(pemName, fromDir), meta)
      const outPath = join(ANCHOR_DIR, jsonName)
      const next = JSON.stringify(list, null, 2) + '\n'

      if (check) {
        // last_updated is a build stamp, not content — compare anchors only.
        const prevRaw = existsSync(outPath) ? await readFile(outPath, 'utf8') : '{"entities":[]}'
        const prev = JSON.parse(prevRaw) as TrustList
        const a = JSON.stringify(prev.entities ?? [])
        const b = JSON.stringify(list.entities)
        if (a !== b) {
          drift = true
          console.error(`DRIFT ${jsonName}: committed ${prev.entities?.length ?? 0} anchors, official ${list.entities.length}`)
        } else {
          console.log(`ok ${jsonName}: ${list.entities.length} anchors in sync`)
        }
        continue
      }

      await writeFile(outPath, next)
      console.log(`wrote ${jsonName}: ${list.entities.length} anchors`)
    }

    if (check && drift) {
      console.error('\nTrust anchors are stale. Run: bun scripts/sync-c2pa-trust-lists.ts')
      process.exit(1)
    }
  } finally {
    if (cloned != null) await rm(cloned, { recursive: true, force: true })
  }
}

await main()
