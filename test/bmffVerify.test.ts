/*
 *  Checking a video against its credential without holding the video (#197).
 *
 *  A: the credential is one small box; it is read with a few small reads.
 *  B: "was this file changed since signing" means hashing the file the way the
 *     C2PA standard says (skip the excluded boxes, mix in each remaining
 *     top-level box's position), which can be done as the bytes stream past.
 *
 *  The answer key is a real video signed by the Trusteddit testing signer: the
 *  hash our code computes must equal the hash inside its credential.
 *  Run with:  bun test test/bmffVerify.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Sha256, blobSource, topLevelBoxes, readCredentialBox, hashAssertionOf, checkContents, type ByteSource } from '../src/bmffVerify'
import { parseBmffHeader } from '../src/certs/bmff'

const signed = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'durable-video', 'pattern-signed.mp4')))
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** A source over bytes that records how it was read, to prove nothing reads the whole file at once. */
function counting (bytes: Uint8Array): ByteSource & { largest: number, reads: number } {
  const s = {
    size: bytes.length,
    largest: 0,
    reads: 0,
    async read (start: number, end: number) { s.reads++; s.largest = Math.max(s.largest, end - start); return bytes.slice(start, end) }
  }
  return s
}

describe('Sha256', () => {
  it('gives the same digest as the browser, however the data is cut up', async () => {
    const data = new Uint8Array(100_003); for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) % 251
    const want = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
    for (const step of [1, 63, 64, 65, 1000, 100_003]) {
      const h = new Sha256()
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, Math.min(data.length, i + step)))
      expect(hex(h.digest()), `chunks of ${step}`).toBe(want)
    }
    expect(hex(new Sha256().digest())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('A: reading the credential box', () => {
  it('lists the top-level boxes', async () => {
    const boxes = await topLevelBoxes(blobSource(new Blob([signed])))
    expect(boxes[0].type).toBe('ftyp')
    expect(boxes.map((b) => b.type)).toContain('uuid')
    expect(boxes.reduce((n, b) => n + b.size, 0)).toBe(signed.length)
  })

  it('returns the credential alone, with small reads only', async () => {
    const source = counting(signed)
    const found = await readCredentialBox(source)
    expect(found).not.toBeNull()
    // The older parser returns everything from the credential to the end of the
    // file; this one returns the credential alone, which is how it stays small.
    expect(hex(parseBmffHeader(signed)!).startsWith(hex(found!.jumbf))).toBe(true)
    expect(found!.jumbf.length).toBeLessThan(found!.box.size)
    expect(found!.jumbf.length).toBeLessThan(20_000)
    // every read is a box header except the one that fetches the credential itself
    expect(source.largest).toBeLessThanOrEqual(found!.box.size)
  })

  it('finds no credential in a video without one', async () => {
    const plain = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'durable-video', 'scene.mp4')))
    expect(await readCredentialBox(blobSource(new Blob([plain])))).toBeNull()
  })

  it('reads the contents-check assertion out of the credential', async () => {
    const found = await readCredentialBox(blobSource(new Blob([signed])))
    const a = hashAssertionOf(found!.jumbf)!
    expect(a.alg).toBe('sha256')
    expect(a.version).toBe(2)
    expect(a.exclusions.map((e) => e.xpath)).toEqual(['/uuid', '/ftyp', '/mfra'])
    expect(hex(a.hash)).toBe('f2186257a64292ff5128c1ce756b57365252b691b463fe94b3a84f600430acb1')
  })
})

describe('B: checking the contents as a stream', () => {
  it('a video exactly as signed matches its credential', async () => {
    const source = counting(signed)
    expect(await checkContents(source)).toEqual({ result: 'match' })
    expect(source.largest).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('one changed byte in the picture data is caught', async () => {
    const boxes = await topLevelBoxes(blobSource(new Blob([signed])))
    const mdat = boxes.find((b) => b.type === 'mdat')!
    const changed = signed.slice(); changed[mdat.offset + mdat.headerSize + 100] ^= 1
    expect((await checkContents(blobSource(new Blob([changed])))).result).toBe('mismatch')
  })

  it('a change inside a box the standard excludes does not count', async () => {
    const changed = signed.slice(); changed[12] ^= 1 // inside ftyp
    expect((await checkContents(blobSource(new Blob([changed])))).result).toBe('match')
  })

  it('something appended after signing is caught', async () => {
    const extra = new Uint8Array([0, 0, 0, 16, 0x66, 0x72, 0x65, 0x65, 1, 2, 3, 4, 5, 6, 7, 8]) // a 'free' box
    const longer = new Uint8Array(signed.length + extra.length); longer.set(signed); longer.set(extra, signed.length)
    expect((await checkContents(blobSource(new Blob([longer])))).result).toBe('mismatch')
  })

  it('works in small pieces, and reports how far along it is', async () => {
    const seen: number[] = []
    const out = await checkContents(blobSource(new Blob([signed])), { chunkBytes: 4096, onProgress: (done, total) => { seen.push(done / total) } })
    expect(out.result).toBe('match')
    expect(seen.length).toBeGreaterThan(5)
    expect(seen[seen.length - 1]).toBe(1)
  })

  it('says it cannot judge, rather than guess, when there is no credential or a rule it does not implement', async () => {
    const plain = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'durable-video', 'scene.mp4')))
    expect((await checkContents(blobSource(new Blob([plain])))).result).toBe('unsupported')
  })

  it('can be stopped', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(checkContents(blobSource(new Blob([signed])), { signal: abort.signal })).rejects.toThrow()
  })
})
