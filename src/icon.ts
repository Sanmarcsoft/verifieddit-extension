/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { badgeSvg, explainBadge, isBadgeStatus, type BadgeStatus } from './badgeArt'
import { CR_ICON_SIZE, CR_ICON_Z_INDEX, type VALIDATION_STATUS, CR_ICON_MARGIN_RIGHT, CR_ICON_MARGIN_TOP, CR_ICON_AUDIO_MARGIN_TOP, CR_ICON_AUDIO_MARGIN_RIGHT } from './constants'
import { type MediaElement } from './mediaRecord'

// C2PA CR branding — two-tone scheme baked in per status (fix #52).
// Root cause of the prior "just a color" rendering: the inline SVG strings
// used %23 (URL-encoded '#') inside color values, but they are then passed
// through encodeURIComponent at runtime which re-escapes the '%' to '%25'.
// The browser decodes the data URL exactly once so the SVG parser sees
// literal "%23000" — not a valid color — and falls back to the inherited
// root fill, making the CR letters and warning/error accents invisible.
// Fix: use raw '#' hex in the template literals so encodeURIComponent
// produces a valid data URL, and bake a status-appropriate contrast colour
// into every path so nothing is left to inheritance.


// rc11.7 / #86 — "checked, no credentials found". Neutral grey camera
// silhouette with a red circle-with-slash overlay in the lower-right so
// users can tell "we verified and this image carries no cryptographic
// provenance" apart from "we haven't verified yet" (the transient img
// state during scan) and from "has credentials, trust unknown" (warning).

// #184 — "credentials were stripped, and a registered credential matches this
// picture". Deliberately NOT the grey slashed camera: that says "nothing here",
// this says "something was here, and we found where it is registered". Blue,
// full strength, with a recovery arrow. It is still not a verdict on the file in
// hand, so it is never green.

const BADGE_STATUSES: BadgeStatus[] = ['success', 'success-durable', 'ai-success', 'ai-success-durable', 'warning', 'warning-durable', 'error', 'error-durable', 'ai-error', 'stripped', 'stripped-unrecovered', 'no-credentials', 'unavailable']

// Verdict badges come from badgeArt.ts (#184, art/badges.pen "Badge system v3"),
// which also holds each badge's plain-language explanation. The three media
// placeholders are the only entries that are not verdicts.
const imageSources: { [key in VALIDATION_STATUS]: string } = {
  img: chrome.runtime.getURL('icons/camera.svg'),
  video: chrome.runtime.getURL('icons/video.svg'),
  audio: chrome.runtime.getURL('icons/audio.svg'),
  none: '',
  ...Object.fromEntries(BADGE_STATUSES.map((st) => [st, badgeSvg(st)]))
} as { [key in VALIDATION_STATUS]: string }

// The "no credentials" verdict is a real finding, but a weaker one than any
// verdict about a signature: nothing was cryptographically checked because
// there was nothing to check. Rendering it at full strength gives it the same
// visual weight as a trusted or invalid badge. Held at partial opacity in both
// the in-page overlay and the popup so the eye reads it as "we looked, there is
// nothing here" rather than as a judgement on the file's authenticity.
// v3: no credentials is drawn at full strength (white, red outline, red slash).
export const CR_ICON_NO_CREDENTIALS_OPACITY = '1'

/**
 * The badge art for a status, as a data URL. Exported so the popup renders the
 * exact same icon set as the in-page overlay instead of maintaining a parallel
 * mapping to files in `icons/` that has already drifted once.
 */
export function crIconDataUrl (status: VALIDATION_STATUS): string {
  const source = imageSources[status] ?? ''
  // The camera/video/audio entries are already extension URLs, not SVG markup.
  if (!source.startsWith('<svg')) return source
  return `data:image/svg+xml;utf8,${encodeURIComponent(source)}`
}

export class CrIcon {
  private _crDiv!: HTMLDivElement | null
  private readonly _parent: MediaElement
  private _status: VALIDATION_STATUS
  private _clickListener: ((this: HTMLDivElement, ev: MouseEvent) => unknown) | undefined

  constructor (parent: MediaElement, status: VALIDATION_STATUS) {
    this._parent = parent
    this._status = status
    
    const iconDiv = document.createElement('div')
    iconDiv.className = 'c2pa-icon-container'
    iconDiv.style.position = 'absolute'
    iconDiv.style.width = CR_ICON_SIZE
    iconDiv.style.height = CR_ICON_SIZE
    iconDiv.style.zIndex = CR_ICON_Z_INDEX.toString()
    iconDiv.style.cursor = 'pointer'
    iconDiv.setAttribute('c2pa-icon', 'c2pa-icon')
    
    this._crDiv = iconDiv
    document.body.appendChild(this._crDiv)
    this.setStatus(status) // Set initial SVG and color
    this.show()
  }

