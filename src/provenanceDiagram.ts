/**
 * <c2pa-provenance-graph> — interactive C2PA provenance diagram for the overlay.
 *
 * Renders the portable node/edge model produced by provenanceGraph.ts: the
 * manifest chain, each manifest's assertions, and the per-sensor breakdown of
 * telemetry assertions. This is the extension's counterpart to the
 * `ProvenanceGraph` React Flow component that verifieddit.com and
 * trusteddit.com ship — same graph contract, same colour semantics, same
 * interaction model (pan, zoom, expand a node for its detail, reveal a
 * telemetry node's sensors, full screen).
 *
 * React Flow is not an option inside a Lit shadow root in an extension overlay,
 * so the canvas is built the same way React Flow builds its own: an SVG edge
 * layer under a set of absolutely-positioned HTML node cards, both inside one
 * transformed viewport. Zero runtime dependencies beyond Lit, which the overlay
 * already loads.
 *
 * Layout is a deterministic longest-path layering over the DAG (ported from the
 * sites' computeLayout) so no layout library is needed and the columns read
 * left-to-right by generation: earliest ingredients on the left, the verified
 * asset's own manifest on the right.
 */

import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type {
  ProvenanceGraph,
  ProvenanceNode,
  ProvenanceValidationState
} from './provenanceTypes.js'
import {
  NODE_H,
  NODE_W,
  PADDING,
  computeLayout,
  visibleSubgraph,
  type Point
} from './provenanceLayout.js'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 1.8

/**
 * Per-state palette, taken from verifieddit.com's own tokens: sky-600 for the
 * active manifest, emerald-600 for valid, rose-700 for invalid, slate for
 * unsigned and assertions, amber-700 for telemetry. Tints are kept low-alpha
 * so the card reads as tinted paper on the warm off-white canvas, the way the
 * site's status chips do, rather than as a saturated block of colour.
 */
interface StateStyle { accent: string, bg: string, badgeBg: string, label: string }

const STATE_STYLES: Record<ProvenanceValidationState, StateStyle> = {
  current: { accent: '#0284c7', bg: 'rgba(2, 132, 199, 0.07)', badgeBg: 'rgba(2, 132, 199, 0.12)', label: 'Active' },
  valid: { accent: '#059669', bg: 'rgba(5, 150, 105, 0.07)', badgeBg: 'rgba(5, 150, 105, 0.12)', label: 'Valid' },
  invalid: { accent: '#be123c', bg: 'rgba(190, 18, 60, 0.07)', badgeBg: 'rgba(190, 18, 60, 0.12)', label: 'Invalid' },
  unsigned: { accent: '#64748b', bg: 'rgba(100, 116, 139, 0.06)', badgeBg: 'rgba(100, 116, 139, 0.12)', label: 'Unsigned' },
  assertion: { accent: '#475569', bg: 'rgba(71, 85, 105, 0.05)', badgeBg: 'rgba(71, 85, 105, 0.10)', label: 'Assertion' }
}

/**
 * Telemetry gets the amber the site uses for its audit chip, not the violet
 * that reads as generic "AI accent" and appears nowhere on verifieddit.com.
 */
const TELEMETRY_STYLE: StateStyle = {
  accent: '#b45309',
  bg: 'rgba(180, 83, 9, 0.07)',
  badgeBg: 'rgba(180, 83, 9, 0.13)',
  label: 'Telemetry'
}

function styleFor (node: ProvenanceNode): StateStyle {
  const isAssertion = node.kind === 'assertion' || node.kind === 'sensor'
  if (isAssertion && node.isTelemetry === true) return TELEMETRY_STYLE
  return STATE_STYLES[node.validationState] ?? STATE_STYLES.unsigned
}

@customElement('c2pa-provenance-graph')
export class C2paProvenanceGraph extends LitElement {
  @property({ attribute: false }) graph: ProvenanceGraph | null = null

  /** Ids whose detail panel and child nodes are revealed. */
  @state() private readonly expanded = new Set<string>()
  @state() private zoom = 1
  @state() private pan: Point = { x: 0, y: 0 }
  @state() private fullscreen = false
  /** Bumped to force a re-render when the expanded Set mutates in place. */
  @state() private revision = 0

