/**
 * Provenance Graph Builder — c2pa-rs manifest store -> portable graph.
 *
 * TypeScript port of the canonical builder that verifieddit.com serves from
 * `api/lib/provenance-graph.js` and that trusteddit.com runs client-side as
 * `src/lib/c2pa/provenanceGraph.ts`. Same traversal, same node/edge semantics,
 * same Mermaid classes — so the extension, the site and the hub all agree on
 * what a provenance chain looks like. Do not fork the logic; sync it.
 *
 * The graph focuses on the provenance chain: each ingredient points into the
 * manifest that consumed it (edge ingredient -> manifest), labelled by the C2PA
 * relationship. Linked ingredients (those carrying their own active manifest)
 * recurse, so multi-generation edit chains render in full. Each manifest also
 * branches out to one node per assertion it carries, and a telemetry assertion
 * splits further into one node per sensor.
 *
 * DELIBERATE DIVERGENCE FROM THE HUB BUILD: the hub attaches the raw (16 KB-
 * capped) assertion payload as `node.data`. The extension does not. A C2paResult
 * is structured-cloned four times on its way from the offscreen document to the
 * overlay iframe (inject -> background -> content script -> overlay), and
 * inlining assertion blobs there is the same trap that already forced
 * SOURCE_INLINE_MAX_BYTES on the source thumbnail in c2pa.ts. The renderer only
 * ever reads `dataFields`, so only the flattened rows are carried.
 */

import type {
  ProvenanceDataField,
  ProvenanceEdge,
  ProvenanceGraph,
  ProvenanceNode,
  ProvenanceSigner,
  ProvenanceValidationItem,
  ProvenanceValidationState
} from './provenanceTypes.js'

/*
 * The input is an unvalidated JSON manifest store decoded from a stranger's
 * media file — every field is genuinely `unknown` until this module narrows it.
 * The traversal is written defensively against that (optional chaining,
 * Array.isArray guards, String() coercion), so `any` in and out of the small
 * text helpers is the honest type here rather than a shortcut.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** Strip characters that would break a Mermaid node label or inject markup. */
