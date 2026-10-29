/*
 * What a c2pa.hash.data exclusion is allowed to cover.
 *
 * The contents hash of a JPEG or PNG skips the byte ranges its credential
 * lists as exclusions, so the credential does not have to hash itself. The
 * standard does not stop a signer from excluding more. David Buchanan
 * (2026-10-02) published a JPEG whose one exclusion is the whole file: the
 * hash is the hash of nothing, the signature and timestamp stay valid, and the
 * pixels can be anything. The engine reports such a file as valid.
 *
 * The rule here: an exclusion may cover the credential's own storage (the
 * APP11 segments of a JPEG, the caBX chunk of a PNG) and nothing else, and the
 * hash must still cover something. Every genuine signed file in the test
 * corpus (Adobe, Nikon, Truepic, OpenAI, the Trusteddit signer) obeys it.
 *
 * A failure becomes a synthetic validation code. Codes are how every verdict
 * function decides, so these turn a file red on every surface without a new
 * branch anywhere. Anything this module cannot read is "not judged", never red.
 */

import { decode as decodeJumbf, isContentBox, type JumbfBox, type ContentBox } from './certs/jumbf.js'
import { decode as decodeCbor } from './certs/cbor.js'
import { getManifestFromMetadata } from './certs/metadata.js'

export interface ByteRange { start: number, length: number }

export type ExclusionVerdict =
  | { kind: 'ok' }
  | { kind: 'zero-coverage' }
  | { kind: 'out-of-policy', stray: ByteRange[] }
  | { kind: 'metadata', stray: ByteRange[] }
  | { kind: 'not-judged', why: string }

/** The exclusions leave no byte of the file hashed. */
export const ZERO_COVERAGE_CODE = 'verifieddit.dataHash.zeroCoverage'
/** An exclusion reaches the image's data or structure, outside the credential. */
export const OUT_OF_POLICY_CODE = 'verifieddit.dataHash.exclusionOutOfPolicy'
/** An exclusion leaves out header metadata (EXIF and the like), never the image. A note, not a failure. */
export const METADATA_CODE = 'verifieddit.dataHash.exclusionCoversMetadata'

type Span = [number, number]

