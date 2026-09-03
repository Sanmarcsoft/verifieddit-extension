/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import { MSG_DISPLAY_C2PA_OVERLAY, MSG_FRAME_CLICK } from './constants'
import { C2paOverlay } from './overlay'
// NOTE (#57): do not import c2pa here. c2pa spawns a Worker from
// chrome-extension://.../c2pa.worker.js which is blocked when the content
// script runs on a web origin. The real validation path goes through
// inject.ts -> MSG_VALIDATE_URL -> background service worker, where the
// Worker is allowed.

export type MediaElement = (HTMLImageElement | HTMLVideoElement | HTMLAudioElement)

/*
  This is the overlay that will be displayed when a media element is validated.
*/
const overlay = C2paOverlay.overlay

// #74: the upstream "paste the URL into Microsoft Content Integrity's
// search box via MutationObserver" plumbing (MSG_REMOTE_INSPECT_URL +
// pasteUrlIntoInput) is gone. The extension now opens verifieddit.com
// with `?url=<encoded>` in background.ts and lets the receiving page
// auto-fill from the query param. Nothing to do in the content script.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /*
    Populate the IFrame with C2PA validation results for a media element.
  */
  if (message.action === MSG_DISPLAY_C2PA_OVERLAY) {
    overlay.show(message.data.position.x as number, message.data.position.y as number)
  }

  if (message.action === MSG_FRAME_CLICK) {
    overlay.hide()
  }
})

// Duplicate image-processing observer removed (#57). inject.ts is the single
// source of truth for image discovery + validation. This script only bridges
// overlay messages between the background worker and the page.
