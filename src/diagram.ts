/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

/**
 * Full-page provenance diagram, opened from the toolbar popup.
 *
 * The popup mounts <c2pa-provenance-graph> directly into a roughly 380px
 * window. "Full screen" there had nothing to expand into: requestFullscreen is
 * refused, and the CSS fallback's `inset: 0` resolves against the popup itself.
 * Rather than fight that, the popup parks the graph and opens this page, which
 * is an ordinary tab and therefore genuinely has room. Full screen works here
 * too, because a tab is allowed to enter it.
 */

// Side-effect import: registers <c2pa-provenance-graph>.
import './provenanceDiagram.js'
import { DIAGRAM_HANDOFF_KEY } from './constants'
import { readHandoff } from './diagramHandoff'
import type { ProvenanceGraph } from './provenanceTypes'

async function main (): Promise<void> {
  const host = document.getElementById('diagram')
  if (host == null) return

  let graph: ProvenanceGraph | null = null
  try {
    graph = await readHandoff(DIAGRAM_HANDOFF_KEY)
  } catch (error: unknown) {
    console.debug('diagram: could not read the handed-off graph:', error)
  }

  if (graph == null || graph.nodes.length === 0) {
    // Reachable by reopening this tab in a later session, since the handoff is
    // deliberately session-scoped. Say so rather than showing an empty canvas.
    host.innerHTML = '<p class="empty">No provenance chain to show. Open one from the Verifieddit toolbar popup.</p>'
    return
  }

  const diagram = document.createElement('c2pa-provenance-graph') as HTMLElement & { graph?: ProvenanceGraph }
  diagram.graph = graph
  host.appendChild(diagram)
  document.title = `Provenance chain: ${graph.nodes[0]?.label ?? 'asset'}`
}

void main()
