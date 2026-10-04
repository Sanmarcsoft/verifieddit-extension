import { TIMESTAMP_WINDOW_MS } from './protocol'

export const MAX_REPLAY_CACHE_ENTRIES = 100000

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

  constructor (options: ReplayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_REPLAY_CACHE_ENTRIES
    this.windowMs = options.windowMs ?? TIMESTAMP_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  get size (): number {
    this.purgeExpired()
    return this.entries.size
  }

  has (sig: string): boolean {
    this.purgeExpired()
    return this.entries.has(sig)
  }

  remember (sig: string, ts: number): boolean {
    this.purgeExpired()

    if (this.entries.has(sig)) {
      return true
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

    this.entries.set(sig, expiresAt)
    return false
  }

  private purgeExpired (): void {
    const currentTime = this.now()
    for (const [sig, expiresAt] of this.entries) {
      if (currentTime > expiresAt) {
        this.entries.delete(sig)
      }
    }
  }
}
