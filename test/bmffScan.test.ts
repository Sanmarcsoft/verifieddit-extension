/*
 *  Does a video carry Content Credentials at all? Measured 2026-10-06: above
 *  roughly 1 GB the engine reads nothing and reports a signed video as having
 *  no credentials. That is a wrong answer, not a limit. This scan reads only
 *  the box headers of the file, so it works at any size, and lets the extension
 *  say "has credentials, too large to verify here" instead.
 *  Run with:  bun test test/bmffScan.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { bmffHasC2pa } from '../src/bmffScan'

const C2PA_UUID = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]
const box = (type: string, payload: number[] | Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + payload.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(payload, 8)
  return out
}
const blobOf = (...parts: Uint8Array[]): Blob => new Blob(parts, { type: 'video/mp4' })
const ftyp = box('ftyp', [...'isom0000'].map((c) => c.charCodeAt(0)))
const c2pa = box('uuid', [...C2PA_UUID, 0, 0, 0, 0, 1, 2, 3])

/** A Blob that claims a size and serves zeros, to stand for gigabytes without holding them. */
function sparse (head: Uint8Array, declaredSize: number, tailAt?: { offset: number, bytes: Uint8Array }): Blob {
  let reads = 0
  const fake = {
    size: declaredSize,
    type: 'video/mp4',
    slice (start: number, end: number) {
      reads++
      const out = new Uint8Array(end - start)
      for (let i = 0; i < out.length; i++) {
        const at = start + i
        if (at < head.length) out[i] = head[at]
        else if (tailAt != null && at >= tailAt.offset && at < tailAt.offset + tailAt.bytes.length) out[i] = tailAt.bytes[at - tailAt.offset]
      }
      return new Blob([out])
    },
    get reads () { return reads }
  }
  return fake as unknown as Blob
}

describe('bmffHasC2pa', () => {
  it('finds the credential box among the top-level boxes', async () => {
    expect(await bmffHasC2pa(blobOf(ftyp, c2pa, box('mdat', new Uint8Array(500))))).toBe(true)
    expect(await bmffHasC2pa(blobOf(ftyp, box('mdat', new Uint8Array(500)), c2pa))).toBe(true)
  })

  it('says no for a video without one, and for another kind of uuid box', async () => {
    expect(await bmffHasC2pa(blobOf(ftyp, box('mdat', new Uint8Array(500))))).toBe(false)
    expect(await bmffHasC2pa(blobOf(ftyp, box('uuid', new Array(20).fill(7))))).toBe(false)
  })

  it('reads a credential that sits after a media box of several gigabytes, without reading the media', async () => {
    const big = 5 * 1024 * 1024 * 1024
    const mdatHeader = new Uint8Array(16)
    const view = new DataView(mdatHeader.buffer)
    view.setUint32(0, 1); mdatHeader.set([...'mdat'].map((c) => c.charCodeAt(0)), 4); view.setBigUint64(8, BigInt(big))
    const head = new Uint8Array([...ftyp, ...mdatHeader])
    const file = sparse(head, ftyp.length + big + c2pa.length, { offset: ftyp.length + big, bytes: c2pa })
    expect(await bmffHasC2pa(file)).toBe(true)
    expect((file as unknown as { reads: number }).reads).toBeLessThan(10)
  })

  it('gives up quietly on something that is not a box file, or is cut short', async () => {
    expect(await bmffHasC2pa(new Blob([new Uint8Array([1, 2, 3])]))).toBe(false)
    expect(await bmffHasC2pa(new Blob([new Uint8Array(64)]))).toBe(false) // a zero-size box runs to the end
    expect(await bmffHasC2pa(blobOf(ftyp, new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4])))).toBe(false) // a box smaller than its own header
  })

  it('does not walk forever through a file of tiny boxes', async () => {
    const many = new Array(5000).fill(box('free', []))
    expect(await bmffHasC2pa(blobOf(...many, c2pa))).toBe(false) // beyond the box budget: unknown is reported as no
  })
})

// Forge pass 3, SEC-02: a tiny file with a forged box must not be told it "carries Content Credentials".
describe('credentialsUnreadAtThisSize', () => {
  it('only speaks for files big enough that the engine may have failed on size', async () => {
    const { credentialsUnreadAtThisSize, ENGINE_DOUBT_BYTES } = await import('../src/bmffScan')
    const small = blobOf(ftyp, c2pa, box('mdat', new Uint8Array(500)))
    expect(await credentialsUnreadAtThisSize(small)).toBe(false)
    const head = new Uint8Array([...ftyp, ...c2pa])
    expect(await credentialsUnreadAtThisSize(sparse(head, ENGINE_DOUBT_BYTES - 1))).toBe(false)
    expect(await credentialsUnreadAtThisSize(sparse(head, ENGINE_DOUBT_BYTES))).toBe(true)
    expect(await credentialsUnreadAtThisSize(sparse(new Uint8Array([...ftyp]), ENGINE_DOUBT_BYTES * 2))).toBe(false)
    // Well under the size at which the engine was measured to fail (about 1 GB), so the margin is real.
    expect(ENGINE_DOUBT_BYTES).toBeLessThanOrEqual(768 * 1024 * 1024)
    expect(ENGINE_DOUBT_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024)
  })
})
