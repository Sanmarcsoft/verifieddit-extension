/*
 * Copy-to-clipboard and save-to-file, without asking for a single new
 * permission.
 *
 * Both operations look like they should need one. Neither does:
 *
 *   - `navigator.clipboard.writeText` is allowed from a user gesture in a
 *     secure context with no `clipboardWrite` entry in the manifest. Where it
 *     is unavailable or refuses (older Gecko, a frame without transient
 *     activation) the historical `document.execCommand('copy')` path still
 *     works, so the fallback is not legacy cruft, it is the coverage.
 *   - A Blob object URL plus a synthetic anchor click is an ordinary page
 *     download. The `downloads` permission buys control over the download
 *     *after* it starts, which is not something this needs.
 *
 * `clipboardWrite` and `downloads` were both considered and rejected. Every
 * permission in an extension that exists to establish trust has to be worth
 * defending to a reviewer and to a user; these two would not have been.
 *
 * The dependencies are injected so the decisions above are testable without a
 * DOM, and so a future change that reaches for a permission-requiring API has
 * to walk past a failing test to do it.
 */

export interface CopyDeps {
  /** Usually `navigator.clipboard.writeText`, bound. */
  writeText?: (text: string) => Promise<void>
  /** Usually the `document.execCommand('copy')` dance. Returns success. */
  execCopy?: (text: string) => boolean
}

export interface DownloadDeps {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  createAnchor: () => { href: string, download: string, click: () => void }
}

/** The `execCommand` fallback, in the DOM. Kept here so callers stay short. */
export function execCopyFallback (text: string, doc: Document = document): boolean {
  try {
    const ta = doc.createElement('textarea')
    ta.value = text
    // Off-screen rather than hidden: `display:none` and `visibility:hidden`
    // elements cannot be selected, so the copy silently succeeds with nothing.
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand('copy')
    doc.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Default dependencies, resolved lazily so importing this file is DOM-free. */
export function defaultCopyDeps (): CopyDeps {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  return {
    writeText: clip?.writeText != null ? clip.writeText.bind(clip) : undefined,
    execCopy: (t) => execCopyFallback(t)
  }
}

export function defaultDownloadDeps (): DownloadDeps {
  return {
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => { URL.revokeObjectURL(u) },
    createAnchor: () => document.createElement('a')
  }
}

/**
 * Puts `text` on the clipboard. Returns whether it got there, and never
 * throws: a failed copy is a UI state to report, not an exception to handle at
 * every call site.
 */
export async function copyText (text: string, deps: CopyDeps = defaultCopyDeps()): Promise<boolean> {
  if (deps.writeText != null) {
    try {
      await deps.writeText(text)
      return true
    } catch {
      // Fall through. A rejection here is routine, not exceptional.
    }
  }
  if (deps.execCopy != null) {
    try {
      return deps.execCopy(text)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Offers `text` to the user as a file download. Returns whether the click was
 * dispatched. The object URL is revoked on every path, including failure: a
 * leaked one pins the whole blob in memory for the lifetime of the document.
 */
export function downloadText (
  text: string,
  filename: string,
  mime: string,
  deps: DownloadDeps = defaultDownloadDeps()
): boolean {
  let url: string | null = null
  try {
    url = deps.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
    const a = deps.createAnchor()
    a.href = url
    a.download = filename
    a.click()
    return true
  } catch {
    return false
  } finally {
    if (url != null) deps.revokeObjectURL(url)
  }
}
