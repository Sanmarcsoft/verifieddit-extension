/*
 * Checking an MP4-family file against its Content Credentials without holding
 * the file (#197).
 *
 * The engine wants the whole file in memory, and above roughly 1 GB it reads
 * nothing. But the two things verification needs do not need that:
 *
 *   A. The credential is one small top-level box. Its position comes from the
 *      box headers, so it is read with a handful of small reads, from a Blob or
 *      over HTTP range requests.
 *   B. "Was the file changed since signing" is a hash of the file computed the
 *      way the C2PA standard says: skip the boxes the credential excludes, and
 *      mix in the position of every other top-level box. That can be done as
 *      the bytes go past, a few megabytes at a time.
 *
 * The hashing rule follows the reference implementation (c2pa-rs,
 * bmff_to_jumbf_exclusions and hash_stream_by_alg). The tests check it against
 * a video signed by the Trusteddit signer: our hash must equal the one in its
 * credential. What this module does not implement (Merkle-tree hashes of
 * fragmented video, exclusions by box version or flags, algorithms other than
 * SHA-256) it reports as "unsupported", never as a match or a mismatch.
 */

import { decode as decodeJumbf, isContentBox, type JumbfBox, type ContentBox } from './certs/jumbf.js'
import { decode as decodeCbor } from './certs/cbor.js'

/** Anything bytes can be read from by position: a Blob, or a file on a server that allows range requests. */
export interface ByteSource {
  size: number
  /** Bytes from `start` up to but not including `end`. */
  read: (start: number, end: number) => Promise<Uint8Array>
}

export function blobSource (blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer())
  }
}

export interface Box { type: string, offset: number, size: number, headerSize: number }

const C2PA_UUID = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]
/** Top-level boxes examined before giving up. A fragmented file has a few thousand. */
const BOX_BUDGET = 100_000
/** A credential larger than this is not read (the largest seen are a few megabytes, with thumbnails). */
const CREDENTIAL_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024

/** The file's top-level boxes, from their headers alone. Throws on a file that is not well-formed. */
export async function topLevelBoxes (source: ByteSource): Promise<Box[]> {
  const boxes: Box[] = []
  let offset = 0
  while (offset < source.size) {
    if (boxes.length >= BOX_BUDGET) throw new Error('too many boxes')
    if (offset + 8 > source.size) throw new Error('truncated box header')
    const header = await source.read(offset, Math.min(source.size, offset + 16))
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const type = String.fromCharCode(header[4], header[5], header[6], header[7])
    let size = view.getUint32(0)
    let headerSize = 8
    if (size === 1) {
      if (header.length < 16) throw new Error('truncated box header')
      const large = view.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('box too large')
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = source.size - offset
    }
    if (size < headerSize || offset + size > source.size) throw new Error('bad box size')
    boxes.push({ type, offset, size, headerSize })
    offset += size
  }
  return boxes
}

/**
 * The credential (a JUMBF manifest store) carried in the file's C2PA box, or
 * null when there is none. Reads the box headers and then that one box.
 */
export async function readCredentialBox (source: ByteSource, known?: Box[]): Promise<{ jumbf: Uint8Array, box: Box } | null> {
  const boxes = known ?? await topLevelBoxes(source)
  for (const box of boxes) {
    if (box.type !== 'uuid' || box.size < box.headerSize + 16) continue
    const id = await source.read(box.offset + box.headerSize, box.offset + box.headerSize + 16)
    if (!C2PA_UUID.every((byte, i) => id[i] === byte)) continue
    if (box.size > CREDENTIAL_MAX_BYTES) throw new Error('credential too large')
    const body = await source.read(box.offset + box.headerSize + 16, box.offset + box.size)
    // version (1), flags (3), purpose (text, zero-terminated), then for a
    // manifest an 8-byte offset to the first Merkle box, then the credential.
    let at = 4
    let purpose = ''
    while (at < body.length && body[at] !== 0) purpose += String.fromCharCode(body[at++])
    at++
    if (purpose !== 'manifest') continue
    at += 8
    if (at > body.length) return null
    return { jumbf: body.subarray(at), box }
  }
  return null
}

export interface Exclusion {
  xpath: string
  length: number | null
  data: Array<{ offset: number, value: Uint8Array }> | null
  subset: Array<{ offset: number, length: number }> | null
  version: number | null
  flags: Uint8Array | null
}

export interface HashAssertion {
  /** 1 for c2pa.hash.bmff, 2 and 3 for the later forms, which also hash box positions. */
  version: number
  alg: string
  hash: Uint8Array
  exclusions: Exclusion[]
  /** True when the credential uses Merkle-tree hashes (fragmented video). */
  merkle: boolean
}

const HASH_LABEL = /^c2pa\.hash\.bmff(?:\.v(\d+))?$/

