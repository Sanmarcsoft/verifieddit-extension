/*
 * Standalone options page.
 *
 * Firefox declares this as `options_ui`, so it is reachable from
 * about:addons -> Verifieddit -> Preferences. Chrome does not declare it: on
 * Chrome the same two controls live in the popup's Options tab, which is where
 * Chrome users look. See #170 for why the page previously shipped blank.
 *
 * The two settings here are deliberately the only two that change what the
 * extension *does* rather than what it shows. Trust-list import stays in the
 * popup, because it needs the trust-list listing next to it to make sense.
 *
 * Both controls write the same storage keys the popup writes, so the two
 * surfaces cannot drift: whichever you change last wins, and reopening either
 * one reads the stored value back.
 */
import { AUTO_SCAN_DEFAULT, MSG_AUTO_SCAN_UPDATED, MANIFEST_STORE_PROBE_DEFAULT, MANIFEST_STORE_PROBE_KEY, VIDEO_UPLOAD_RECOVERY_DEFAULT, VIDEO_UPLOAD_RECOVERY_KEY, ICON_ONLY_DEFAULT, ICON_ONLY_KEY } from './constants.js'
import { type ToggleSwitch } from './components/toggle.js'
import { getAnalyticsConsent, setAnalyticsConsent, options_opened } from './analytics.js'

function wireAutoScan (): void {
  const toggle = document.getElementById('toggleAutoScan') as ToggleSwitch | null
  if (toggle == null) return

  chrome.storage.local.get('autoScan', (result) => {
    toggle.checked = result.autoScan ?? AUTO_SCAN_DEFAULT
  })

  toggle.addEventListener('change', (event) => {
    const checked = (event as CustomEvent).detail.checked
    void chrome.storage.local.set({ autoScan: checked })
    // Content scripts are already running in open tabs; they need telling.
    void chrome.runtime.sendMessage({ action: MSG_AUTO_SCAN_UPDATED, data: checked })
  })
}

function wireManifestStoreProbe (): void {
  const toggle = document.getElementById('toggleManifestStoreProbe') as ToggleSwitch | null
  if (toggle == null) return

  chrome.storage.local.get(MANIFEST_STORE_PROBE_KEY, (result) => {
    toggle.checked = result[MANIFEST_STORE_PROBE_KEY] ?? MANIFEST_STORE_PROBE_DEFAULT
  })

  // The extension's only automatic outbound request, so it is the user's to
  // switch on. No message to the background is needed: manifestStore.ts reads
  // the setting at the moment it would otherwise reach the network.
  toggle.addEventListener('change', (event) => {
    const checked = (event as CustomEvent).detail.checked
    void chrome.storage.local.set({ [MANIFEST_STORE_PROBE_KEY]: checked })
  })
}

// Sending a video to Verifieddit to look for a removed credential (#195). The
// file leaves the browser, so it is its own switch and stays off until asked for.
function wireVideoUploadRecovery (): void {
  const toggle = document.getElementById('toggleVideoUploadRecovery') as ToggleSwitch | null
  if (toggle == null) return

  chrome.storage.local.get(VIDEO_UPLOAD_RECOVERY_KEY, (result) => {
    toggle.checked = result[VIDEO_UPLOAD_RECOVERY_KEY] ?? VIDEO_UPLOAD_RECOVERY_DEFAULT
  })

  toggle.addEventListener('change', (event) => {
    const checked = (event as CustomEvent).detail.checked
    void chrome.storage.local.set({ [VIDEO_UPLOAD_RECOVERY_KEY]: checked })
  })
}

function wireIconOnly (): void {
  const toggle = document.getElementById('toggleIconOnly') as ToggleSwitch | null
  if (toggle == null) return

  chrome.storage.local.get(ICON_ONLY_KEY, (result) => {
    toggle.checked = result[ICON_ONLY_KEY] ?? ICON_ONLY_DEFAULT
  })

  // A display preference. Open tabs follow it through chrome.storage.onChanged.
  toggle.addEventListener('change', (event) => {
    const checked = (event as CustomEvent).detail.checked
    void chrome.storage.local.set({ [ICON_ONLY_KEY]: checked })
  })
}

function wireAnalyticsConsent (): void {
  const toggle = document.getElementById('toggleAnalyticsConsent') as ToggleSwitch | null
  if (toggle == null) return

  void getAnalyticsConsent().then((consent) => {
    toggle.checked = consent === 'granted'
  })

  toggle.addEventListener('change', (event) => {
    const checked = (event as CustomEvent).detail.checked
    void setAnalyticsConsent(checked ? 'granted' : 'denied')
  })
}

// Keep the page honest if the setting is changed from the popup while this
// page is open, rather than showing a stale switch position.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if ('autoScan' in changes) {
    const toggle = document.getElementById('toggleAutoScan') as ToggleSwitch | null
    if (toggle != null) toggle.checked = changes.autoScan.newValue ?? AUTO_SCAN_DEFAULT
  }
  if (MANIFEST_STORE_PROBE_KEY in changes) {
    const toggle = document.getElementById('toggleManifestStoreProbe') as ToggleSwitch | null
    if (toggle != null) toggle.checked = changes[MANIFEST_STORE_PROBE_KEY].newValue ?? MANIFEST_STORE_PROBE_DEFAULT
  }
  if (VIDEO_UPLOAD_RECOVERY_KEY in changes) {
    const toggle = document.getElementById('toggleVideoUploadRecovery') as ToggleSwitch | null
    if (toggle != null) toggle.checked = changes[VIDEO_UPLOAD_RECOVERY_KEY].newValue ?? VIDEO_UPLOAD_RECOVERY_DEFAULT
  }
  if (ICON_ONLY_KEY in changes) {
    const toggle = document.getElementById('toggleIconOnly') as ToggleSwitch | null
    if (toggle != null) toggle.checked = changes[ICON_ONLY_KEY].newValue ?? ICON_ONLY_DEFAULT
  }
  if ('analyticsConsent' in changes) {
    const toggle = document.getElementById('toggleAnalyticsConsent') as ToggleSwitch | null
    if (toggle != null) toggle.checked = changes.analyticsConsent.newValue === 'granted'
  }
})

void options_opened()
wireAutoScan()
wireManifestStoreProbe()
wireVideoUploadRecovery()
wireIconOnly()
wireAnalyticsConsent()
