/**
 * Pure layout maths for the provenance diagram.
 *
 * Kept out of provenanceDiagram.ts so it can be unit-tested without a DOM: that
 * module registers a custom element at import time, which needs `customElements`.
 * Ported from the `computeLayout` / `buildFlowGraph` visibility rules in the
 * sites' ProvenanceGraph.tsx so all three verifiers lay a chain out the same way.
 */

import type { ProvenanceGraph, ProvenanceNode } from './provenanceTypes.js'

/** Layout constants (px). Column = generation depth, row = sibling stacking. */
export const NODE_W = 214
export const NODE_H = 74
// 86px between columns: room for an edge label without touching either node (#193).
export const COLUMN_GAP = 300
export const ROW_GAP = 118
export const PADDING = 28

export interface Point { x: number, y: number }

/**
 * Longest-path layered layout over the DAG. Returns a position per node id.
 *
 * Depth of a node = the longest chain of edges that reaches it from a root.
 * Edges run source -> target (ingredient -> consuming manifest), so roots land
 * in column 0 (left) and the most-derived node lands furthest right. Iteration
 * is capped at the node count, which both terminates the relaxation and defends
 * against cycles in malformed input.
 */
export function computeLayout (graph: ProvenanceGraph): Map<string, Point> {
  const ids = graph.nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const edges = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))

  const depth = new Map<string, number>()
  ids.forEach((id) => depth.set(id, 0))

  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const edge of edges) {
      const candidate = (depth.get(edge.source) ?? 0) + 1
      if (candidate > (depth.get(edge.target) ?? 0)) {
        depth.set(edge.target, candidate)
        changed = true
      }
    }
    if (!changed) break
  }

  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const d = depth.get(id) ?? 0
    const bucket = columns.get(d)
    if (bucket != null) bucket.push(id)
    else columns.set(d, [id])
  }

  // The tallest column sets the vertical centre line, so every column is
  // centred against the same axis rather than each around its own midpoint.
  let tallest = 0
  for (const bucket of columns.values()) tallest = Math.max(tallest, bucket.length)
  const centreY = ((tallest - 1) * ROW_GAP) / 2

  const positions = new Map<string, Point>()
  // Left to right, so a column can be ordered by where its sources already sit.
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const bucket = orderBySources(columns.get(d) ?? [], edges, positions)
    const offset = ((bucket.length - 1) * ROW_GAP) / 2
    bucket.forEach((id, row) => {
      positions.set(id, { x: PADDING + d * COLUMN_GAP, y: PADDING + centreY + row * ROW_GAP - offset })
    })
  }
  return positions
}

/**
 * Order one column by the mean height of each node's already-placed sources
 * (#193). A composite then sits between its sources instead of above both, so
 * their lines stop crossing. Nodes with no placed source keep their order, and
 * the sort is stable, so a simple chain lays out exactly as before.
 */
function orderBySources (bucket: string[], edges: ProvenanceGraph['edges'], placed: Map<string, Point>): string[] {
  const weight = new Map<string, number>()
  for (const id of bucket) {
    const ys = edges.filter((e) => e.target === id).map((e) => placed.get(e.source)?.y).filter((y): y is number => y != null)
    if (ys.length > 0) weight.set(id, ys.reduce((a, b) => a + b, 0) / ys.length)
  }
  if (weight.size !== bucket.length) return bucket
  return bucket
    .map((id, index) => ({ id, index }))
    .sort((a, b) => ((weight.get(a.id) ?? 0) - (weight.get(b.id) ?? 0)) || (a.index - b.index))
    .map((entry) => entry.id)
}

/** How close two edge labels may sit before they read as one smear (px). */
const LABEL_CLEAR_X = 60
const LABEL_CLEAR_Y = 14
/** Places along a line to try for its label, the midpoint first. */
const LABEL_STOPS = [0.5, 0.36, 0.64, 0.26, 0.74, 0.18, 0.82]

/** The two ends of an edge as drawn: out of the source's right, into the target's left. */
export function edgeEnds (from: Point, to: Point): { x1: number, y1: number, x2: number, y2: number } {
  return { x1: from.x + NODE_W, y1: from.y + NODE_H / 2, x2: to.x, y2: to.y + NODE_H / 2 }
}

/** A point on the edge's curve: a cubic with both handles at the horizontal midpoint. */
function pointOnEdge (from: Point, to: Point, t: number): Point {
  const { x1, y1, x2, y2 } = edgeEnds(from, to)
  const midX = (x1 + x2) / 2
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * x1 + b * midX + c * midX + d * x2, y: a * y1 + b * y1 + c * y2 + d * y2 }
}

/**
 * Where each labelled edge's text goes (#193). A label starts at the middle of
 * its line; when that spot is taken by an earlier label it slides along its own
 * line to the first free stop. Returns a point per edge id.
 */
export function edgeLabelPoints (graph: ProvenanceGraph, positions: Map<string, Point>): Map<string, Point> {
  const placed: Point[] = []
  const out = new Map<string, Point>()
  const clashes = (p: Point): boolean =>
    placed.some((q) => Math.abs(p.x - q.x) < LABEL_CLEAR_X && Math.abs(p.y - q.y) < LABEL_CLEAR_Y)

  for (const edge of graph.edges) {
    if (edge.label === '') continue
    const from = positions.get(edge.source)
    const to = positions.get(edge.target)
    if (from == null || to == null) continue
    const stops = LABEL_STOPS.map((t) => pointOnEdge(from, to, t))
    const spot = stops.find((p) => !clashes(p)) ?? stops[0]
    placed.push(spot)
    out.set(edge.id, spot)
  }
  return out
}

/**
 * Filter the graph down to the nodes currently visible: a node is visible only
 * when every ancestor in its `parentId` chain is expanded. So a telemetry
 * node's per-sensor children stay hidden until it is expanded.
 */
export function visibleSubgraph (graph: ProvenanceGraph, expanded: Set<string>): ProvenanceGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  const isVisible = (n: ProvenanceNode): boolean => {
    let cur: ProvenanceNode | undefined = n
    const guard = new Set<string>()
    while (cur?.parentId != null) {
      if (guard.has(cur.id)) return false // cycle guard
      guard.add(cur.id)
      if (!expanded.has(cur.parentId)) return false
      cur = byId.get(cur.parentId)
    }
    return true
  }

  const nodes = graph.nodes.filter(isVisible)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { nodes, edges }
}
