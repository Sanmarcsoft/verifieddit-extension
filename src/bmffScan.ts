/*
 * Does an MP4-family file carry a C2PA credential? Read from the box headers
 * alone, so it costs a few small reads at any file size.
 *
 * Measured 2026-10-06 with this extension's engine in Chrome: a signed video is
 * read correctly up to about 950 MB; from roughly 1 GB the engine returns
 * nothing and the file would be reported as having no credentials. This scan
 * is how the extension tells "no credentials" from "credentials it cannot
 * verify at this size", without depending on where that limit falls on a given
 * device.
 *
 * The credential lives in a top-level `uuid` box whose 16-byte type is the
 * C2PA identifier. Nothing here interprets the credential; that is the
 * engine's job.
 */

const C2PA_UUID = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]
/** Top-level boxes examined before giving up. A real file has a handful, a fragmented one a few thousand. */
const BOX_BUDGET = 4096
/** Header bytes read per box: size, type, 64-bit size, and the uuid's 16-byte type. */
const HEADER_BYTES = 32

export async function bmffHasC2pa (blob: Blob): Promise<boolean> {
  try {
    let offset = 0
    for (let seen = 0; seen < BOX_BUDGET && offset + 8 <= blob.size; seen++) {
      const header = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + HEADER_BYTES)).arrayBuffer())
      if (header.length < 8) return false
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const type = String.fromCharCode(header[4], header[5], header[6], header[7])
      let size = view.getUint32(0)
      let headerSize = 8
      if (size === 1) {
        if (header.length < 16) return false
        const large = view.getBigUint64(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false
        size = Number(large)
        headerSize = 16
      } else if (size === 0) {
        size = blob.size - offset // runs to the end of the file
      }
      if (size < headerSize) return false
      if (type === 'uuid' && header.length >= headerSize + 16 && C2PA_UUID.every((byte, i) => header[headerSize + i] === byte)) return true
      offset += size
    }
    return false
  } catch {
    return false
  }
}

/**
 * Below this size the engine reads credentials reliably (measured up to about
 * 950 MB), so a file that small with nothing read simply has none we can use.
 * Set well under the measured failure point, because devices differ.
 */
export const ENGINE_DOUBT_BYTES = 512 * 1024 * 1024

/**
 * True when a file the engine read nothing from is large enough that size may
 * be the reason AND it does carry a credential box. Only then may the reader
 * be told "has credentials, too large to verify here". A small file with a
 * forged box gets no such statement: for it, nothing read means nothing there.
 */
export async function credentialsUnreadAtThisSize (blob: Blob, minBytes: number = ENGINE_DOUBT_BYTES): Promise<boolean> {
  if (blob.size < minBytes) return false
  return await bmffHasC2pa(blob)
}
