/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { MSG_UPDATE_FRAME_HEIGHT, OVERLAY_Z_INDEX, type MSG_PAYLOAD } from './constants'

export class C2paOverlay /* extends HTMLElement */ {
  private static singleInstance: C2paOverlay
  private readonly _iframe: HTMLIFrameElement

  private constructor () {
    const iframe: HTMLIFrameElement = document.createElement('iframe')
    iframe.className = 'c2paDialog'
    iframe.src = `${chrome.runtime.getURL('iframe.html')}`
    iframe.tabIndex = 0
    // #129: name the frame for assistive tech (was an anonymous "frame").
    iframe.title = 'Content Credentials verification'
    // The provenance diagram's "Full screen" control needs to escape this
    // iframe. Without the permission, `requestFullscreen()` inside the frame is
    // rejected, and the CSS fallback (`position: fixed; height: 100vh`) resolves
    // against THIS iframe's 372px viewport rather than the page's — the button
    // appears to do nothing at all. `allow` is the current Permissions-Policy
    // delegation; `allowFullscreen` is the legacy attribute some engines still
    // gate on. Setting BOTH makes Chrome log "Allow attribute will take
    // precedence over 'allowfullscreen'" into the extension's error pane for
    // every page the content script touches, so the legacy spelling is applied
    // only where `allow` is genuinely unavailable.
    iframe.allow = 'fullscreen'
    if (!('allow' in HTMLIFrameElement.prototype)) {
      iframe.allowFullscreen = true
    }
    // rc11.2 / #70 — give the iframe real default dimensions + an opaque
    // background so it's actually a visible panel on first paint rather than
    // a 302×2 transparent slit hidden behind the page content. Width /
    // min-height match the :host min-dimensions on <c2pa-overlay> so the
    // ResizeObserver → MSG_UPDATE_FRAME_HEIGHT path has something to latch
    // onto. color-scheme:light nails the iframe to a white background even
    // under UA dark-mode to avoid the panel rendering dark-on-dark.
    // Every rule gets `!important` — the overlay is injected into arbitrary
    // third-party pages whose own CSS can reset position/z-index/width, and
    // in the rc11/rc10 field reports the panel was rendering behind page
    // content with an effective height of 2px. The previous single-
    // `.replace(';', '!important;')` only hardened the first declaration.
    const important = (rules: Record<string, string>): string =>
      Object.entries(rules).map(([k, v]) => `${k}: ${v} !important`).join('; ')
    // Transparent, chromeless iframe: the <c2pa-overlay> custom element draws
    // its own frosted-glass card (rounded corners, border, shadow) and floats
    // over the host page. The iframe needs a little extra width/height beyond
    // the card so the card's drop-shadow isn't clipped by overflow:hidden.
    iframe.style.cssText = important({
      position: 'absolute',
      'z-index': String(OVERLAY_Z_INDEX),
      visibility: 'hidden',
      resize: 'none',
      overflow: 'hidden',
      background: 'transparent',
      'color-scheme': 'dark',
      width: '372px',
      'min-height': '200px',
      'border-radius': '16px',
      border: 'none',
      'box-shadow': 'none'
    })
    this._iframe = iframe
    this.hide()

    // Attach now if the document is already parsed. The listener alone was a
    // one-shot bet that this script always runs before DOMContentLoaded, which
    // holds for the `document_start` registration and fails for every other
    // entry into this code — a re-injection after an extension reload or
    // update, or any `chrome.scripting.executeScript` into a loaded tab. The
    // event has already fired by then, so the overlay iframe was never added to
    // the page and every verification silently had nowhere to draw.
    const attach = (): void => { document.body.appendChild(iframe) }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true })
    } else {
      attach()
    }

    /*
      The IFrame cannot resize itself from within the IFrame.
      It needs the parent to resize it.
    */
    chrome.runtime.onMessage.addListener(
      (request: MSG_PAYLOAD, sender, sendResponse) => {
        if (request.action === MSG_UPDATE_FRAME_HEIGHT) {
          this._iframe.style.height = `${request.data as number}px`
        }
      }
    )
  }

  public static get overlay (): C2paOverlay {
    if (this.singleInstance == null) {
      this.singleInstance = new C2paOverlay()
    }
    return this.singleInstance
  }

  show (x: number, y: number): void {
    this.position(x, y)
    this._iframe.style.visibility = 'visible'
    this._iframe.focus()
  }

  hide (): void {
    if (this._iframe.style.visibility !== 'hidden') {
      this._iframe.style.visibility = 'hidden'
    }
  }

  position (x: number, y: number): void {
    const margin = 5

    const leftPosition = window.scrollX + x + margin
    const adjustedLeftPosition =
        x + this._iframe.offsetWidth + margin > window.innerWidth
          ? window.innerWidth - this._iframe.offsetWidth + window.scrollX - margin
          : leftPosition

    const topPosition = window.scrollY + y
    const adjustedTopPosition =
        y + this._iframe.offsetHeight + margin > window.innerHeight
          ? window.innerHeight - this._iframe.offsetHeight + window.scrollY - margin
          : topPosition

    this._iframe.style.left = `${adjustedLeftPosition}px`
    this._iframe.style.top = `${adjustedTopPosition}px`
  }
}
