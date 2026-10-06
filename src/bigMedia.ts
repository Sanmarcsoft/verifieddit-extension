/*
 * A large video read over the network in pieces (#197).
 *
 * The engine needs a whole file in memory and stops reading credentials at
 * about 1 GB. bmffVerify.ts needs only a way to read bytes by position. This
 * module supplies that over HTTP range requests, so a large MP4 is verified
 * without being downloaded into memory:
 *
 *   - the credential box is fetched on its own (a few small requests);
 *   - the engine is handed a tiny MP4 that carries just that box, and reads
 *     signer, date, claims and trust from it as usual;
 *   - the contents check is then done here, streaming the file in chunks.
 *
 * Every request goes through the same guard as any other media fetch: no
 * cookies, the redirect rule, the private-address check on where it landed,
 * and a time limit.
 */

import { mediaFetchAllowed, readCapped, redirectPolicy, MEDIA_IDLE_MS } from './fetchGuard'
import { readCredentialBox, type Box, type ByteSource } from './bmffVerify'

export interface RemoteOptions {
  pageUrl: string | undefined
  userAsked: boolean
  fetchImpl?: typeof fetch
  /** Requests allowed before giving up. A normal file needs a few dozen for its headers. */
  maxRequests?: number
}

const ASSET_BINDING_CODE = /(dataHash|bmffHash|boxesHash|collectionHash|hardBindings|assertion\.hashedURI)/i

async function ranged (url: string, start: number, endInclusive: number, opts: RemoteOptions): Promise<{ bytes: Uint8Array, total: number } | { refused: string }> {
  const allowed = mediaFetchAllowed(url, opts.pageUrl)
  if (!allowed.ok) return { refused: allowed.reason }
  const doFetch = opts.fetchImpl ?? fetch
  const response = await doFetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
    credentials: 'omit',
    redirect: redirectPolicy(opts.userAsked),
    signal: AbortSignal.timeout(MEDIA_IDLE_MS)
  })
  if (response.redirected) {
    const landed = mediaFetchAllowed(response.url, opts.pageUrl)
    if (!landed.ok) {
      void response.body?.cancel().catch(() => {})
      return { refused: `the address redirected, and ${landed.reason}` }
    }
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
  if (response.status !== 206 || range == null || Number(range[1]) !== start) {
    // A server that ignores Range answers with the whole file. That body is not read.
    void response.body?.cancel().catch(() => {})
    return { refused: 'the server did not answer with the range asked for' }
  }
  // The header must promise no more than was asked for, and the body is then
  // read through a cap of exactly that much: a server cannot answer a 16-byte
  // request with gigabytes and have them buffered.
  const promised = Number(range[2]) - start + 1
  if (promised < 1 || promised > endInclusive - start + 1) {
    void response.body?.cancel().catch(() => {})
    return { refused: 'the server sent a different range than asked for' }
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await (await readCapped(response, promised)).arrayBuffer())
  } catch {
    return { refused: 'the server sent a larger range than it said it would' }
  }
  if (bytes.length !== promised) return { refused: 'the server sent a different range than asked for' }
  return { bytes, total: Number(range[3]) }
}

/**
 * Is this address an MP4-family file on a server that allows range requests?
 * Costs one 16-byte request. Null means "not this path": the caller carries on
 * as it did before.
 */
export async function probeLarge (url: string, opts: RemoteOptions): Promise<{ size: number } | null> {
  try {
    if (!/^https?:/i.test(url)) return null
    const first = await ranged(url, 0, 15, opts)
    if ('refused' in first) return null
    const type = String.fromCharCode(first.bytes[4], first.bytes[5], first.bytes[6], first.bytes[7])
    if (first.bytes.length < 16 || type !== 'ftyp') return null
    return { size: first.total }
  } catch {
    return null
  }
}

/** A file on a server, readable by position. Throws when the server stops honouring ranges or a request is refused. */
export function rangeSource (url: string, size: number, opts: RemoteOptions): ByteSource {
  let requests = 0
  const max = opts.maxRequests ?? 4096
  return {
    size,
    read: async (start, end) => {
      if (end <= start) return new Uint8Array()
      if (++requests > max) throw new Error('too many requests for one file')
      const got = await ranged(url, start, end - 1, opts)
      if ('refused' in got) throw new Error(`range request refused: ${got.refused}`)
      if (got.total !== size) throw new Error('range request refused: the file changed size while it was being read')
      if (got.bytes.length !== end - start) throw new Error('range request refused: short read')
      return got.bytes
    }
  }
}

/**
 * A tiny MP4 holding the file's first box and its credential box, and nothing
 * else. The engine reads a credential only from inside a file; this gives it
 * one of a few kilobytes. Its own contents verdict on the stub is meaningless
 * and is replaced by ours (applyContentsCheck). Null when there is no credential.
 */
export async function credentialStub (source: ByteSource, boxes: Box[]): Promise<Blob | null> {
  const credential = await readCredentialBox(source, boxes)
  if (credential == null) return null
  const ftyp = boxes[0]?.type === 'ftyp' && boxes[0].size <= 4096 ? await source.read(boxes[0].offset, boxes[0].offset + boxes[0].size) : null
  if (ftyp == null) return null
  const box = await source.read(credential.box.offset, credential.box.offset + credential.box.size)
  return new Blob([ftyp, box], { type: 'video/mp4' })
}

export type ContentsCheck = 'verified' | 'changed' | 'not-checked'

/**
 * The validation codes to show, given OUR contents verdict. Whatever the
 * engine said about contents is dropped, because it only saw the stub; a
 * mismatch is reported only when our own check found one.
 */
export function applyContentsCheck (codes: string[], check: ContentsCheck): string[] {
  const rest = codes.filter((code) => !ASSET_BINDING_CODE.test(code))
  return check === 'changed' ? [...rest, 'assertion.bmffHash.mismatch'] : rest
}

/** The one sentence shown, and read aloud, about what was done with the file's contents. */
export function contentsNote (check: { state: ContentsCheck, bytes: number, note?: string }): string {
  const size = check.bytes >= 1024 * 1024 * 1024 ? `${(check.bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${Math.round(check.bytes / (1024 * 1024))} MB`
  const limits = 'Who signed it and when are verified, but not that this copy is unchanged.'
  if (check.state === 'verified') return `Contents checked: all ${size} of this file match its credential.`
  if (check.state === 'changed') return 'This file does not match its credential: it was changed after it was signed.'
  if (check.note != null && check.note !== '') return `Contents not checked: ${check.note}. ${limits}`
  return `Contents not checked. This file is ${size}, so only its credential was read. ${limits} Right-click it and choose Verify to check the contents.`
}
