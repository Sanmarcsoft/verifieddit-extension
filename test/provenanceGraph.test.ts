/*
 *  Unit tests for the provenance graph builder + diagram layout.
 *  Run with:  bun test test/provenanceGraph.test.ts
 *  (Playwright only scans ./test/e2e, so this file is ignored by `npm test`.)
 *
 *  The buildProvenanceGraph / graphToMermaid cases are a port of
 *  verifieddit-www/api/test/provenance-graph.test.js — same fixtures, same
 *  assertions — so drift between the extension, the hub and trusteddit.com
 *  fails here rather than in a user's overlay.
 */
import { describe, it, expect } from 'bun:test'
import { buildProvenanceGraph, graphToMermaid, prettyMime, extractToolName, relLabel } from '../src/provenanceGraph'
import { computeLayout, visibleSubgraph, COLUMN_GAP, PADDING } from '../src/provenanceLayout'
import type { ProvenanceGraph } from '../src/provenanceTypes'

/*
 * A synthetic c2pa-rs manifest store modelling a 3-generation chain:
 *   IMG_0001.dng (leaf capture) -> edited.jpg (own manifest) -> final.jpg (active)
 * plus an added componentOf overlay on the active manifest.
 */
function multiGenStore (): any {
  return {
    active_manifest: 'urn:active',
    manifests: {
      'urn:active': {
        label: 'urn:active',
        title: 'final.jpg',
        format: 'image/jpeg',
        claim_generator: 'Adobe Photoshop 25.0 c2pa-rs/0.49.2',
        claim_generator_info: [{ name: 'Adobe Photoshop', version: '25.0' }],
        signature_info: { issuer: 'Trusteddit.com', alg: 'Es256', time: '2026-03-07T08:57:18Z' },
        assertions: [{ label: 'c2pa.actions.v2' }, { label: 'stds.schema-org.CreativeWork' }],
        ingredients: [
          {
            title: 'edited.jpg',
            format: 'image/jpeg',
            relationship: 'parentOf',
            active_manifest: 'urn:parent',
            instance_id: 'xmp:iid:1'
          },
          { title: 'overlay.png', format: 'image/png', relationship: 'componentOf', instance_id: 'xmp:iid:2' }
        ]
      },
      'urn:parent': {
        label: 'urn:parent',
        title: 'edited.jpg',
        format: 'image/jpeg',
        claim_generator: 'Lightroom 7 c2pa-rs/0.49.2',
        signature_info: { issuer: 'Trusteddit.com', alg: 'Es256', time: '2026-03-06T08:00:00Z' },
        assertions: [{ label: 'c2pa.actions' }],
        ingredients: [
          { title: 'IMG_0001.dng', format: 'image/x-adobe-dng', relationship: 'parentOf', instance_id: 'xmp:iid:0' }
        ]
      }
    }
  }
}

