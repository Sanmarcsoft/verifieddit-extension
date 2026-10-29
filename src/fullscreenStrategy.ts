/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

/**
 * How the "Full screen" control should behave in the host it is mounted in.
 *
 * `element` promotes the diagram with the Fullscreen API. `tab` hands the graph
 * back to the host to reopen somewhere with room.
 */
export type FullscreenStrategy = 'element' | 'tab'

export interface FullscreenCapability {
  /** What the host asked for, if it has an opinion. Wins when it is valid. */
  requested?: FullscreenStrategy
  /** `document.fullscreenEnabled` as observed by the component. */
  fullscreenEnabled?: boolean
}

/**
 * Decides between promoting the element and reopening in a tab.
 *
 * Kept pure and out of the component because the wrong answer here is invisible
 * rather than loud: the old code always called requestFullscreen, and when the
 * host refused, the CSS fallback expanded the frame to `inset: 0` against a
 * viewport it already filled. Every layer reported success and the button
 * looked dead. A decision that can be asserted in isolation is the only way
 * that failure mode stays caught.
 *
 * An explicit host request wins, because a host can know things the feature
 * test cannot: the toolbar popup is a transient 380px window, so even where
 * fullscreen is technically permitted it is not somewhere worth expanding into.
 * A `fullscreenEnabled` of false is decisive on its own, since that is the API
 * telling us the call would be refused.
 */
export function resolveFullscreenStrategy (capability: FullscreenCapability): FullscreenStrategy {
  const { requested, fullscreenEnabled } = capability

  // Validate rather than trust: this crosses a DOM-attribute boundary, where a
  // typo produces a string the type system never sees.
  if (requested === 'tab' || requested === 'element') return requested

  return fullscreenEnabled === false ? 'tab' : 'element'
}
