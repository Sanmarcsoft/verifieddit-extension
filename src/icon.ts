/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

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
const SVG_CR_SUCCESS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><path fill="#2a8a3c" stroke="#1f6a2c" stroke-width="2" d="M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z" /><path fill="#ffffff" d="M13.665 26.483c-4.07 0-6.61-3.189-6.61-6.973 0-3.785 2.54-6.973 6.61-6.973 3.292 0 5.522 2.152 6.118 4.951h-3.318c-.441-1.244-1.478-1.996-2.8-1.996-2.048 0-3.396 1.607-3.396 4.018s1.348 4.018 3.396 4.018c1.374 0 2.437-.804 2.852-2.126h3.292c-.545 2.878-2.8 5.08-6.144 5.08M21.12 26.12V12.9h3.11v1.426c.726-.96 1.866-1.582 3.577-1.582h.804v3.06h-.83c-1.166 0-1.892.258-2.436.75-.622.52-.985 1.375-.985 2.67v6.896z" /></svg>`
const SVG_CR_WARNING = `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 157 141" overflow="hidden"><path fill="#f0a500" stroke="#8a5e00" stroke-width="6" d="M5.37 61.9c0-31.22 25.31-56.53 56.54-56.53s56.54 25.31 56.54 56.54v56.53H61.9c-31.22 0-56.53-25.31-56.53-56.54Z" /><path fill="#1a1a1a" d="M46.99 91.08C33 91.08 24.26 80.11 24.26 67.1c0-13.02 8.74-23.98 22.73-23.98 11.33 0 18.99 7.39 21.04 17.02H56.62c-1.51-4.28-5.08-6.86-9.63-6.86-7.04 0-11.67 5.52-11.67 13.82 0 8.29 4.63 13.81 11.67 13.81 4.73 0 8.38-2.76 9.81-7.31h11.32c-1.87 9.9-9.63 17.48-21.13 17.48M72.63 89.83V44.36h10.7v4.91c2.49-3.3 6.42-5.44 12.3-5.44h2.76v10.52h-2.85c-4.01 0-6.51.89-8.38 2.58-2.14 1.79-3.39 4.73-3.39 9.18v23.72z" /><path fill="#c83232" stroke="#7a1f1f" stroke-width="3" d="m152.444 124.167-32.99-54.542c-1.266-2.166-4.557-2.166-5.823 0l-33.075 54.542c-1.265 2.165.338 4.812 2.953 4.812h65.981c2.616 0 4.22-2.647 2.954-4.812" /><path fill="#ffffff" d="m114.531 82.458 5.062.001v28.072h-5.062zm2.531 39.302c-2.362 0-4.219-1.764-4.219-4.01s1.857-4.01 4.22-4.01 4.218 1.764 4.218 4.01-1.856 4.01-4.219 4.01" /></svg>`
const SVG_CR_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><path fill="#c83232" stroke="#7a1f1f" stroke-width="2" d="M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z" /><path fill="#ffffff" d="M13.665 26.483c-4.07 0-6.61-3.189-6.61-6.973 0-3.785 2.54-6.973 6.61-6.973 3.292 0 5.522 2.152 6.118 4.951h-3.318c-.441-1.244-1.478-1.996-2.8-1.996-2.048 0-3.396 1.607-3.396 4.018s1.348 4.018 3.396 4.018c1.374 0 2.437-.804 2.852-2.126h3.292c-.545 2.878-2.8 5.08-6.144 5.08M21.12 26.12V12.9h3.11v1.426c.726-.96 1.866-1.582 3.577-1.582h.804v3.06h-.83c-1.166 0-1.892.258-2.436.75-.622.52-.985 1.375-.985 2.67v6.896z" /><rect x="25" y="25" width="16" height="16" rx="1.5" ry="1.5" fill="#1a1a1a" /><path d="m28 28 10.4 10.4M28 38.4 38.4 28" stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none" /></svg>`

