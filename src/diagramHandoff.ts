/*
 *  Copyright (c) Microsoft Corporation.
 *  Licensed under the MIT license.
 */

import type { ProvenanceGraph } from './provenanceTypes'

/**
 * Passing a provenance graph from the popup to a new tab.
 *
 * It cannot go in the URL: a deep chain with assertion values is far past what
 * a query string should carry, and it would then sit in history. It cannot go
 * by postMessage either, because the popup is usually already closed by the
 * time the tab boots. Storage is the channel that survives that gap.
 *
 * `storage.session` is preferred and `storage.local` is the fallback for
 * engines that lack it. Session is memory-only and cleared when the browser
 * closes, which is the right lifetime for a record of what the user looked at.
 */
function area (): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local
}

export async function writeHandoff (key: string, graph: ProvenanceGraph): Promise<void> {
  await area().set({ [key]: graph })
}

export async function readHandoff (key: string): Promise<ProvenanceGraph | null> {
  const stored = await area().get(key)
  return (stored?.[key] as ProvenanceGraph | undefined) ?? null
}