  public setMetadataLink (url: string): void {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    // Hover says what the badge means, in plain words; the click shows the detail.
    const status = this._status
    this._crDiv.title = isBadgeStatus(status)
      // The address stays on its own last line: it says which file the badge is about.
      ? `${explainBadge(status).title}. ${explainBadge(status).text} Click for details.\n${url}`
      : `Click to view Content Credentials: ${url}`
  }

  public remove (): void {
    if (this._crDiv == null) return
    this._crDiv.onclick = null
    this._clickListener = undefined
    this._crDiv.remove()
    this._crDiv = null
  }

  public get img (): HTMLDivElement { // Changed return type to HTMLDivElement
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    return this._crDiv
  }

  public hide (): void {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    this._crDiv.style.display = 'none'
  }

  public show (): void {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    this._crDiv.style.display = ''
    this.position()
  }

  public position (topOffset = this._status === 'audio' ? CR_ICON_AUDIO_MARGIN_TOP : CR_ICON_MARGIN_TOP, rightOffset = this._status === 'audio' ? CR_ICON_AUDIO_MARGIN_RIGHT : CR_ICON_MARGIN_RIGHT): void {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    const rect = this._parent.getBoundingClientRect()
    this._crDiv.style.top = `${rect.top + window.scrollY + topOffset}px`
    this._crDiv.style.left = `${rect.right + window.scrollX - this._crDiv.offsetWidth - rightOffset}px` // Use offsetWidth
  }

  // IDL `onclick` handler, not `addEventListener`. Root-cause of the long-
  // standing "click does nothing" bug through rc10: addEventListener("click")
  // registered against the _crDiv element from an extension content-script
  // isolated world did not fire on user-initiated clicks on verifieddit.com
  // /demo (verified via Playwright + CDP DOMDebugger.getEventListeners across
  // rc9 and rc10 — zero listeners observed despite the setter executing). IDL
  // handlers (`el.onclick = fn`) are stored as a property on the element and
  // fire reliably regardless of the world that assigned them. Keeping the
  // listener reference around so remove() can null it cleanly.
  // eslint-disable-next-line accessor-pairs
  set onClick (listener: ((this: HTMLDivElement, ev: MouseEvent) => unknown) | null) {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    this._clickListener = listener ?? undefined
    this._crDiv.onclick = listener == null
      ? null
      : (ev: MouseEvent): void => {
          try {
            listener.call(this._crDiv as HTMLDivElement, ev)
          } catch (err) {
          }
        }
  }

  get status (): VALIDATION_STATUS {
    return this._status
  }

  set status (status: VALIDATION_STATUS) {
    if (this._crDiv == null) {
      throw new Error('Icon not created')
    }
    if (!CrIcon.validateStatus(status)) {
      throw new Error('Invalid status')
    }
    this._status = status
    this.setStatus(status) // Call new helper to update SVG
  }

  private setStatus (status: VALIDATION_STATUS): void {
    let fillColor = 'green'
    if (status === 'warning') {
      fillColor = '#FFC000' // Yellow/Orange for warning
    } else if (status === 'error') {
      fillColor = '#ae3f28' // Red for error
    }

    const svgContent = imageSources[status].replace(/CURRENT_COLOR/g, fillColor)
    this._crDiv!.style.backgroundImage = `url('data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}')`
    this._crDiv!.style.backgroundSize = 'contain'
    this._crDiv!.style.backgroundRepeat = 'no-repeat'
    // Re-applied on every status change, not just on the no-credentials branch:
    // an icon that was set to 'no-credentials' and is later upgraded (right-click
    // on an image the auto-scan had not reached) would otherwise stay faded.
    this._crDiv!.style.opacity = status === 'no-credentials' ? CR_ICON_NO_CREDENTIALS_OPACITY : ''
  }

  private static validateStatus (status: unknown): status is VALIDATION_STATUS {
    return ['success', 'warning', 'error', 'img', 'video', 'audio', 'none', 'ai-success', 'ai-error', 'no-credentials', 'stripped', 'success-durable', 'ai-success-durable', 'warning-durable', 'error-durable', 'stripped-unrecovered', 'unavailable'].includes(status as string)
  }
}