function merge (spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last != null && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

function wellFormed (r: ByteRange, fileSize: number): boolean {
  return Number.isSafeInteger(r.start) && Number.isSafeInteger(r.length) &&
    r.start >= 0 && r.length >= 0 && r.start + r.length <= fileSize
}

/** The parts of each range that fall outside `allowed`. */
function outside (ranges: ByteRange[], allowedRanges: ByteRange[]): ByteRange[] {
  const allowed = merge(allowedRanges.map((r): Span => [r.start, r.start + r.length]))
  const stray: ByteRange[] = []
  for (const r of ranges) {
    let cursor = r.start
    const end = r.start + r.length
    for (const [a, b] of allowed) {
      if (b <= cursor) continue
      if (a >= end) break
      if (a > cursor) stray.push({ start: cursor, length: a - cursor })
      cursor = Math.max(cursor, b)
      if (cursor >= end) break
    }
    if (cursor < end) stray.push({ start: cursor, length: end - cursor })
  }
  return stray
}

/**
 * Judge a list of exclusions against the file size, the credential's storage
 * and, optionally, the file's header metadata. `regions` is null when the
 * storage could not be located: then only the whole-file case is still
 * decided, because it needs no regions.
 *
 * Bytes left out beyond the credential are "metadata" when every one of them
 * is header metadata (the JPEG start marker, APPn and COM segments; the PNG
 * signature and ancillary chunks), and "out-of-policy" when any reaches the
 * image's data or structure. Truepic's 2023 signer excluded its EXIF block
 * this way; its pixels stay protected, so that is a note, not a failure.
 */
export function judgeExclusions ({ exclusions, fileSize, regions, metadata }: {
  exclusions: ByteRange[]
  fileSize: number
  regions: ByteRange[] | null
  metadata?: ByteRange[] | null
}): ExclusionVerdict {
  // Clamped to the file, so ranges cut up however still add up.
  const covered = merge(exclusions.map((r): Span => [
    Math.max(0, r.start), Math.min(fileSize, r.start + r.length)
  ]))
  if (exclusions.length > 0 && covered.length === 1 && covered[0][0] === 0 && covered[0][1] >= fileSize) {
    return { kind: 'zero-coverage' }
  }

  const malformed = exclusions.filter((r) => !wellFormed(r, fileSize))
  if (malformed.length > 0) return { kind: 'out-of-policy', stray: malformed }
  if (regions == null) return { kind: 'not-judged', why: 'the credential storage could not be located' }

  const stray = outside(exclusions, regions)
  if (stray.length === 0) return { kind: 'ok' }
  const content = outside(stray, metadata ?? [])
  return content.length > 0 ? { kind: 'out-of-policy', stray: content } : { kind: 'metadata', stray }
}

export function exclusionCodes (v: ExclusionVerdict): string[] {
  if (v.kind === 'zero-coverage') return [ZERO_COVERAGE_CODE]
  if (v.kind === 'out-of-policy') return [OUT_OF_POLICY_CODE]
  if (v.kind === 'metadata') return [METADATA_CODE]
  return []
}

interface Piece { tag: string, start: number, length: number }

/** JPEG header segments up to the image data, from each 0xFF marker through the segment's end. */
function jpegSegments (b: Uint8Array): Piece[] | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  const out: Piece[] = [{ tag: 'SOI', start: 0, length: 2 }]
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue } // fill byte
    if (marker === 0xda || marker === 0xd9) break // image data starts: no more headers
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    const length = (b[i + 2] << 8) | b[i + 3]
    if (length < 2 || i + 2 + length > b.length) return null
    out.push({ tag: marker.toString(16), start: i, length: 2 + length })
    i += 2 + length
  }
  return out
}

/** PNG chunks, each from its length field through its CRC, after the 8-byte signature. */
function pngChunks (b: Uint8Array): Piece[] | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 8 || signature.some((x, i) => b[i] !== x)) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Piece[] = [{ tag: 'signature', start: 0, length: 8 }]
  let i = 8
  while (i + 12 <= b.length) {
    const length = view.getUint32(i)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    if (i + 12 + length > b.length) return null
    out.push({ tag: type, start: i, length: 12 + length })
    i += 12 + length
    if (type === 'IEND') break
  }
  return out
}

const isApp11 = (p: Piece): boolean => p.tag === 'eb'
/** SOI, APP0..APP15 except the credential's APP11, and COM. */
const isJpegMetadata = (p: Piece): boolean => p.tag === 'SOI' || p.tag === 'fe' || (/^e[0-9a-f]$/.test(p.tag) && !isApp11(p))
/** The signature and ancillary chunks (lower-case first letter) except caBX. */
const isPngMetadata = (p: Piece): boolean => p.tag === 'signature' || (/^[a-z]/.test(p.tag) && p.tag !== 'caBX')

function spans (pieces: Piece[]): ByteRange[] {
  return merge(pieces.map((p): Span => [p.start, p.start + p.length])).map(([a, b]) => ({ start: a, length: b - a }))
}

/**
 * Where the credential is stored, or null for a format this module does not
 * know or a file it cannot walk. Never an empty list for an unknown format:
 * that would make every exclusion stray.
 */
export function credentialRegions (mime: string, bytes: Uint8Array): ByteRange[] | null {
  if (mime === 'image/jpeg') return jpegSegments(bytes)?.filter(isApp11).map(({ start, length }) => ({ start, length })) ?? null
  if (mime === 'image/png') return pngChunks(bytes)?.filter((p) => p.tag === 'caBX').map(({ start, length }) => ({ start, length })) ?? null
  return null
}

