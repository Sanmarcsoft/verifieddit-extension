import { TIMESTAMP_WINDOW_MS } from './protocol'

export const MAX_REPLAY_CACHE_ENTRIES = 100000
const SWEEP_INTERVAL_MS = 1000 // sweep at most once per second

// P-256 group order n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
const P256_GROUP_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n

export function canonicalizeSignatureKey (signature: string): string {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(signature, 'base64url'))
  } catch {
    return signature
  }

  if (bytes.byteLength !== 64) {
    return signature
  }

  const r = bytes.subarray(0, 32)
  const sBytes = bytes.subarray(32, 64)

  let sHex = '0x'
  for (let i = 0; i < 32; i++) {
    sHex += sBytes[i].toString(16).padStart(2, '0')
  }
  const s = BigInt(sHex)

  const nMinusS = P256_GROUP_ORDER - s
  const canonicalS = s < nMinusS ? s : nMinusS

  const canonicalHex = canonicalS.toString(16).padStart(64, '0')
  const canonicalSBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    canonicalSBytes[i] = parseInt(canonicalHex.slice(i * 2, i * 2 + 2), 16)
  }

  const canonicalBytes = new Uint8Array(64)
  canonicalBytes.set(r, 0)
  canonicalBytes.set(canonicalSBytes, 32)

  return Buffer.from(canonicalBytes).toString('base64url')
}

export interface ReplayCacheOptions {
  maxEntries?: number
  windowMs?: number
  now?: () => number
}

export class ReplayCache {
  private readonly entries = new Map<string, number>()
  private readonly maxEntries: number
  private readonly windowMs: number
  private readonly now: () => number
  private lastSweepTime: number

  constructor (options: ReplayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_REPLAY_CACHE_ENTRIES
    this.windowMs = options.windowMs ?? TIMESTAMP_WINDOW_MS
    this.now = options.now ?? Date.now
    this.lastSweepTime = this.now()
  }

  get size (): number {
    this.purgeExpired(true)
    return this.entries.size
  }

  has (sig: string): boolean {
    const key = canonicalizeSignatureKey(sig)
    const expiresAt = this.entries.get(key)
    if (expiresAt === undefined) {
      return false
    }

    if (this.now() > expiresAt) {
      this.entries.delete(key)
      return false
    }

    return true
  }

  remember (sig: string, ts: number): boolean {
    this.purgeExpired()

    const key = canonicalizeSignatureKey(sig)
    const existingExpiresAt = this.entries.get(key)

    if (existingExpiresAt !== undefined) {
      if (this.now() <= existingExpiresAt) {
        return true
      }
      this.entries.delete(key)
    }

    const expiresAt = ts + this.windowMs
    if (this.now() > expiresAt) {
      return false
    }

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.entries.delete(oldest)
    }

    this.entries.set(key, expiresAt)
    return false
  }

  private purgeExpired (force = false): void {
    const currentTime = this.now()
    if (!force && currentTime - this.lastSweepTime < SWEEP_INTERVAL_MS) {
      return
    }
    this.lastSweepTime = currentTime

    for (const [key, expiresAt] of this.entries) {
      if (currentTime > expiresAt) {
        this.entries.delete(key)
      }
    }
  }
}
