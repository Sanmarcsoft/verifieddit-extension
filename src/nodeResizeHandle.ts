/*
 * Where the UA's resize gripper is, so a pointer press can be left alone.
 *
 * `.node.expanded` sets `resize: both`, which makes Chromium paint a gripper in
 * the bottom-right corner of the node. That gripper is not an element: there is
 * nothing to put in a selector, nothing to attach a listener to, and nothing
 * `event.target.closest()` can find. It is a painted corner of the node's own
 * box, and the only way to recognise a press on it is geometry.
 *
 * That matters because `onPointerDown` in provenanceDiagram.ts treats any press
 * on `.node` as the start of a node drag and calls setPointerCapture on the
 * frame, which redirects the rest of the gesture away from the node. The
 * gripper therefore never received a drag and `resize: both` did nothing from
 * the day it landed.
 *
 * The band is scaled because the node lives inside a `transform: scale(zoom)`
 * viewport: a bounding rect is in screen pixels, the gripper is painted in the
 * element's own coordinate space, so on screen it covers `RESIZER_SIZE_PX *
 * zoom`. The node-drag path divides pointer travel by the same zoom for the
 * same reason.
 *
 * Pure geometry on purpose. Whether the node is resizable at all is the
 * caller's business, because only `.node.expanded` carries `resize: both`.
 */

/**
 * Chromium sizes the resizer from the scrollbar metric, which is 15 CSS px on
 * every platform we ship to. Firefox paints a comparable corner. A couple of
 * pixels either way only shifts where a drag turns into a move.
 */
export const RESIZER_SIZE_PX = 15

export interface ResizeHandleHit {
  /** Screen-space box of the node, as `getBoundingClientRect` returns it. */
  rect: { left: number, top: number, right: number, bottom: number }
  clientX: number
  clientY: number
  /** Viewport scale. Anything non-positive is read as 1. */
  zoom?: number
  /** Override for tests and for a UA with a different gripper. */
  resizerSize?: number
}

/** True when the press lands on the bottom-right resize gripper. */
export function isResizeHandlePress (hit: ResizeHandleHit): boolean {
  const { rect, clientX, clientY } = hit

  if (![clientX, clientY, rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) {
    return false
  }

  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  // A collapsed or inverted box has no corner to grab. Without this a press at
  // the origin of a 0x0 rect reads as a hit and swallows the gesture.
  if (width <= 0 || height <= 0) return false

  // Narrow through a local rather than asserting: an undefined or non-finite
  // zoom is a normal caller state, not something to promise the type system.
  const rawZoom = hit.zoom
  const zoom = rawZoom != null && Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1
  const size = hit.resizerSize ?? RESIZER_SIZE_PX
  // Never let the band cover the whole node: on a node smaller than the gripper
  // every press would count as a resize and the node could not be moved.
  const band = Math.min(size * zoom, width, height)

  return clientX <= rect.right && clientX >= rect.right - band &&
         clientY <= rect.bottom && clientY >= rect.bottom - band
}