describe('buildProvenanceGraph', () => {
  it('builds a full multi-generation node/edge graph', () => {
    const g = buildProvenanceGraph(multiGenStore(), 'final.jpg')
    expect(g).not.toBeNull()

    // Chain = active + parent + 2 leaf ingredients (assertions are separate nodes).
    const chain = g!.nodes.filter((n) => n.kind !== 'assertion')
    expect(chain.length).toBe(4)

    const active = g!.nodes.find((n) => n.isActive)
    expect(active).toBeDefined()
    expect(active!.kind).toBe('current')
    expect(active!.validationState).toBe('current')
    expect(active!.label).toBe('final.jpg')
    expect(active!.assertions.length).toBe(2)
    expect(active!.signer?.issuer).toBe('Trusteddit.com')

    const parent = g!.nodes.find((n) => n.label === 'edited.jpg')
    expect(parent).toBeDefined()
    expect(parent!.hasManifest).toBe(true)
    expect(parent!.validationState).toBe('valid')
    expect(parent!.relationship).toBe('parentOf')

    const dng = g!.nodes.find((n) => n.label === 'IMG_0001.dng')
    expect(dng).toBeDefined()
    expect(dng!.kind).toBe('ingredient')
    expect(dng!.hasManifest).toBe(false)
  })

  it('marks an ingredient invalid when it carries a hard integrity failure', () => {
    const store = multiGenStore()
    store.manifests['urn:active'].ingredients[1].validation_results = {
      activeManifest: { failure: [{ code: 'assertion.dataHash.mismatch' }] }
    }
    const g = buildProvenanceGraph(store, 'final.jpg')
    const overlay = g!.nodes.find((n) => n.label === 'overlay.png')
    expect(overlay!.validationState).toBe('invalid')
    expect(overlay!.validationStatus[0].code).toBe('assertion.dataHash.mismatch')
  })

  it('leaves an ingredient valid for a non-integrity (trust) failure', () => {
    // A cert-trust complaint must NOT paint the node red, or the graph
    // contradicts the overlay's own valid-but-untrusted verdict.
    const store = multiGenStore()
    store.manifests['urn:active'].ingredients[1].validation_status = [
      { code: 'signingCredential.untrusted' }
    ]
    const g = buildProvenanceGraph(store, 'final.jpg')
    const overlay = g!.nodes.find((n) => n.label === 'overlay.png')
    expect(overlay!.validationState).toBe('unsigned')
  })

  it('diagrams assertions as nodes and flags sensor telemetry', () => {
    const store = {
      active_manifest: 'urn:a',
      manifests: {
        'urn:a': {
          label: 'urn:a',
          title: 'capture.jpg',
          format: 'image/jpeg',
          claim_generator: 'Phenom/1.0',
          assertions: [
            { label: 'c2pa.actions.v2', data: { actions: [{ action: 'c2pa.created' }] } },
            {
              label: 'com.phenom.sensor.telemetry',
              data: { gyroscope: { x: 0.01, y: -0.2, z: 9.8 }, gps: { lat: 48.21, lon: 16.37 } }
            }
          ],
          ingredients: []
        }
      }
    }
    const g = buildProvenanceGraph(store, 'capture.jpg')!
    const assertions = g.nodes.filter((n) => n.kind === 'assertion')
    expect(assertions.length).toBe(2)

    const telemetry = assertions.find((n) => n.label === 'com.phenom.sensor.telemetry')
    expect(telemetry).toBeDefined()
    expect(telemetry!.isTelemetry).toBe(true)

    const action = assertions.find((n) => n.label === 'c2pa.actions.v2')
    expect(action!.isTelemetry).toBe(false)

    // Telemetry is linked from the active manifest with a 'telemetry' edge.
    const active = g.nodes.find((n) => n.isActive)!
    const telEdge = g.edges.find((e) => e.target === telemetry!.id)!
    expect(telEdge.source).toBe(active.id)
    expect(telEdge.label).toBe('telemetry')

    // Each sensor becomes its own child node under the telemetry node.
    const sensors = g.nodes.filter((n) => n.kind === 'sensor')
    expect(sensors.length).toBe(2)
    const gyro = sensors.find((n) => n.label === 'gyroscope')!
    expect(gyro.parentId).toBe(telemetry!.id)
    expect(gyro.dataFields?.some((f) => f.key === 'x')).toBe(true)
    const sensorEdge = g.edges.find((e) => e.source === telemetry!.id && e.target === gyro.id)!
    expect(sensorEdge.label).toBe('sensor')
  })

  it('summarizes a v2 sample-series telemetry payload per channel', () => {
    const store = {
      active_manifest: 'a',
      manifests: {
        a: {
          title: 'clip.mp4',
          format: 'video/mp4',
          assertions: [{
            label: 'com.phenom.telemetry',
            data: {
              version: 2,
              sampleRateHz: 10,
              capturedFields: ['heading', 'timestampMs'],
              samples: [
                { timestampMs: 0, heading: 10 },
                { timestampMs: 100, heading: 30 },
                { timestampMs: 200, heading: 20 }
              ]
            }
          }],
          ingredients: []
        }
      }
    }
    const g = buildProvenanceGraph(store, 'clip.mp4')!
    const sensors = g.nodes.filter((n) => n.kind === 'sensor')
    // timestampMs is the time axis, not a sensor.
    expect(sensors.map((s) => s.label)).toEqual(['heading'])
    const heading = sensors[0]
    const fields = Object.fromEntries((heading.dataFields ?? []).map((f) => [f.key, f.value]))
    expect(fields.samples).toBe('3')
    expect(fields.min).toBe('10')
    expect(fields.max).toBe('30')
    expect(fields.last).toBe('20')
  })

  it('does not carry raw assertion payloads (message-passing budget)', () => {
    const store = {
      active_manifest: 'a',
      manifests: {
        a: {
          title: 'x.jpg',
          assertions: [{ label: 'c2pa.actions', data: { blob: 'x'.repeat(50000) } }],
          ingredients: []
        }
      }
    }
    const g = buildProvenanceGraph(store, 'x.jpg')!
    const assertion = g.nodes.find((n) => n.kind === 'assertion')!
    expect((assertion as Record<string, unknown>).data).toBeUndefined()
    expect(JSON.stringify(g).length).toBeLessThan(4000)
  })

  it('emits a single current node for an original capture (no ingredients)', () => {
    const leaf = {
      active_manifest: 'a',
      manifests: { a: { title: '', format: 'video/mp4', claim_generator: 'Pixel', ingredients: [] } }
    }
    const g = buildProvenanceGraph(leaf, 'PXL_capture.mp4')!
    expect(g.nodes.length).toBe(1)
    expect(g.edges.length).toBe(0)
    expect(g.nodes[0].isActive).toBe(true)
    expect(g.nodes[0].label).toBe('Pixel')
  })

  it('survives a cyclic ingredient reference without hanging', () => {
    const cyclic = {
      active_manifest: 'a',
      manifests: {
        a: { title: 'a.jpg', ingredients: [{ title: 'b', active_manifest: 'b', relationship: 'parentOf' }] },
        b: { title: 'b.jpg', ingredients: [{ title: 'a', active_manifest: 'a', relationship: 'parentOf' }] }
      }
    }
    const g = buildProvenanceGraph(cyclic, 'a.jpg')!
    expect(g.nodes.length).toBe(2)
  })

  it('returns null for an empty / missing store', () => {
    expect(buildProvenanceGraph(null)).toBeNull()
    expect(buildProvenanceGraph({})).toBeNull()
    expect(buildProvenanceGraph({ manifests: {} })).toBeNull()
  })
})

