import { describe, expect, it } from 'bun:test'
import {
  ERASURE_PER_ADDRESS_MAX,
  ERASURE_PER_ADDRESS_WINDOW_MS,
  ERASURE_PER_INSTALL_MAX,
  ERASURE_PER_INSTALL_WINDOW_MS,
  EVENTS_PER_ADDRESS_MAX,
  EVENTS_PER_ADDRESS_WINDOW_MS,
  EVENTS_PER_INSTALL_MAX,
  EVENTS_PER_INSTALL_WINDOW_MS,
  INSTALLS_PER_ADDRESS_MAX,
  INSTALLS_PER_ADDRESS_WINDOW_MS
} from '../src/limits'

describe('limits constants', () => {
  it('defines the required rate limits and window values', () => {
    // events per install id 120 per minute
    expect(EVENTS_PER_INSTALL_MAX).toBe(120)
    expect(EVENTS_PER_INSTALL_WINDOW_MS).toBe(60 * 1000)

    // events per client address 600 per minute
    expect(EVENTS_PER_ADDRESS_MAX).toBe(600)
    expect(EVENTS_PER_ADDRESS_WINDOW_MS).toBe(60 * 1000)

    // erasure per install id 5 per hour
    expect(ERASURE_PER_INSTALL_MAX).toBe(5)
    expect(ERASURE_PER_INSTALL_WINDOW_MS).toBe(60 * 60 * 1000)

    // erasure per client address 30 per hour
    expect(ERASURE_PER_ADDRESS_MAX).toBe(30)
    expect(ERASURE_PER_ADDRESS_WINDOW_MS).toBe(60 * 60 * 1000)

    // installs per address unchanged: 30 per minute
    expect(INSTALLS_PER_ADDRESS_MAX).toBe(30)
    expect(INSTALLS_PER_ADDRESS_WINDOW_MS).toBe(60 * 1000)
  })
})