  private dragOrigin: (Point & { panX: number, panY: number }) | null = null
  /**
   * Per-node displacement from the computed layout, in layout pixels.
   *
   * The layout is a fixed-height grid, but an expanded node grows well past
   * NODE_H and lands on top of its neighbours, so the reading order the layout
   * establishes is exactly what the user needs to break by hand. Mutated in
   * place and paired with `revision++`, the same way `expanded` is.
   */
  private readonly nodeOffsets = new Map<string, Point>()
  private nodeDrag: { id: string, pointerX: number, pointerY: number, originX: number, originY: number } | null = null
  /** Un-displaced layout of the current view, kept so a drag can clamp against it. */
  private layoutPositions = new Map<string, Point>()
  /** Laid-out size of the current graph, measured during render for fit(). */
  private contentSize: { width: number, height: number } | null = null
  /** The graph identity the view was last auto-fitted to. */
  private fittedGraph: ProvenanceGraph | null = null

  static styles = css`
    :host {
      display: block;
      font-family: Inter, system-ui, -apple-system, sans-serif;
    }

    /* Canvas matches verifieddit.com: warm off-white, never pure white, with a
     * hairline rule instead of a shadowed card. The site draws its structure
     * with 1px borders and whitespace, so the diagram does too. */
    .frame {
      position: relative;
      height: 360px;
      min-height: 220px;
      margin: 8px 0 4px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 8px;
      background: #fafaf7;
      overflow: hidden;
      touch-action: none;
      /* The frame itself is user-resizable: drag the bottom-right corner to
       * give a deep provenance chain more room without entering full screen. */
      resize: vertical;
    }

    /* REAL full screen (Fullscreen API). The UA promotes the element to the top
     * layer and sizes it to the screen itself, so we must NOT restate geometry
     * here: position:fixed / inset:0 / height:100vh resolve against the
     * OVERLAY IFRAME's viewport (372px wide), which fought the UA sizing and
     * left the toolbar positioned outside the visible area — the controls were
     * present but unhittable once full screen (#141). Cosmetics only. */
    .frame:fullscreen {
      margin: 0;
      border: none;
      border-radius: 0;
      background: #fafaf7;
      resize: none;
    }

    /* FALLBACK only — used when requestFullscreen is rejected (no permission
     * delegation, no user activation). Here there is no UA sizing to defer to,
     * so the geometry has to be stated, with the iframe-viewport caveat above
     * accepted as the best available. */
    .frame.fullscreen:not(:fullscreen) {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      height: 100vh;
      margin: 0;
      border-radius: 0;
      background: #fafaf7;
      resize: none;
    }

    .viewport {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      will-change: transform;
    }

    .edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }

    .node {
      position: absolute;
      width: ${NODE_W}px;
      border: 1px solid;
      border-radius: 9px;
      padding: 8px 9px;
      color: #1e293b;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      /* Nodes are hand-placeable, so they advertise it. Text selection is off
       * because a drag across a card would otherwise select its title instead
       * of moving it. */
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
    }

    .node:active {
      cursor: grabbing;
    }

    /* The chevron is a button, not a handle — it must keep its own affordance. */
    .node .toggle {
      cursor: pointer;
    }

    /* An expanded node grows past its laid-out NODE_H, so it overlaps whatever
     * the layout put below or beside it. This is the one place glass earns its
     * keep: the panel genuinely floats over the graph, so blurring what is
     * behind it is functional, not decoration. Without it the covered node
     * showed through the per-kind translucent tint and two layers of text sat
     * at the same coordinates, both unreadable.
     *
     * ::before carries the frost inside the expanded node's own stacking
     * context: behind the kind tint so the tint still reads, in front of every
     * other node so nothing bleeds through. */
    .node.expanded {
      z-index: 5;
      /* Drag the corner to size a node around a long claim generator or a
       * deep assertion list. min-width keeps it from collapsing below the
       * column width the layout reserved. */
      resize: both;
      overflow: auto;
      min-width: ${NODE_W}px;
      min-height: ${NODE_H}px;
      box-shadow: 0 12px 32px -12px rgba(15, 23, 42, 0.28);
    }

    .node.expanded::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: -1;
      border-radius: inherit;
      background: rgba(250, 250, 247, 0.82);
      backdrop-filter: blur(12px) saturate(115%);
      -webkit-backdrop-filter: blur(12px) saturate(115%);
    }
    .node.active { box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.35), 0 1px 2px rgba(15, 23, 42, 0.04); }

    .node-head { display: flex; align-items: flex-start; gap: 6px; }
    .node-main { min-width: 0; flex: 1; }

    .node-title {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.25;
      color: #0f172a;
      overflow-wrap: anywhere;
      white-space: normal;
    }

    .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 4px; }

    .chip {
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: rgba(15, 23, 42, 0.06);
      color: #334155;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 9px;
      font-weight: 700;
    }

    .dot { width: 5px; height: 5px; border-radius: 50%; }

    .rel { margin: 4px 0 0; font-size: 10px; font-style: italic; color: #64748b; }
    .children-hint { margin: 4px 0 0; font-size: 10px; font-weight: 600; color: #b45309; }

    .toggle {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #64748b;
      cursor: pointer;
    }
    .toggle:hover { background: rgba(15, 23, 42, 0.06); color: #0f172a; }
    .toggle svg { width: 14px; height: 14px; transition: transform 120ms ease; }
    .toggle[aria-expanded="true"] svg { transform: rotate(180deg); }

    .detail {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(148, 163, 184, 0.22);
      display: grid;
      gap: 6px;
      max-height: 180px;
      overflow: auto;
    }

    .row { display: flex; flex-direction: column; }
    .row-k { font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; color: #64748b; }
    .row-v { font-size: 11px; color: #334155; overflow-wrap: anywhere; }

    .assertion-list { margin: 2px 0 0; padding-left: 12px; }
    .assertion-list li { font-size: 11px; color: #334155; overflow-wrap: anywhere; }

    .fields {
      margin: 3px 0 0;
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 5px;
      background: rgba(15, 23, 42, 0.04);
      padding: 4px 5px;
    }
    .field { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 1px 0; }
    .field dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; color: #64748b; overflow-wrap: anywhere; }
    .field dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: #0f172a; text-align: right; overflow-wrap: anywhere; }

    .failures {
      border: 1px solid rgba(248, 113, 113, 0.4);
      background: rgba(190, 18, 60, 0.07);
      border-radius: 5px;
      padding: 5px 6px;
    }
    .failures-title { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #be123c; }
    .failures ul { margin: 3px 0 0; padding-left: 12px; }
    .failures li { font-size: 10px; color: #9f1239; overflow-wrap: anywhere; }
    .failures code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }

    .empty { font-size: 11px; font-style: italic; color: #64748b; }

    /* ── Controls ──────────────────────────────────────────────────── */
    .controls {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }

    .controls button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      background: rgba(250, 250, 247, 0.78);
      backdrop-filter: blur(10px) saturate(115%);
      -webkit-backdrop-filter: blur(10px) saturate(115%);
      color: #334155;
      font-size: 10px;
      font-weight: 600;
      padding: 3px 6px;
      cursor: pointer;
    }
    .controls button:hover { background: rgba(255, 255, 255, 0.92); color: #0f172a; }
    .controls svg { width: 12px; height: 12px; }

    /* The legend sits BELOW the canvas, not floating inside it: an expanded
     * node card is tall, and an overlay legend lands squarely on top of the
     * failure panel the user just opened. */
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 5px;
    }

    .legend { display: flex; flex-wrap: wrap; gap: 8px; }
    .legend span { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; color: #64748b; }

    .hint { font-size: 9px; color: #64748b; white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) {
      .toggle svg { transition: none; }
    }
  `

