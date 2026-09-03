/**
 * Provenance graph types — the portable node/edge model shared across the three
 * SanMarcSoft C2PA verifiers.
 *
 * Contract source of truth: `verifieddit-www/src/types/provenance.ts` (which
 * mirrors the hub's `api/lib/provenance-graph.js`). trusteddit.com carries the
 * same contract at `trusteddit-www/src/types/provenance.ts`. Keep all three in
 * lockstep — a consumer that renders one graph must render all three.
 */

export type ProvenanceValidationState =
  | 'current'
  | 'valid'
  | 'invalid'
  | 'unsigned'
  /** An assertion element (not a validation state per se — drives node styling). */
  | 'assertion'

export type ProvenanceNodeKind =
  | 'current'
  | 'origin'
  | 'manifest'
  | 'ingredient'
  /** A C2PA assertion attached to a manifest (e.g. actions, sensor telemetry). */
  | 'assertion'
  /** A single sensor inside a telemetry assertion (gyroscope, gps, ...). */
  | 'sensor'

/** A C2PA relationship as carried by an ingredient. */
export type ProvenanceRelationship = 'parentOf' | 'componentOf' | 'inputTo' | string

export interface ProvenanceSigner {
  issuer: string | null
  alg: string | null
  time: string | null
}

export interface ProvenanceValidationItem {
  code: string
  explanation?: string
}

export interface ProvenanceDataField {
  key: string
  value: string
}

export interface ProvenanceNode {
  /** Stable id ("n0", "n1", ...) used to wire edges. */
  id: string
  /** Manifest store key when this node has its own manifest, else null. */
  manifestKey?: string | null
  kind: ProvenanceNodeKind
  validationState: ProvenanceValidationState
  /** Short display label (file/manifest title or tool name). */
  label: string
  title: string | null
  /** Raw MIME (e.g. "image/jpeg"). */
  format: string | null
  /** Pretty MIME (e.g. "JPEG"). */
  formatLabel: string
  /** C2PA relationship to the manifest that consumed it. */
  relationship: ProvenanceRelationship | null
  /** True for the verified asset's active manifest. */
  isActive: boolean
  /** True when this node carries its own C2PA manifest. */
  hasManifest: boolean
  claimGenerator: string | null
  claimGeneratorTool: string | null
  signer: ProvenanceSigner | null
  assertions: string[]
  /** Validation failures attributable to this node. */
  validationStatus: ProvenanceValidationItem[]
  /** Number of ingredients this manifest consumed (0 for leaf ingredients). */
  ingredientCount: number
  instanceId?: string | null
  // --- Assertion / sensor nodes ---
  /** Coarse shape of the assertion payload ("object" | "array" | "scalar" | "empty"). */
  dataKind?: string
  /** True when the assertion looks like sensor/telemetry data. */
  isTelemetry?: boolean
  /** Flattened key/value rows for compact rendering of assertion data. */
  dataFields?: ProvenanceDataField[]
  /**
   * Id of the node this one is nested under. Child nodes (e.g. per-sensor
   * nodes under a telemetry assertion) stay hidden until their parent is
   * expanded. Null/absent for top-level nodes.
   */
  parentId?: string | null
}

export interface ProvenanceEdge {
  id: string
  /** Source node id (the ingredient / earlier generation). */
  source: string
  /** Target node id (the manifest that consumed the source). */
  target: string
  /** Human edge label ("parent", "added", "input", "asserts", "telemetry", "sensor"). */
  label: string
}

export interface ProvenanceGraph {
  nodes: ProvenanceNode[]
  edges: ProvenanceEdge[]
}
