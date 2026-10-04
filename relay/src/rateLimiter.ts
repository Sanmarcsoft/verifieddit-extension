export interface RateLimiterOptions {
  maxRequests?: number
  windowMs?: number
  now?: () => number
}

interface Bucket {
  count: number
  resetAt: number
}

const DEFAULT_MAX_REQUESTS = 30
const DEFAULT_WINDOW_MS = 60 * 1000 // 1 minute
const MS_PER_DAY = 24 * 60 * 60 * 1000

export class RateLimiter {
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly now: () => number

  private currentDayIndex: number
  private currentSalt: string
  private readonly buckets: Map<string, Bucket>

  constructor (options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? Date.now

    this.currentDayIndex = Math.floor(this.now() / MS_PER_DAY)
    this.currentSalt = this.generateSalt()
    this.buckets = new Map()
  }

  private generateSalt (): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString('hex')
  }

  private rotateIfNeeded (currentTime: number): void {
    const dayIndex = Math.floor(currentTime / MS_PER_DAY)
    if (dayIndex !== this.currentDayIndex) {
      this.currentDayIndex = dayIndex
      this.currentSalt = this.generateSalt()
      this.buckets.clear()
    }
  }

  private async hashAddress (address: string): Promise<string> {
    const data = new TextEncoder().encode(`${this.currentSalt}:${address}`)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Buffer.from(digest).toString('hex')
  }

  public getSalt (): string {
    this.rotateIfNeeded(this.now())
    return this.currentSalt
  }

  public getInternalKeys (): string[] {
    return Array.from(this.buckets.keys())
  }

  public hasRawAddress (address: string): boolean {
    for (const key of this.buckets.keys()) {
      if (key === address || key.includes(address)) {
        return true
      }
    }
    return false
  }

  public async isAllowed (clientAddress: string): Promise<boolean> {
    const currentTime = this.now()
    this.rotateIfNeeded(currentTime)

    const key = await this.hashAddress(clientAddress)
    const existing = this.buckets.get(key)

    if (existing == null || currentTime >= existing.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: currentTime + this.windowMs
      })
      return true
    }

    if (existing.count < this.maxRequests) {
      existing.count += 1
      return true
    }

    return false
  }
}