  connectedCallback (): void {
    super.connectedCallback()
    window.addEventListener('keydown', this.handleKey)
    document.addEventListener('fullscreenchange', this.syncFullscreen)
  }

  /**
   * Refit whenever the canvas actually changes size.
   *
   * Entering real full screen settles asynchronously: `fullscreenchange` fires
   * before the UA has resized the element, so the single rAF in `updated()`
   * measured the OLD 300px box and left the graph at its small-canvas scale —
   * "full screen doesn't fit". Observing the frame is the reliable trigger, and
   * it covers the user dragging the frame's resize handle for free.
   */
  private frameObserver: ResizeObserver | null = null

  protected firstUpdated (): void {
    const frame = this.shadowRoot?.querySelector('.frame')
    if (frame == null) return
    let last = 0
    this.frameObserver = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      // Ignore sub-pixel churn; only refit on a real change of canvas size.
      if (Math.abs(w - last) < 8) return
      last = w
      requestAnimationFrame(() => { this.fit() })
    })
    this.frameObserver.observe(frame)
  }

  disconnectedCallback (): void {
    window.removeEventListener('keydown', this.handleKey)
    document.removeEventListener('fullscreenchange', this.syncFullscreen)
    this.frameObserver?.disconnect()
    this.frameObserver = null
    super.disconnectedCallback()
  }

  /**
   * Enter/leave real full screen.
   *
   * The CSS-only approach this replaces could not work from here. The overlay
   * renders inside a 372px-wide extension iframe, and `position: fixed` /
   * `100vh` resolve against the IFRAME's viewport, not the page's — so
   * `.frame.fullscreen` faithfully filled a 372px box and the button looked
   * dead. Only the Fullscreen API escapes the iframe, and only if the iframe
   * carries `allow="fullscreen"` (set in overlay.ts).
   *
   * State is not flipped here. It is driven off `fullscreenchange` so the
   * browser stays the source of truth: Esc, the window chrome, and OS-level
   * exits all go through the same path as the button.
   */
  private readonly toggleFullscreen = (): void => {
    const frame = this.shadowRoot?.querySelector('.frame') as HTMLElement | null
    if (frame == null) return

    if (document.fullscreenElement == null) {
      frame.requestFullscreen?.().catch((error: unknown) => {
        // Blocked (no allow attribute, or no user-activation). Fall back to the
        // in-iframe expansion rather than leaving the button inert.
        console.debug('provenance: fullscreen request rejected, expanding in place:', error)
        this.fullscreen = true
      })
    } else {
      void document.exitFullscreen?.()
    }
  }

  /** Browser is the source of truth for full-screen state. */
  private readonly syncFullscreen = (): void => {
    this.fullscreen = document.fullscreenElement != null
  }

  /**
   * Auto-fit once per graph, and again whenever the frame changes size
   * (entering or leaving full screen). Expanding a node deliberately does NOT
   * refit — the user is reading detail, and yanking the viewport out from under
   * them mid-read is worse than a card that runs past the edge.
   */
  /**
   * Hand placement belongs to one graph. Carrying offsets into the next asset
   * would displace whichever node happened to reuse an id, so they are dropped
   * before the new graph is laid out rather than after it has been drawn.
   */
  protected willUpdate (changed: PropertyValues): void {
    if (changed.has('graph')) this.nodeOffsets.clear()
  }

  protected updated (changed: PropertyValues): void {
    const frameResized = changed.has('fullscreen')
    if (this.graph !== this.fittedGraph || frameResized) {
      this.fittedGraph = this.graph
      // Let layout settle before measuring the frame's client box.
      requestAnimationFrame(() => { this.fit() })
    }
  }

  /** Esc leaves full screen — the same escape hatch the sites' canvas offers. */
  private readonly handleKey = (event: KeyboardEvent): void => {
    // Real full screen exits on Esc natively and reports via fullscreenchange.
    // This only covers the in-place fallback, where no browser state exists.
    if (event.key === 'Escape' && this.fullscreen && document.fullscreenElement == null) {
      this.fullscreen = false
    }
  }

  private toggleNode (id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.revision++
  }

  /**
   * Return every node to its computed position. The control only exists while
   * something has been moved, so a user who tangles the graph is never left
   * without a way back short of closing the overlay.
   */
  private resetLayout (): void {
    this.nodeOffsets.clear()
    this.revision++
    requestAnimationFrame(() => { this.fit() })
  }

  private zoomBy (factor: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor))
  }

  /**
   * Scale and centre the graph so the whole chain is on screen.
   *
   * A chain of three generations is ~800 px wide, which is far wider than the
   * overlay card. Resetting to zoom 1 (what a naive "Fit" does) leaves the
   * active manifest off the right edge, so the button has to actually measure:
   * content bounds against the frame's client box.
   *
   * The scale is NOT capped at 1. It used to be, and that made Fit a no-op in
   * full screen: the frame is then the whole display, so the fit ratio is well
   * above 1, the cap pinned it back to 1, and the button only ever re-centred a
   * postage-stamp graph in a wall of empty canvas. MAX_ZOOM is the only ceiling,
   * which is what makes Fit fill a large frame and still behave in a small one,
   * where the ratio is below 1 anyway.
   */
  private fit (): void {
    const frame = this.renderRoot.querySelector('.frame')
    if (frame == null || this.contentSize == null) {
      this.zoom = 1
      this.pan = { x: 0, y: 0 }
      return
    }
    const { width: fw, height: fh } = frame.getBoundingClientRect()
    const { width: cw, height: ch } = this.contentSize
    if (fw === 0 || fh === 0 || cw === 0 || ch === 0) return

    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(fw / cw, fh / ch)))
    this.zoom = zoom
    this.pan = { x: (fw - cw * zoom) / 2, y: (fh - ch * zoom) / 2 }
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Controls must be left alone, because the setPointerCapture calls below
    // redirect the rest of the gesture to the frame: pointerup then lands on the
    // frame rather than on whatever was pressed, and the browser fires no
    // `click` at all on that element.
    //
    // The guard used to name only `.node`, which silently killed every control
    // in the toolbar — zoom out, Fit, zoom in and Full screen were all
    // unclickable, and Full screen merely got reported first (#141). Dragging
    // and wheel-zoom kept working, which is what made it read as "the button is
    // broken" rather than "the toolbar never receives clicks".
    const target = event.target as HTMLElement | null
    if (target?.closest('.controls, button, a, input, select, textarea') != null) return

    // A press on a node body moves that node; a press on the canvas pans the
    // whole view. `.node` used to fall into the same bail-out as the toolbar,
    // so nodes could not be moved at all — which is only a problem once two of
    // them overlap, and an expanded node always overlaps something.
    const nodeEl = target?.closest('.node') as HTMLElement | null
    if (nodeEl != null) {
      const id = nodeEl.dataset.nodeId
      if (id == null) return
      const current = this.nodeOffsets.get(id) ?? { x: 0, y: 0 }
      this.nodeDrag = { id, pointerX: event.clientX, pointerY: event.clientY, originX: current.x, originY: current.y }
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      return
    }

    this.dragOrigin = { x: event.clientX, y: event.clientY, panX: this.pan.x, panY: this.pan.y }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.nodeDrag
    if (drag != null) {
      // Pointer travel is in screen pixels; the viewport is scaled, so the
      // layout-space displacement is the travel divided by the zoom. Without
      // that the node lags the cursor at zoom < 1 and outruns it at zoom > 1.
      const base = this.layoutPositions.get(drag.id)
      const dx = drag.originX + (event.clientX - drag.pointerX) / this.zoom
      const dy = drag.originY + (event.clientY - drag.pointerY) / this.zoom
      // Clamped so a node cannot be pushed off the top-left, where it would be
      // clipped by the viewport and unreachable: content bounds are measured
      // from the origin, not from the minimum coordinate.
      this.nodeOffsets.set(drag.id, {
        x: base != null ? Math.max(-base.x, dx) : dx,
        y: base != null ? Math.max(-base.y, dy) : dy
      })
      this.revision++
      return
    }

    if (this.dragOrigin == null) return
    this.pan = {
      x: this.dragOrigin.panX + (event.clientX - this.dragOrigin.x),
      y: this.dragOrigin.panY + (event.clientY - this.dragOrigin.y)
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.dragOrigin = null
    this.nodeDrag = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  }

  render (): TemplateResult {
    const graph = this.graph
    if (graph == null || graph.nodes.length === 0) {
      return html`<p class="empty">No provenance chain to draw.</p>`
    }

    // `revision` is read so Lit re-renders when the expanded Set mutates.
    void this.revision

    const view = visibleSubgraph(graph, this.expanded)
    const layout = computeLayout(view)
    this.layoutPositions = layout

    // Hand-placed nodes displace the computed layout. Edges read from the same
    // merged map, so a dragged node keeps its connections rather than leaving
    // its arrows behind at the layout position.
    const positions = new Map<string, Point>()
    for (const [id, p] of layout) {
      const offset = this.nodeOffsets.get(id)
      positions.set(id, offset == null ? p : { x: p.x + offset.x, y: p.y + offset.y })
    }

    let maxX = 0
    let maxY = 0
    for (const p of positions.values()) {
      maxX = Math.max(maxX, p.x + NODE_W)
      maxY = Math.max(maxY, p.y + NODE_H)
    }
    const width = maxX + PADDING
    const height = maxY + PADDING
    this.contentSize = { width, height }

    const childCount = new Map<string, number>()
    for (const n of graph.nodes) {
      if (n.parentId != null) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1)
    }

    return html`
      <div
        class="frame ${this.fullscreen ? 'fullscreen' : ''}"
        @wheel=${this.onWheel}
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerUp}
      >
        <div
          class="viewport"
          style="transform: translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom}); width:${width}px; height:${height}px"
        >
          <svg class="edges" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"></path>
              </marker>
            </defs>
            ${view.edges.map((edge) => this.renderEdge(positions.get(edge.source), positions.get(edge.target), edge.label))}
          </svg>
          ${view.nodes.map((node) => this.renderNode(node, positions.get(node.id), (childCount.get(node.id) ?? 0) > 0))}
        </div>

        <div class="controls">
          <button type="button" title="Zoom out" aria-label="Zoom out" @click=${() => { this.zoomBy(1 / 1.2) }}>−</button>
          <button type="button" title="Reset view" aria-label="Reset view" @click=${() => { this.fit() }}>Fit</button>
          ${this.nodeOffsets.size > 0
            ? html`<button
                type="button"
                title="Undo hand placement and return every node to the computed layout"
                aria-label="Reset layout"
                @click=${() => { this.resetLayout() }}
              >Reset layout</button>`
            : nothing}
          <button type="button" title="Zoom in" aria-label="Zoom in" @click=${() => { this.zoomBy(1.2) }}>+</button>
          <button
            type="button"
            aria-pressed=${this.fullscreen ? 'true' : 'false'}
            title=${this.fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            @click=${this.toggleFullscreen}
          >${this.fullscreen ? 'Exit' : 'Full screen'}</button>
        </div>

      </div>

      <div class="footer">
        ${this.renderLegend(view)}
        <span class="hint">drag a node to move it · drag the canvas to pan · scroll to zoom · ▸ expands a node</span>
      </div>
    `
  }

  private renderLegend (view: ProvenanceGraph): TemplateResult {
    const seen = new Map<string, StateStyle>()
    for (const n of view.nodes) {
      const style = styleFor(n)
      if (!seen.has(style.label)) seen.set(style.label, style)
    }
    return html`
      <div class="legend">
        ${[...seen.entries()].map(([label, style]) => html`
          <span><i class="dot" style="background:${style.accent}"></i>${label}</span>
        `)}
      </div>
    `
  }

  private renderEdge (from: Point | undefined, to: Point | undefined, label: string): TemplateResult | typeof nothing {
    if (from == null || to == null) return nothing
    // Edges leave the source's right edge and enter the target's left edge —
    // the same left-to-right generation flow the sites draw.
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    const midX = (x1 + x2) / 2
    const labelY = (y1 + y2) / 2 - 5
    return svg`
      <path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}"
            stroke="#cbd5e1" stroke-width="1.5" fill="none"
            stroke-linecap="round" marker-end="url(#pg-arrow)" opacity="0.85"></path>
      ${label !== ''
        ? svg`<text x="${midX}" y="${labelY}" text-anchor="middle" font-size="10" fill="#64748b">${label}</text>`
        : nothing}
    `
  }

  private renderNode (node: ProvenanceNode, pos: Point | undefined, hasChildren: boolean): TemplateResult | typeof nothing {
    if (pos == null) return nothing
    const style = styleFor(node)
    const isExpanded = this.expanded.has(node.id)
    const isAssertion = node.kind === 'assertion' || node.kind === 'sensor'
    const detailId = `pg-detail-${node.id}`

    return html`
      <div
        class="node ${isExpanded ? 'expanded' : ''} ${node.isActive ? 'active' : ''}"
        data-node-id=${node.id}
        style="left:${pos.x}px; top:${pos.y}px; border-color:${style.accent}; background:${style.bg}"
      >
        <div class="node-head">
          <div class="node-main">
            <h4 class="node-title" title=${node.title ?? node.label}>${node.label}</h4>
            <div class="chips">
              ${node.formatLabel !== '' ? html`<span class="chip">${node.formatLabel}</span>` : nothing}
              <span class="badge" style="background:${style.badgeBg}; color:${style.accent}">
                <i class="dot" style="background:${style.accent}"></i>${node.isActive ? 'Active' : style.label}
              </span>
            </div>
            ${node.relationship != null && node.relationship !== ''
              ? html`<p class="rel">${node.relationship}</p>`
              : nothing}
            ${hasChildren
              ? html`<p class="children-hint">
                  ${isExpanded ? '▾ ' : '▸ '}${node.ingredientCount} sensor${node.ingredientCount === 1 ? '' : 's'}${isExpanded ? '' : ' — click to reveal'}
                </p>`
              : nothing}
          </div>
          <button
            type="button"
            class="toggle"
            aria-expanded=${isExpanded ? 'true' : 'false'}
            aria-controls=${detailId}
            aria-label="${isExpanded ? 'Collapse' : 'Expand'} details for ${node.label}"
            @click=${() => { this.toggleNode(node.id) }}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd"></path>
            </svg>
          </button>
        </div>

        ${isExpanded ? this.renderDetail(node, isAssertion, detailId) : nothing}
      </div>
    `
  }

  private renderDetail (node: ProvenanceNode, isAssertion: boolean, detailId: string): TemplateResult {
    const fields = node.dataFields ?? []
    return html`
      <div class="detail" id=${detailId}>
        ${node.signer != null
          ? html`
              ${row('Issuer', node.signer.issuer)}
              ${row('Algorithm', node.signer.alg)}
              ${row('Signed', node.signer.time)}
            `
          : nothing}

        ${row('Claim generator', node.claimGenerator)}

        ${node.assertions.length > 0
          ? html`
              <div class="row">
                <span class="row-k">Assertions (${node.assertions.length})</span>
                <ul class="assertion-list">
                  ${node.assertions.map((a) => html`<li>${a}</li>`)}
                </ul>
              </div>
            `
          : nothing}

        ${isAssertion
          ? html`
              <div class="row">
                <span class="row-k">
                  ${node.isTelemetry === true ? 'Telemetry data' : 'Assertion data'}${node.dataKind != null ? ` · ${node.dataKind}` : ''}
                </span>
                ${fields.length > 0
                  ? html`<dl class="fields">
                      ${fields.map((f) => html`
                        <div class="field"><dt>${f.key}</dt><dd>${f.value}</dd></div>
                      `)}
                    </dl>`
                  : html`<span class="empty">No structured data</span>`}
              </div>
            `
          : nothing}

        ${node.validationStatus.length > 0
          ? html`
              <div class="failures">
                <span class="failures-title">Validation failures</span>
                <ul>
                  ${node.validationStatus.map((v) => html`
                    <li><code>${v.code}</code>${v.explanation != null && v.explanation !== '' ? ` — ${v.explanation}` : ''}</li>
                  `)}
                </ul>
              </div>
            `
          : nothing}

        ${!isAssertion && node.ingredientCount > 0 ? row('Ingredients', String(node.ingredientCount)) : nothing}
        ${!isAssertion ? row('Instance ID', node.instanceId) : nothing}
      </div>
    `
  }
}

/** A labelled key/value row, rendered only when the value is present. */
function row (label: string, value: string | null | undefined): TemplateResult | typeof nothing {
  if (value == null || value === '') return nothing
  return html`
    <div class="row">
      <span class="row-k">${label}</span>
      <span class="row-v">${value}</span>
    </div>
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'c2pa-provenance-graph': C2paProvenanceGraph
  }
}