function sanitizeLabel (text: unknown): string {
  return String(text ?? '')
    .replace(/\\/g, '')
    .replace(/"/g, "'")
    .replace(/[<>{}[\]|#;`]/g, '')
    .replace(/[\n\r\t]/g, ' ')
    .trim()
}

/** Trim to a max length with an ellipsis. */
function truncate (text: unknown, max = 40): string {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** "image/jpeg" -> "JPEG", "video/mp4" -> "MP4". */
export function prettyMime (mime: string | null | undefined): string {
  if (mime == null || mime === '') return ''
  return (String(mime).split('/')[1] ?? String(mime)).toUpperCase().replace('+', ' ')
}

/**
 * Extract a short, human tool name from a manifest's claim generator.
 * e.g. "Adobe Photoshop 25.0" -> "Photoshop".
 */
export function extractToolName (manifest: any): string {
  const info = Array.isArray(manifest?.claim_generator_info) ? manifest.claim_generator_info[0] : null
  if (info?.name != null && info.name !== '') {
    return truncate(String(info.name).replace(/^(Adobe|Google|Microsoft|Apple|Samsung)\s+/i, ''), 24)
  }
  const cg = manifest?.claim_generator
  if (cg != null && cg !== '') {
    const parts = String(cg).split(/\s+/)
    for (let i = parts.length - 1; i >= 0; i--) {
      const name = parts[i].split('/')[0]
      if (name !== '' && !/^c2pa[-_]?(rs|js)?$/i.test(name)) return truncate(name, 24)
    }
    const first = parts[0]?.split('/')[0]
    if (first != null && first !== '') return truncate(first, 24)
  }
  return ''
}

/**
 * Codes that represent a HARD integrity failure (tampered content). Only these
 * make a node 'invalid'. Certificate-trust / timestamp issues are non-fatal —
 * the overlay treats them as valid-but-untrusted, so the graph must agree, else
 * a trusted file shows a red node that contradicts the overall verdict.
 */
const INTEGRITY_FAILURE_CODES = new Set([
  'assertion.dataHash.mismatch',
  'assertion.hashMismatch',
  'assertion.bmff.hashMismatch',
  'assertion.boxesHash.mismatch',
  'claim.signature.invalid',
  'manifest.integrity.failed'
])

/** True when a validation code denotes a hard integrity break. */
export function isIntegrityFailureCode (code: string | null | undefined): boolean {
  if (code == null || code === '') return false
  const c = String(code)
  return INTEGRITY_FAILURE_CODES.has(c) || /hashmismatch|hash\.mismatch|signature\.invalid|integrity\.failed/i.test(c)
}

/**
 * Classify a node's validation state from an ingredient's own validation data.
 * 'invalid' ONLY on a hard integrity failure (mirrors the overlay's verdict);
 * 'valid' when it carries a manifest; otherwise 'unsigned'.
 */
export function ingredientValidationState (ing: any): ProvenanceValidationState {
  const failures = ing?.validation_results?.activeManifest?.failure
  if (Array.isArray(failures) && failures.some((f: any) => isIntegrityFailureCode(f?.code))) {
    return 'invalid'
  }

  const vs = ing?.validation_status
  if (Array.isArray(vs) && vs.some((s: any) => isIntegrityFailureCode(s?.code))) {
    return 'invalid'
  }

  if (ing?.active_manifest != null && ing.active_manifest !== '') return 'valid'
  return 'unsigned'
}

/** Collect an ingredient's HARD integrity failures as {code, explanation}. */
function ingredientFailures (ing: any): ProvenanceValidationItem[] {
  const out: ProvenanceValidationItem[] = []
  const vr = ing?.validation_results?.activeManifest?.failure
  if (Array.isArray(vr)) {
    for (const f of vr) {
      if (isIntegrityFailureCode(f?.code)) out.push({ code: f.code ?? '', explanation: f.explanation ?? '' })
    }
  }
  const vs = ing?.validation_status
  if (Array.isArray(vs)) {
    for (const s of vs) {
      if (isIntegrityFailureCode(s?.code)) out.push({ code: s.code ?? '', explanation: s.explanation ?? '' })
    }
  }
  return out
}

/** Extract {issuer, alg, time} signer info from a manifest, or null. */
function signerOf (manifest: any): ProvenanceSigner | null {
  const si = manifest?.signature_info
  if (si == null) return null
  return {
    issuer: si.issuer ?? si.cert_issuer ?? null,
    alg: si.alg ?? null,
    time: si.time ?? si.date ?? null
  }
}

/** Assertion labels from a manifest. */
function assertionLabels (manifest: any): string[] {
  if (!Array.isArray(manifest?.assertions)) return []
  return manifest.assertions
    .map((a: any) => (typeof a?.label === 'string' ? a.label : ''))
    .filter((l: string) => l !== '')
}

/** Keys/labels that mark an assertion as sensor / telemetry data. */
const TELEMETRY_RE =
  /telemetry|sensor|imu|gyro|gyroscope|acceler|magnetom|barometer|gps|gnss|geoloc|location|orientation|motion|altitude|velocity|heading|lux|illuminance|temperature|pressure|exif/i

const MAX_ASSERTION_FIELDS = 40

/** Coarse shape of an assertion's data payload. */
function dataKindOf (data: unknown): string {
  if (Array.isArray(data)) return 'array'
  if (data !== null && typeof data === 'object') return 'object'
  if (data === null || data === undefined) return 'empty'
  return 'scalar'
}

/** Render a leaf value compactly for a key/value row. */
function shortValue (v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v)
      return s.length > 80 ? s.slice(0, 79) + '…' : s
    } catch {
      return '[object]'
    }
  }
  const s = String(v)
  return s.length > 120 ? s.slice(0, 119) + '…' : s
}

/**
 * Flatten an assertion's data into <= MAX_ASSERTION_FIELDS key/value rows
 * (dot-pathed one level deep) for compact diagram rendering.
 */
function flattenData (data: unknown, prefix: string, out: ProvenanceDataField[]): void {
  if (out.length >= MAX_ASSERTION_FIELDS) return
  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      if (out.length >= MAX_ASSERTION_FIELDS) return
      if (item !== null && typeof item === 'object') flattenData(item, `${prefix}[${i}]`, out)
      else out.push({ key: `${prefix}[${i}]`, value: shortValue(item) })
    })
  } else if (data !== null && typeof data === 'object') {
    for (const k of Object.keys(data as Record<string, unknown>)) {
      if (out.length >= MAX_ASSERTION_FIELDS) return
      const v = (data as Record<string, unknown>)[k]
      const key = prefix !== '' ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) flattenData(v, key, out)
      else out.push({ key, value: shortValue(v) })
    }
  } else if (prefix !== '') {
    out.push({ key: prefix, value: shortValue(data) })
  }
}