function findHashBox (box: JumbfBox | ContentBox): { label: string, data: Uint8Array } | null {
  if (isContentBox(box)) return null
  if (typeof box.label === 'string' && HASH_LABEL.test(box.label)) {
    const content = box.boxes.find(isContentBox)
    return content != null ? { label: box.label, data: content.data } : null
  }
  // The last match wins within a manifest: assertions are listed once, and a
  // later box cannot be an earlier manifest's.
  let found: { label: string, data: Uint8Array } | null = null
  for (const child of box.boxes ?? []) found = findHashBox(child) ?? found
  return found
}

/** The contents-check assertion of the ACTIVE manifest, which is the last one in the store. */
export function hashAssertionOf (jumbf: Uint8Array): HashAssertion | null {
  try {
    const store = decodeJumbf(jumbf)
    const manifests = store.boxes.filter((b): b is JumbfBox => !isContentBox(b))
    const active = manifests[manifests.length - 1]
    if (active == null) return null
    const found = findHashBox(active)
    if (found == null) return null
    const raw = decodeCbor(found.data) as Record<string, unknown> | null
    if (raw == null || typeof raw !== 'object' || !(raw.hash instanceof Uint8Array)) return null
    const bytes = (v: unknown): Uint8Array | null => v instanceof Uint8Array ? v : null
    const number = (v: unknown): number | null => typeof v === 'number' ? v : null
    const exclusions = (Array.isArray(raw.exclusions) ? raw.exclusions : []).map((e) => {
      const x = e as Record<string, unknown>
      return {
        xpath: String(x.xpath ?? ''),
        length: number(x.length),
        data: Array.isArray(x.data) ? x.data.map((d) => ({ offset: Number((d as Record<string, unknown>).offset ?? 0), value: bytes((d as Record<string, unknown>).value) ?? new Uint8Array() })) : null,
        subset: Array.isArray(x.subset) ? x.subset.map((s) => ({ offset: Number((s as Record<string, unknown>).offset ?? 0), length: Number((s as Record<string, unknown>).length ?? 0) })) : null,
        version: number(x.version),
        flags: bytes(x.flags)
      }
    })
    return {
      version: Number(HASH_LABEL.exec(found.label)?.[1] ?? 1),
      alg: String(raw.alg ?? 'sha256').toLowerCase(),
      hash: raw.hash,
      exclusions,
      merkle: Array.isArray(raw.merkle) && raw.merkle.length > 0
    }
  } catch {
    return null
  }
}

export type ContentsResult = { result: 'match' } | { result: 'mismatch' } | { result: 'unsupported', why: string }

/**
 * Which bytes are hashed, and where a box position is mixed in. Mirrors
 * bmff_to_jumbf_exclusions in the reference implementation.
 */
async function hashPlan (source: ByteSource, boxes: Box[], assertion: HashAssertion): Promise<{ excluded: Array<[number, number]>, markers: number[] } | { unsupported: string }> {
  const excluded: Array<[number, number]> = []
  const starts = new Set(boxes.map((b) => b.offset))
  for (const ex of assertion.exclusions) {
    const path = ex.xpath.split('/').filter((p) => p !== '')
    if (path.length !== 1) return { unsupported: `an exclusion inside a box (${ex.xpath})` }
    if (ex.version != null || ex.flags != null) return { unsupported: 'an exclusion by box version or flags' }
    for (const box of boxes) {
      if (box.type !== path[0]) continue
      if (ex.length != null && ex.length !== box.size) continue
      let matches = true
      for (const d of ex.data ?? []) {
        const end = box.offset + d.offset + d.value.length
        if (end > source.size) { matches = false; break }
        const got = await source.read(box.offset + d.offset, end)
        if (!d.value.every((byte, i) => got[i] === byte)) { matches = false; break }
      }
      if (!matches) continue
      if (ex.subset != null) {
        for (const s of ex.subset) {
          if (s.offset > box.size) continue
          const length = s.length === 0 ? box.size - s.offset : Math.min(s.length, box.size - s.offset)
          excluded.push([box.offset + s.offset, box.offset + s.offset + length])
        }
      } else {
        excluded.push([box.offset, box.offset + box.size])
        starts.delete(box.offset) // a box left out whole contributes no position either
      }
    }
  }
  excluded.sort((a, b) => a[0] - b[0])
  return { excluded, markers: assertion.version >= 2 ? [...starts].sort((a, b) => a - b) : [] }
}

/**
 * Does the file match the contents hash in its own credential? Reads the file
 * in chunks, so it works at any size. "unsupported" means this code cannot
 * judge, and says why; it is never a verdict on the file.
 */
