/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { MSG_DISPLAY_C2PA_OVERLAY, MSG_FORWARD_TO_CONTENT, MSG_UPDATE_FRAME_HEIGHT, MSG_OPEN_OVERLAY, PORT_OVERLAY_FRAME, PORT_RECONNECT_DELAY, MSG_RELAY_READY, RELAY_STATE_ATTR, RELAY_EVENT_ATTR } from './constants'
import { type C2paOverlay } from './webComponents'
import { type C2paResult } from './c2pa'

export interface FrameMessage {
  secret: string
  action: string
  data: unknown
}

let _overlay: C2paOverlay | null = null
// Buffer overlay messages that arrive before window.onload fires (#57).
let _pendingOverlay: { c2paResult: C2paResult, position: { x: number, y: number } } | null = null

/**
 * Apply an overlay payload, or buffer it if the custom element isn't up yet.
 *
 * window.onload is what makes <c2pa-overlay> queryable, and a click can land
 * before that (#57), so an early payload is held and replayed on load rather
 * than dropped.
 */
function openOverlay (c2paResult: C2paResult, position: { x: number, y: number }): void {
  if (_overlay !== null) {
    _overlay.c2paResult = c2paResult
    document.documentElement.dataset[RELAY_EVENT_ATTR] = `applied@${position.x},${position.y}`
    sendToContent({ action: MSG_DISPLAY_C2PA_OVERLAY, data: { position } })
  } else {
    _pendingOverlay = { c2paResult, position }
    document.documentElement.dataset[RELAY_EVENT_ATTR] = 'buffered'
  }
}

/**
 * Mirror relay state onto <html data-vd-relay> so it can be observed.
 *
 * #149 was invisible precisely because every layer reported success: the click
 * fired, the send resolved, nothing threw, and the overlay stayed shut. This
 * attribute is the one place the relay says out loud whether it is actually
 * routable, and `scripts/firefox-smoke.mjs --click` reads it from inside the
 * frame. Diagnostic only — no behaviour branches on it.
 */
function setRelayState (state: string): void {
  document.documentElement.dataset[RELAY_STATE_ATTR] = state
}

/**
 * Open the relay port to the background and listen for overlay payloads (#149).
 *
 * This frame is an extension page embedded as an iframe in the host tab. It
 * CANNOT be reached by `chrome.tabs.sendMessage` (content scripts only) and,
 * under Gecko, it is not reached by a content script's
 * `chrome.runtime.sendMessage` either — Chrome fans that out to every extension
 * context, Firefox does not, and the send resolves without throwing. That
 * silent gap is #149: the badge click worked, the message went nowhere, and the
 * overlay never opened on a build that had already passed addons-linter.
 *
 * A named port is the one channel that lands on both engines, so it is the only
 * way this frame receives payloads. Deliberately NOT paired with a
 * `runtime.onMessage` fallback: on Chrome both would fire and the overlay would
 * be populated twice, and a path that only executes on one engine is precisely
 * the kind of divergence that produced this bug.
 *
 * Note there is no `window.message` listener here, and there must not be one.
 * The host page can reach `iframe.contentWindow`, so accepting postMessage would
 * let an arbitrary page draw a fake "verified" panel under Verifieddit branding
 * — a UI-spoofing surface no nonce closes, since the page can read `iframe.src`.
 */
function connectRelay (): void {
  // A dead extension context (reload/update/disable) makes connect() throw.
  if (chrome.runtime?.id == null) {
    setRelayState('no-context')
    return
  }
  try {
    const port = chrome.runtime.connect({ name: PORT_OVERLAY_FRAME })
    setRelayState('connected')

    port.onMessage.addListener((message: { action: string, data: any }) => {
      if (message.action === MSG_RELAY_READY) {
        // The background resolved a tab for us, or told us it could not. Only
        // the former means a click can actually reach this frame.
        const tabId = message.data?.tabId
        setRelayState(tabId == null ? 'unroutable' : `ready:${String(tabId)}`)
        return
      }
      if (message.action !== MSG_OPEN_OVERLAY) return
      openOverlay(message.data.c2paResult as C2paResult, message.data.position as { x: number, y: number })
    })

    port.onDisconnect.addListener(() => {
      setRelayState('disconnected')
      // The MV3 background is torn down when idle, taking every port with it.
      // Reconnect so the next click still has a channel — but only while the
      // extension context is alive, so an uninstall doesn't spin forever.
      if (chrome.runtime?.id == null) return
      setTimeout(connectRelay, PORT_RECONNECT_DELAY)
    })
  } catch (error: unknown) {
    setRelayState('connect-threw')
    console.debug('overlayFrame: relay port unavailable:', error)
  }
}

connectRelay()

// DOMContentLoaded is too early to access c2pa-overlay, so we wait for window.onload
window.onload = () => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  _overlay = document.querySelector('c2pa-overlay')!
  resizeObserver.observe(document.body)
  if (_pendingOverlay !== null) {
    _overlay.c2paResult = _pendingOverlay.c2paResult
    sendToContent({ action: MSG_DISPLAY_C2PA_OVERLAY, data: { position: _pendingOverlay.position } })
    _pendingOverlay = null
  }
}

const resizeObserver = new ResizeObserver(entries => {
  // We are only observing the body element, so expect only one entry
  for (const entry of entries) {
    const newHeight = Math.floor(entry.contentRect.height)
    sendToContent({ action: MSG_UPDATE_FRAME_HEIGHT, data: newHeight })
  }
})

/**
 * Post a message to the content script, tolerating a dead extension context.
 *
 * When the extension is reloaded, updated, or disabled, every already-injected
 * overlay iframe keeps running against a context that no longer exists, and
 * `chrome.runtime.sendMessage` throws "Extension context invalidated"
 * SYNCHRONOUSLY. The old body left that unguarded, so the throw escaped through
 * the ResizeObserver callback as an uncaught error on the host page — visible
 * to the user, attributed to our extension, on a page they never asked us to
 * break. Chrome auto-updates extensions in the background, so this was not
 * confined to development.
 *
 * `chrome.runtime.id` is undefined once the context is gone, which is the
 * cheapest reliable probe. Losing the context is terminal for this frame, so we
 * also stop observing rather than re-throwing on every resize tick.
 */
function sendToContent (message: unknown): void {
  if (chrome.runtime?.id == null) {
    resizeObserver.disconnect()
    return
  }
  try {
    void chrome.runtime.sendMessage({ action: MSG_FORWARD_TO_CONTENT, data: message })
  } catch (error: unknown) {
    // The context can die between the id check and the send.
    resizeObserver.disconnect()
    console.debug('overlayFrame: dropping message, extension context gone:', error)
  }
}