const SVG_CR_AI_SUCCESS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><path fill="#2a8a3c" stroke="#1f6a2c" stroke-width="2" d="M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z" /><path fill="#ffffff" d="M13.665 26.483c-4.07 0-6.61-3.189-6.61-6.973 0-3.785 2.54-6.973 6.61-6.973 3.292 0 5.522 2.152 6.118 4.951h-3.318c-.441-1.244-1.478-1.996-2.8-1.996-2.048 0-3.396 1.607-3.396 4.018s1.348 4.018 3.396 4.018c1.374 0 2.437-.804 2.852-2.126h3.292c-.545 2.878-2.8 5.08-6.144 5.08M21.12 26.12V12.9h3.11v1.426c.726-.96 1.866-1.582 3.577-1.582h.804v3.06h-.83c-1.166 0-1.892.258-2.436.75-.622.52-.985 1.375-.985 2.67v6.896z" /><rect x="25" y="25" width="10" height="10" rx="1.5" ry="1.5" fill="#1a1a1a" /></svg>`
const SVG_CR_AI_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><path fill="#c83232" stroke="#7a1f1f" stroke-width="2" d="M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z" /><path fill="#ffffff" d="M13.665 26.483c-4.07 0-6.61-3.189-6.61-6.973 0-3.785 2.54-6.973 6.61-6.973 3.292 0 5.522 2.152 6.118 4.951h-3.318c-.441-1.244-1.478-1.996-2.8-1.996-2.048 0-3.396 1.607-3.396 4.018s1.348 4.018 3.396 4.018c1.374 0 2.437-.804 2.852-2.126h3.292c-.545 2.878-2.8 5.08-6.144 5.08M21.12 26.12V12.9h3.11v1.426c.726-.96 1.866-1.582 3.577-1.582h.804v3.06h-.83c-1.166 0-1.892.258-2.436.75-.622.52-.985 1.375-.985 2.67v6.896z" /><rect x="25" y="25" width="16" height="16" rx="1.5" ry="1.5" fill="#1a1a1a" /><path d="m28 28 10.4 10.4M28 38.4 38.4 28" stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none" /></svg>`

// rc11.7 / #86 — "checked, no credentials found". Neutral grey camera
// silhouette with a red circle-with-slash overlay in the lower-right so
// users can tell "we verified and this image carries no cryptographic
// provenance" apart from "we haven't verified yet" (the transient img
// state during scan) and from "has credentials, trust unknown" (warning).
const SVG_CR_NO_CREDENTIALS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><path fill="#888888" stroke="#555555" stroke-width="2" d="M1.56 18c0-9.08 7.361-16.44 16.441-16.44s16.443 7.362 16.443 16.442V34.44H18C8.92 34.44 1.56 27.08 1.56 18Z" /><path fill="#ffffff" d="M9 13h5l1.5-2h6l1.5 2h4v10h-18v-10z" /><circle fill="#ffffff" cx="18" cy="18" r="3.5" /><circle fill="none" stroke="#c83232" stroke-width="3" cx="31" cy="30" r="7" /><line stroke="#c83232" stroke-width="3" stroke-linecap="round" x1="26" y1="25" x2="36" y2="35" /></svg>`

const imageSources: { [key in VALIDATION_STATUS]: string } = {
  success: SVG_CR_SUCCESS,
  warning: SVG_CR_WARNING,
  error: SVG_CR_ERROR,
  img: chrome.runtime.getURL('icons/camera.svg'),
  video: chrome.runtime.getURL('icons/video.svg'),
  audio: chrome.runtime.getURL('icons/audio.svg'),
  none: '',
  'ai-success': SVG_CR_AI_SUCCESS,
  'ai-error': SVG_CR_AI_ERROR,
  'no-credentials': SVG_CR_NO_CREDENTIALS
}

// The "no credentials" verdict is a real finding, but a weaker one than any
// verdict about a signature: nothing was cryptographically checked because
// there was nothing to check. Rendering it at full strength gives it the same
// visual weight as a trusted or invalid badge. Held at partial opacity in both
// the in-page overlay and the popup so the eye reads it as "we looked, there is
// nothing here" rather than as a judgement on the file's authenticity.
export const CR_ICON_NO_CREDENTIALS_OPACITY = '0.55'

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
    this._crDiv.title = `Click to view C2PA metadata: ${url}`
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
    return ['success', 'warning', 'error', 'img', 'video', 'audio', 'none', 'ai-success', 'ai-error', 'no-credentials'].includes(status as string)
  }
}
