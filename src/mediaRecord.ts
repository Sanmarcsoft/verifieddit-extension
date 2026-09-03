/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { type C2paResult } from './c2pa'
import { IS_DEBUG } from './constants'
import { type CrIcon } from './icon'

export type MediaElement = (HTMLImageElement | HTMLVideoElement | HTMLAudioElement)

const SOURCES_TO_IGNORE = ['chrome-extension:', 'moz-extension:', 'blob:', 'data:']

type MediaStateTypes = 'image' | 'video' | 'audio' | 'none'

export type MediaVerdictKind = 'no-credentials' | 'unavailable'

/**
 * Outcome of a validation that finished without producing a manifest.
 *
 * Previously only a successful validation left a trace on the record (`c2pa`),
 * so "we checked this image and it carries no credentials" was indistinguishable
 * from "we never looked at it" — both were `c2pa: null`. That is why the popup
 * could only ever list signed media and why an unsigned image kept its neutral
 * scan-in-progress camera badge forever.
 *
 * `no-credentials` is a statement about the file: it has no C2PA manifest.
 * `unavailable` is a statement about the check: it could not be completed, so
 * the file's credentials are unknown. Collapsing the two would tell the user a
 * signed asset is unsigned, which is the worst verdict a verifier can get wrong.
 */
export interface MediaVerdict {
  kind: MediaVerdictKind
  url: string
  detail: string | null
}

export interface MediaRecordState {
  type: MediaStateTypes
  viewport: boolean
  visible: boolean
  evaluated: boolean
  c2pa: C2paResult | null
  verdict: MediaVerdict | null
}

export class MediaRecord {
  private readonly _state: MediaRecordState = { type: 'none', visible: false, evaluated: false, viewport: false, c2pa: null, verdict: null }
  private readonly _element: MediaElement
  private _icon: CrIcon | null = null

  private static _i = 0

  public static MEDIA_ELEMENT_NODE_TYPES = ['IMG', 'VIDEO', 'AUDIO']

  constructor (mediaElement: MediaElement) {

    if (IS_DEBUG) {
      if (mediaElement.getAttribute('c2pa:id') != null) {
      } else {
        mediaElement.setAttribute('c2pa:id', String(MediaRecord._i++))
      }
    }
    this._element = mediaElement
    this.state.type = mediaElement.nodeName.toLowerCase() as MediaStateTypes
  }

  public get icon (): CrIcon | null {
    return this._icon
  }

  public set icon (icon: CrIcon | null) {
    if (this._icon != null) {
      this._icon.remove()
    }
    this._icon = icon
  }

  public get src (): string {
    if (IS_DEBUG) {
      if (this._element.currentSrc == null) {
      }
    }
    return this._element.currentSrc
  }

  public get element (): MediaElement {
    return this._element
  }

  public get state (): MediaRecordState {
    return this._state
  }

  // eslint-disable-next-line accessor-pairs
  public set onReady (callback: (media: MediaRecord) => void) {
    const imgElement = this._element as HTMLImageElement
    const avElement = this._element as HTMLVideoElement | HTMLAudioElement
    let loaded = (imgElement.complete || avElement.readyState >= 2) && imgElement.naturalWidth !== 0
    if (loaded) {
      callback(this)
      return
    }
    const listener = (): void => {
      loaded = true
      callback(this)
      imgElement.removeEventListener('load', listener)
      imgElement.removeEventListener('loadeddata', listener)
    }
    imgElement.addEventListener('load', listener)
    imgElement.addEventListener('loadeddata', listener)
    if (!IS_DEBUG) return
    // If, for some reason, the load event is not fired, we will log an error after 2 seconds
    // We expect the load event to be always be fired
    setTimeout(() => {
      if (!loaded) {
      }
    }, 2000)
  }

  public static getSrc (element: MediaElement): string | null {
    // return the source of the media element, null for undefined/null/empty-string
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing
    return element.src || element.currentSrc || null
  }

  public static isMediaElement (element: Node): element is MediaElement {
    if (!(element instanceof HTMLElement)) return false
    // We ignore media elements from this extension
    if (SOURCES_TO_IGNORE.some(source => (MediaRecord.getSrc(element as MediaElement) ?? '').startsWith(source))) {
      return false
    }
    return MediaRecord.MEDIA_ELEMENT_NODE_TYPES.includes(element.nodeName)
  }
}