export async function checkContents (
  source: ByteSource,
  opts: { chunkBytes?: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, boxes?: Box[], assertion?: HashAssertion } = {}
): Promise<ContentsResult> {
  const stopIfAsked = (): void => { if (opts.signal?.aborted === true) throw new Error('stopped') }
  stopIfAsked()
  let boxes: Box[]
  try {
    boxes = opts.boxes ?? await topLevelBoxes(source)
  } catch (error) {
    return { result: 'unsupported', why: `the file's structure could not be read (${error instanceof Error ? error.message : 'unknown'})` }
  }
  let assertion = opts.assertion
  if (assertion == null) {
    const credential = await readCredentialBox(source, boxes)
    if (credential == null) return { result: 'unsupported', why: 'the file carries no credential' }
    assertion = hashAssertionOf(credential.jumbf) ?? undefined
  }
  if (assertion == null) return { result: 'unsupported', why: 'the credential has no contents hash this code can read' }
  if (assertion.merkle) return { result: 'unsupported', why: 'the credential uses per-fragment hashes' }
  if (assertion.alg !== 'sha256') return { result: 'unsupported', why: `the hash algorithm ${assertion.alg}` }

  const plan = await hashPlan(source, boxes, assertion)
  if ('unsupported' in plan) return { result: 'unsupported', why: plan.unsupported }

  // The included stretches: the whole file with the excluded ranges cut out.
  const included: Array<[number, number]> = []
  let cursor = 0
  for (const [from, to] of plan.excluded) {
    if (from > cursor) included.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < source.size) included.push([cursor, source.size])
  if (included.length === 0) return { result: 'unsupported', why: 'nothing is left to hash' }

  // A box position is mixed in when it falls inside an included stretch, or
  // between the first and last of them (a box whose start was cut out by a
  // partial exclusion), as the reference does.
  const first = included[0][0]
  const last = included[included.length - 1][1] - 1
  const inside = (p: number): boolean => included.some(([a, b]) => p >= a && p < b)
  const markers = plan.markers.filter((p) => inside(p) || (p > first && p < last))

  const total = included.reduce((n, [a, b]) => n + (b - a), 0)
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const hasher = new Sha256()
  const position = new Uint8Array(8)
  const mark = (p: number): void => { new DataView(position.buffer).setBigUint64(0, BigInt(p)); hasher.update(position) }
  let done = 0
  let m = 0
  for (const [from, to] of included) {
    let at = from
    while (at < to) {
      stopIfAsked()
      // positions that fall before this stretch, in a gap, are mixed in as they are passed
      while (m < markers.length && markers[m] < at) mark(markers[m++])
      if (m < markers.length && markers[m] === at) mark(markers[m++])
      const nextMarker = m < markers.length && markers[m] < to ? markers[m] : to
      const end = Math.min(to, nextMarker, at + chunkBytes)
      hasher.update(await source.read(at, end))
      done += end - at
      at = end
      opts.onProgress?.(done, total)
    }
  }
  const digest = hasher.digest()
  const same = digest.length === assertion.hash.length && digest.every((byte, i) => byte === assertion.hash[i])
  return { result: same ? 'match' : 'mismatch' }
}

/** SHA-256 that takes its input in pieces. The browser's own digest wants it all at once. */
export class Sha256 {
  private static readonly K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])

  private readonly state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private readonly block = new Uint8Array(64)
  private readonly w = new Uint32Array(64)
  private filled = 0
  private length = 0

  update (data: Uint8Array): this {
    this.length += data.length
    let at = 0
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length)
      this.block.set(data.subarray(0, take), this.filled)
      this.filled += take
      at = take
      if (this.filled < 64) return this
      this.compress(this.block, 0)
      this.filled = 0
    }
    for (; at + 64 <= data.length; at += 64) this.compress(data, at)
    if (at < data.length) {
      this.block.set(data.subarray(at), 0)
      this.filled = data.length - at
    }
    return this
  }

  digest (): Uint8Array {
    const bits = BigInt(this.length) * 8n
    const pad = new Uint8Array(((this.filled < 56 ? 56 : 120) - this.filled) + 8)
    pad[0] = 0x80
    new DataView(pad.buffer).setBigUint64(pad.length - 8, bits)
    const length = this.length
    this.update(pad)
    this.length = length
    const out = new Uint8Array(32)
    const view = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.state[i])
    return out
  }

  private compress (data: Uint8Array, offset: number): void {
    const w = this.w
    const K = Sha256.K
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]; const b = w[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = this.state
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    const s = this.state
    s[0] = (s[0] + a) >>> 0; s[1] = (s[1] + b) >>> 0; s[2] = (s[2] + c) >>> 0; s[3] = (s[3] + d) >>> 0
    s[4] = (s[4] + e) >>> 0; s[5] = (s[5] + f) >>> 0; s[6] = (s[6] + g) >>> 0; s[7] = (s[7] + h) >>> 0
  }
}