describe('helpers', () => {
  it('prettifies MIME types', () => {
    expect(prettyMime('image/jpeg')).toBe('JPEG')
    expect(prettyMime('video/mp4')).toBe('MP4')
    expect(prettyMime(null)).toBe('')
  })

  it('extracts a human tool name, skipping the c2pa toolchain', () => {
    expect(extractToolName({ claim_generator_info: [{ name: 'Adobe Photoshop' }] })).toBe('Photoshop')
    expect(extractToolName({ claim_generator: 'Trusteddit/1.0 c2pa-node/0.0.0 c2pa-rs/0.49.2' })).toBe('c2pa-node')
    expect(extractToolName({})).toBe('')
  })

  it('maps C2PA relationships to human edge labels', () => {
    expect(relLabel('parentOf')).toBe('parent')
    expect(relLabel('componentOf')).toBe('added')
    expect(relLabel('inputTo')).toBe('input')
    expect(relLabel(undefined)).toBe('added')
  })
})

describe('graphToMermaid', () => {
  it('renders a flowchart with edges and class definitions', () => {
    const g = buildProvenanceGraph(multiGenStore(), 'final.jpg')
    const m = graphToMermaid(g)
    expect(m).toMatch(/^graph TB/)
    expect(m).toMatch(/-->\|"parent"\|/)
    expect(m).toMatch(/classDef current/)
    expect(m).toMatch(/classDef invalid/)
    expect(m).toMatch(/classDef telemetry/)
  })

  it('returns empty string for an empty graph', () => {
    expect(graphToMermaid({ nodes: [], edges: [] })).toBe('')
    expect(graphToMermaid(null)).toBe('')
  })
})

