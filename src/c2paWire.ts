/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

/**
 * Carrying a validation failure across an extension message boundary.
 *
 * chrome.runtime / chrome.tabs messages are serialised as JSON, not by
 * structured clone, and `JSON.stringify(new Error('boom'))` is `'{}'`: `name`
 * and `message` live on the prototype and custom properties like `.url` are
 * dropped. So every Error the background sent to a content script arrived as an
 * empty object, the receiver's `instanceof Error` was false, and the failure
 * was silently discarded. That is why right-click → Verify appeared to do
 * nothing.
 *
 * This module is deliberately free of imports and side effects. It used to live
 * in c2pa.ts, and importing a runtime value from there pulled the whole WASM
 * engine into the service worker and the content script: the engine's
 * module-level init() then ran in the service worker, where `Worker` does not
 * exist, and wrote a spurious "C2PA engine failed to initialise" banner into
 * the popup while validation was in fact working via the offscreen document.
 */
export interface C2paErrorWire {
  __c2paError: true
  name: string
  message: string
  url: string
}

export function toC2paErrorWire (error: Error | { name?: string, message?: string, url?: string }, url: string): C2paErrorWire {
  const name = error.name ?? ''
  const message = error.message ?? ''
  return {
    __c2paError: true,
    name: name !== '' ? name : 'Error',
    message: message !== '' ? message : 'unknown error',
    url: (error as { url?: string }).url ?? url
  }
}

export function isC2paErrorWire (value: unknown): value is C2paErrorWire {
  return typeof value === 'object' && value !== null && (value as C2paErrorWire).__c2paError === true
}

export function fromC2paErrorWire (wire: C2paErrorWire): Error & { url: string } {
  const error = new Error(wire.message) as Error & { url: string }
  error.name = wire.name
  error.url = wire.url
  return error
}