/**
 * Decide whether an assertion carries sensor/telemetry data. Telemetry is
 * flagged by the assertion label or by any of its data keys matching the
 * telemetry keyword set.
 */
function isTelemetryAssertion (label: string, data: unknown): boolean {
  if (TELEMETRY_RE.test(label)) return true
  if (data !== null && typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>)
    if (keys.some((k) => TELEMETRY_RE.test(k))) return true
  }
  return false
}

function round4 (n: unknown): unknown {
  return typeof n === 'number' && isFinite(n) ? Math.round(n * 10000) / 10000 : n
}

/**
 * Summarize one captured channel across the telemetry samples into a compact
 * stats object (sample count + first/last/min/max for numeric series; per-axis
 * stats for object channels like `rotation`; last value otherwise).
 */
function summarizeChannel (name: string, samples: any[]): Record<string, unknown> | null {
  const vals: any[] = []
  for (const s of samples) {
    if (s !== null && typeof s === 'object' && s[name] !== undefined && s[name] !== null) vals.push(s[name])
  }
  if (vals.length === 0) return null
  const first = vals[0]
  const last = vals[vals.length - 1]

  if (typeof first === 'number') {
    let min = first
    let max = first
    for (const v of vals) {
      if (typeof v === 'number') {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { samples: vals.length, first: round4(first), last: round4(last), min: round4(min), max: round4(max) }
  }

  if (first !== null && typeof first === 'object') {
    // e.g. rotation: { a, b, g, l } — summarize each numeric axis.
    const out: Record<string, unknown> = { samples: vals.length }
    for (const ax of Object.keys(first)) {
      const series = vals.map((v) => (v != null ? v[ax] : undefined)).filter((x) => x !== undefined && x !== null)
      const nums = series.filter((x) => typeof x === 'number') as number[]
      if (nums.length > 0) {
        let mn = nums[0]
        let mx = nums[0]
        for (const x of nums) {
          if (x < mn) mn = x
          if (x > mx) mx = x
        }
        out[ax] = { min: round4(mn), max: round4(mx), last: round4(nums[nums.length - 1]) }
      } else if (series.length > 0) {
        out[ax] = series[series.length - 1]
      }
    }
    return out
  }

  return { samples: vals.length, last }
}

/**
 * Split a telemetry payload into per-sensor groups.
 *
 * v2 schema: { version, sampleRateHz, capturedFields[], samples[] }. Each
 * captured channel (heading, latitude, rotation, audioLevel, ...) becomes its
 * own sensor object, summarized across all samples; the time axis (timestampMs)
 * and top-level scalars stay on the parent telemetry node.
 *
 * Legacy/simple shape: { gyroscope:{...}, gps:{...} } — each object/array key
 * becomes a sensor, scalars stay on the parent.
 */
function splitSensors (data: any): { scalars: Record<string, unknown>, list: Array<{ name: string, value: unknown }> } {
  const scalars: Record<string, unknown> = {}
  const list: Array<{ name: string, value: unknown }> = []
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return { scalars, list }

  if (Array.isArray(data.samples) && data.samples.length > 0) {
    const samples: any[] = data.samples
    // Channels: declared capturedFields, else the union of sample keys.
    let channels: string[] = Array.isArray(data.capturedFields) ? [...data.capturedFields] : []
    if (channels.length === 0) {
      const seen = new Set<string>()
      for (const s of samples) {
        if (s !== null && typeof s === 'object') for (const k of Object.keys(s)) seen.add(k)
      }
      channels = Array.from(seen)
    }
    // The time axis is not a sensor; surface it as a parent scalar instead.
    channels = channels.filter((c) => c !== 'timestampMs' && c !== 'timestamp')

    scalars.version = data.version
    scalars.sampleRateHz = data.sampleRateHz
    scalars.sampleCount = samples.length
    scalars.channels = channels.length

    for (const ch of channels) {
      const summary = summarizeChannel(ch, samples)
      if (summary != null) list.push({ name: ch, value: summary })
    }
    return { scalars, list }
  }

  // Legacy/simple object shape.
  for (const k of Object.keys(data)) {
    const v = data[k]
    if (v !== null && typeof v === 'object') list.push({ name: k, value: v })
    else scalars[k] = v
  }
  return { scalars, list }
}

/** Human edge label for a C2PA relationship. */
export function relLabel (rel: string | null | undefined): string {
  switch (rel) {
    case 'parentOf':
      return 'parent'
    case 'componentOf':
      return 'added'
    case 'inputTo':
      return 'input'
    default:
      return 'added'
  }
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

/**
 * Build a portable provenance graph from a raw c2pa-rs manifest store.
 *
 * @param store    Raw manifest store (snake_case, as `@contentauth/c2pa-web`
 *                 returns it from `reader.manifestStore()`)
 * @param fileName Asset file name — leaf label for the active node
 * @returns The graph, or null when the store has no diagrammable content
 */
export function buildProvenanceGraph (store: any, fileName?: string): ProvenanceGraph | null {
  if (store == null || typeof store !== 'object') return null
  const manifests = store.manifests ?? {}
  const activeKey: string | undefined = store.active_manifest ?? Object.keys(manifests)[0]
  if (activeKey == null || manifests[activeKey] == null) return null

  const nodes: ProvenanceNode[] = []
  const edges: ProvenanceEdge[] = []
  const nodeIndexByKey = new Map<string, number>()
  const idByKey = new Map<string, string>()
  const visited = new Set<string>()
  let counter = 0
  let ingredientCounter = 0
  const nextId = (): string => `n${counter++}`

  function manifestNodeId (key: string): string {
    let id = idByKey.get(key)
    if (id == null) {
      id = nextId()
      idByKey.set(key, id)
    }
    return id
  }

  function manifestLabel (manifest: any, isActive: boolean): string {
    const title = sanitizeLabel(truncate(manifest?.title ?? '', 36))
    const tool = extractToolName(manifest)
    if (title !== '') return title
    if (tool !== '') return tool
    if (isActive) {
      return fileName != null && fileName !== '' ? sanitizeLabel(truncate(fileName, 36)) : 'This file'
    }
    return 'Manifest'
  }

  function addManifestNode (key: string, kind: ProvenanceNode['kind']): string {
    const manifest = manifests[key]
    const id = manifestNodeId(key)
    const isActive = kind === 'current'
    const node: ProvenanceNode = {
      id,
      manifestKey: key,
      kind,
      validationState: isActive ? 'current' : 'valid',
      label: manifestLabel(manifest, isActive),
      title: manifest?.title ?? null,
      format: manifest?.format ?? null,
      formatLabel: prettyMime(manifest?.format),
      relationship: null,
      isActive,
      hasManifest: true,
      claimGenerator: manifest?.claim_generator ?? null,
      claimGeneratorTool: extractToolName(manifest) !== '' ? extractToolName(manifest) : null,
      signer: signerOf(manifest),
      assertions: assertionLabels(manifest),
      validationStatus: [],
      ingredientCount: Array.isArray(manifest?.ingredients) ? manifest.ingredients.length : 0
    }
    nodeIndexByKey.set(key, nodes.length)
    nodes.push(node)
    return id
  }

  function process (
    key: string,
    kind: ProvenanceNode['kind'],
    validationStateOverride: ProvenanceValidationState | null,
    relationship: string | null
  ): void {
    if (visited.has(key)) return
    visited.add(key)

    const manifest = manifests[key]
    if (manifest == null) return

    addManifestNode(key, kind)
    const idx = nodeIndexByKey.get(key)
    if (idx == null) return
    const node = nodes[idx]
    if (!node.isActive && validationStateOverride != null) node.validationState = validationStateOverride
    if (relationship != null) node.relationship = relationship

    // Assertion elements — diagram each assertion the manifest carries (this is
    // where sensor telemetry lives). They branch off the manifest node so the
    // ingredient chain stays readable; telemetry assertions are flagged.
    const assertions: any[] = Array.isArray(manifest.assertions) ? manifest.assertions : []
    for (const a of assertions) {
      const label = typeof a?.label === 'string' ? a.label : ''
      if (label === '') continue
      const data = a?.data
      const telemetry = isTelemetryAssertion(label, data)

      // For a telemetry assertion, break the payload into one child node per
      // sensor (each object/array-valued top-level key) so every sensor is its
      // own expandable object. Scalar top-level readings stay on the parent.
      const sensors = telemetry ? splitSensors(data) : null
      const parentFields: ProvenanceDataField[] = []
      flattenData(sensors != null ? sensors.scalars : data, '', parentFields)

      const aId = nextId()
      nodes.push({
        id: aId,
        manifestKey: null,
        kind: 'assertion',
        validationState: 'assertion',
        label,
        title: label,
        format: null,
        formatLabel: telemetry ? 'TELEMETRY' : 'ASSERTION',
        relationship: null,
        isActive: false,
        hasManifest: false,
        claimGenerator: null,
        claimGeneratorTool: null,
        signer: null,
        assertions: [],
        validationStatus: [],
        ingredientCount: sensors != null ? sensors.list.length : 0,
        dataKind: dataKindOf(data),
        isTelemetry: telemetry,
        dataFields: parentFields
      })
      edges.push({
        id: `e${edges.length}`,
        source: node.id,
        target: aId,
        label: telemetry ? 'telemetry' : 'asserts'
      })

      // Emit a child node per sensor, hidden under the telemetry node until expanded.
      if (sensors != null) {
        for (const s of sensors.list) {
          const sFields: ProvenanceDataField[] = []
          flattenData(s.value, '', sFields)
          const sId = nextId()
          nodes.push({
            id: sId,
            manifestKey: null,
            kind: 'sensor',
            validationState: 'assertion',
            label: s.name,
            title: s.name,
            format: null,
            formatLabel: 'SENSOR',
            relationship: null,
            isActive: false,
            hasManifest: false,
            claimGenerator: null,
            claimGeneratorTool: null,
            signer: null,
            assertions: [],
            validationStatus: [],
            ingredientCount: 0,
            dataKind: dataKindOf(s.value),
            isTelemetry: true,
            dataFields: sFields,
            parentId: aId
          })
          edges.push({ id: `e${edges.length}`, source: aId, target: sId, label: 'sensor' })
        }
      }
    }

    const ingredients: any[] = Array.isArray(manifest.ingredients) ? manifest.ingredients : []
    for (const ing of ingredients) {
      const rel: string = ing?.relationship ?? 'componentOf'
      const vstate = ingredientValidationState(ing)

      if (ing?.active_manifest != null && manifests[ing.active_manifest] != null) {
        // Linked ingredient — recurse into its own manifest node.
        const childId = manifestNodeId(ing.active_manifest)
        if (!visited.has(ing.active_manifest)) {
          process(ing.active_manifest, 'origin', vstate, rel)
        } else {
          const cIdx = nodeIndexByKey.get(ing.active_manifest)
          if (cIdx != null && nodes[cIdx].relationship == null) nodes[cIdx].relationship = rel
        }
        edges.push({
          id: `e${edges.length}`,
          source: childId,
          target: node.id,
          label: relLabel(rel)
        })
      } else {
        // Leaf ingredient — no manifest of its own.
        ingredientCounter++
        const ingId = nextId()
        nodes.push({
          id: ingId,
          manifestKey: null,
          kind: 'ingredient',
          validationState: vstate,
          label: sanitizeLabel(truncate(ing?.title ?? `Ingredient ${ingredientCounter}`, 36)),
          title: ing?.title ?? null,
          format: ing?.format ?? null,
          formatLabel: prettyMime(ing?.format),
          relationship: rel,
          isActive: false,
          hasManifest: false,
          instanceId: ing?.instance_id ?? null,
          claimGenerator: null,
          claimGeneratorTool: null,
          signer: null,
          assertions: [],
          validationStatus: ingredientFailures(ing),
          ingredientCount: 0
        })
        edges.push({
          id: `e${edges.length}`,
          source: ingId,
          target: node.id,
          label: relLabel(rel)
        })
      }
    }
  }

  process(activeKey, 'current', null, null)

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Derived representations
// ---------------------------------------------------------------------------

/** Map a node's validation state to a Mermaid classDef name. */
function mermClass (node: ProvenanceNode): string {
  if (node.kind === 'sensor') return 'telemetry'
  if (node.kind === 'assertion') return node.isTelemetry === true ? 'telemetry' : 'assertion'
  if (node.isActive) return 'current'
  switch (node.validationState) {
    case 'invalid':
      return 'invalid'
    case 'unsigned':
      return 'unsigned'
    default:
      return 'valid'
  }
}

/** Short Mermaid node label including the pretty format when present. */
function mermaidNodeLabel (node: ProvenanceNode): string {
  const base = node.label !== '' ? node.label : (node.kind === 'ingredient' ? 'Ingredient' : 'Manifest')
  return node.formatLabel !== '' ? `${base} (${node.formatLabel})` : base
}

/**
 * Render a Mermaid flowchart string from a provenance graph. Kept in parity
 * with the hub so a user can copy the same diagram source out of any of the
 * three verifiers and get an identical drawing.
 */
export function graphToMermaid (graph: ProvenanceGraph | null): string {
  if (graph == null || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return ''
  const lines = ['graph TB']
  for (const n of graph.nodes) {
    lines.push(`  ${n.id}("${sanitizeLabel(mermaidNodeLabel(n))}"):::${mermClass(n)}`)
  }
  for (const e of graph.edges) {
    lines.push(`  ${e.source} -->|"${sanitizeLabel(e.label)}"| ${e.target}`)
  }
  lines.push('  classDef current fill:#3b82f6,stroke:#1d4ed8,color:#fff')
  lines.push('  classDef valid fill:#10b981,stroke:#047857,color:#fff')
  lines.push('  classDef invalid fill:#ef4444,stroke:#b91c1c,color:#fff')
  lines.push('  classDef unsigned fill:#9ca3af,stroke:#6b7280,color:#fff')
  lines.push('  classDef assertion fill:#64748b,stroke:#334155,color:#fff')
  lines.push('  classDef telemetry fill:#8b5cf6,stroke:#6d28d9,color:#fff')
  return lines.join('\n')
}
