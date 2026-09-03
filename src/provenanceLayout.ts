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
export const COLUMN_GAP = 268
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
  for (const [d, bucket] of columns) {
    const offset = ((bucket.length - 1) * ROW_GAP) / 2
    bucket.forEach((id, row) => {
      positions.set(id, { x: PADDING + d * COLUMN_GAP, y: PADDING + centreY + row * ROW_GAP - offset })
    })
  }
  return positions
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