/** The file's header metadata outside the credential, adjacent pieces merged; null for a format not handled. */
export function metadataRegions (mime: string, bytes: Uint8Array): ByteRange[] | null {
  if (mime === 'image/jpeg') { const p = jpegSegments(bytes); return p == null ? null : spans(p.filter(isJpegMetadata)) }
  if (mime === 'image/png') { const p = pngChunks(bytes); return p == null ? null : spans(p.filter(isPngMetadata)) }
  return null
}

const DATA_HASH_LABEL = /^c2pa\.hash\.data(\.v\d+)?(__\d+)?$/

function dataHashAssertions (box: JumbfBox, out: ContentBox[] = []): ContentBox[] {
  for (const child of box.boxes) {
    if (isContentBox(child)) continue
    if (child.label != null && DATA_HASH_LABEL.test(child.label)) {
      // By type: a salted assertion carries a c2sh box ahead of its cbor.
      const content = child.boxes.find((b): b is ContentBox => isContentBox(b) && b.type === 'cbor')
      if (content != null) out.push(content)
    } else {
      dataHashAssertions(child, out)
    }
  }
  return out
}

const RANK: Record<ExclusionVerdict['kind'], number> = { ok: 0, 'not-judged': 1, metadata: 2, 'out-of-policy': 3, 'zero-coverage': 4 }
const rank = (v: ExclusionVerdict): number => RANK[v.kind]

/** Read the active manifest's data-hash exclusions from a file and judge them. */
export function judgeFile (mime: string, bytes: Uint8Array, activeLabel?: string): ExclusionVerdict {
  try {
    const jumbf = getManifestFromMetadata(mime, bytes)
    if (jumbf == null) return { kind: 'not-judged', why: 'no credential found' }
    const store = decodeJumbf(jumbf)
    const manifests = store.boxes.filter((b): b is JumbfBox => !isContentBox(b))
    const active = activeLabel != null ? manifests.find((m) => m.label === activeLabel) : manifests[manifests.length - 1]
    if (active == null) return { kind: 'not-judged', why: 'no manifest in the credential' }
    const assertions = dataHashAssertions(active)
    if (assertions.length === 0) return { kind: 'not-judged', why: 'no data hash in the active manifest' }

    const regions = credentialRegions(mime, bytes)
    const metadata = metadataRegions(mime, bytes)
    let worst: ExclusionVerdict = { kind: 'ok' }
    for (const a of assertions) {
      const raw = decodeCbor(a.data) as Record<string, unknown> | null
      if (raw == null || typeof raw !== 'object') return { kind: 'not-judged', why: 'unreadable data hash' }
      const list = Array.isArray(raw.exclusions) ? raw.exclusions : []
      const exclusions = list.map((e) => {
        const x = e as Record<string, unknown>
        return { start: Number(x.start), length: Number(x.length) }
      })
      const v = judgeExclusions({ exclusions, fileSize: bytes.length, regions, metadata })
      if (v.kind === 'zero-coverage') return v
      if (rank(v) > rank(worst)) worst = v
    }
    return worst
  } catch (e) {
    return { kind: 'not-judged', why: `the credential could not be read: ${String(e)}` }
  }
}

/**
 * The verification pipeline's hook: judge a JPEG or PNG's exclusions and
 * append the code a failure calls for. Anything else passes through untouched.
 * `judge` is injectable for tests; production uses judgeFile.
 */
export function applyExclusionPolicy (
  codes: string[], mime: string, bytes: Uint8Array,
  judge: (mime: string, bytes: Uint8Array) => ExclusionVerdict = judgeFile
): string[] {
  if (mime !== 'image/jpeg' && mime !== 'image/png') return codes
  const added = exclusionCodes(judge(mime, bytes)).filter((c) => !codes.includes(c))
  return added.length > 0 ? [...codes, ...added] : codes
}