describe('computeLayout', () => {
  it('lays generations out left-to-right by longest path', () => {
    const g = buildProvenanceGraph(multiGenStore(), 'final.jpg')!
    const pos = computeLayout(g)

    const active = g.nodes.find((n) => n.isActive)!
    const dng = g.nodes.find((n) => n.label === 'IMG_0001.dng')!
    const parent = g.nodes.find((n) => n.label === 'edited.jpg')!

    // Earliest capture on the left, active manifest furthest right.
    expect(pos.get(dng.id)!.x).toBe(PADDING)
    expect(pos.get(parent.id)!.x).toBeGreaterThan(pos.get(dng.id)!.x)
    expect(pos.get(active.id)!.x).toBeGreaterThan(pos.get(parent.id)!.x)
    expect(pos.get(active.id)!.x - pos.get(parent.id)!.x).toBe(COLUMN_GAP)
  })

  it('terminates on a cyclic graph', () => {
    const cyclic: ProvenanceGraph = {
      nodes: [{ id: 'a' }, { id: 'b' }].map((n) => ({
        ...n,
        kind: 'manifest',
        validationState: 'valid',
        label: n.id,
        title: null,
        format: null,
        formatLabel: '',
        relationship: null,
        isActive: false,
        hasManifest: true,
        claimGenerator: null,
        claimGeneratorTool: null,
        signer: null,
        assertions: [],
        validationStatus: [],
        ingredientCount: 0
      })),
      edges: [
        { id: 'e0', source: 'a', target: 'b', label: '' },
        { id: 'e1', source: 'b', target: 'a', label: '' }
      ]
    }
    const pos = computeLayout(cyclic)
    expect(pos.size).toBe(2)
  })
})

describe('visibleSubgraph', () => {
  it('hides sensor children until their telemetry parent is expanded', () => {
    const store = {
      active_manifest: 'a',
      manifests: {
        a: {
          title: 'capture.jpg',
          assertions: [{ label: 'com.phenom.sensor.telemetry', data: { gps: { lat: 1 }, gyro: { x: 2 } } }],
          ingredients: []
        }
      }
    }
    const g = buildProvenanceGraph(store, 'capture.jpg')!
    const telemetry = g.nodes.find((n) => n.kind === 'assertion')!

    const collapsed = visibleSubgraph(g, new Set())
    expect(collapsed.nodes.some((n) => n.kind === 'sensor')).toBe(false)
    // Edges to hidden nodes are dropped with them.
    expect(collapsed.edges.every((e) => e.label !== 'sensor')).toBe(true)

    const opened = visibleSubgraph(g, new Set([telemetry.id]))
    expect(opened.nodes.filter((n) => n.kind === 'sensor').length).toBe(2)
    expect(opened.edges.filter((e) => e.label === 'sensor').length).toBe(2)
  })
})

// A real composite (#184): one credentialed image edited, a second credentialed
// image added. The store is what c2patool reads from test/fixtures/multi-ingredient.
describe('a composite with two credentialed ingredients', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('./fixtures/multi-ingredient/composite.store.json')
  const graph = buildProvenanceGraph(store, 'composite.jpg')!
  const manifests = graph.nodes.filter((n) => n.hasManifest)

  it('draws the composite and both sources as their own credentialed nodes', () => {
    expect(manifests.map((n) => n.kind).sort()).toEqual(['current', 'origin', 'origin'])
    expect(manifests.filter((n) => n.kind === 'origin').map((n) => n.label).sort()).toEqual(['dev-a-base.jpg', 'dev-b-added.jpg'])
    expect(graph.nodes.some((n) => n.kind === 'ingredient')).toBe(false)
  })

  it('says which source was edited and which was added', () => {
    const current = manifests.find((n) => n.kind === 'current')!
    const edge = (label: string): string | undefined => graph.edges.find((e) => e.target === current.id && e.label === label)?.source
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    expect(byId.get(edge('parent')!)?.label).toBe('dev-a-base.jpg')
    expect(byId.get(edge('added')!)?.label).toBe('dev-b-added.jpg')
    expect(byId.get(edge('parent')!)?.relationship).toBe('parentOf')
    expect(byId.get(edge('added')!)?.relationship).toBe('componentOf')
  })

  it('keeps each source valid and carrying its own signer and assertions', () => {
    for (const source of manifests.filter((n) => n.kind === 'origin')) {
      expect(source.validationState).toBe('valid')
      expect(source.signer).not.toBeNull()
      expect(source.assertions).toContain('c2pa.soft_binding')
      // Each source's assertions hang off that source, not off the composite.
      expect(graph.edges.filter((e) => e.source === source.id && e.label === 'asserts').length).toBeGreaterThan(0)
    }
    expect(manifests.find((n) => n.kind === 'current')!.ingredientCount).toBe(2)
  })
})
