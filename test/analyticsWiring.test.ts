import { describe, it, expect, beforeEach } from 'bun:test'
import {
  mapMediaType,
  mapVerificationResult,
  shouldEmitScanEvent,
  SCAN_EVENT_THROTTLE_MSEC,
  _resetStateForTesting,
  _scanThrottleSizeForTesting
} from '../src/analytics'

describe('Analytics pure mapping helpers', () => {
  describe('mapMediaType', () => {
    it('maps image formats and default fallbacks', () => {
      expect(mapMediaType('image')).toBe('image')
      expect(mapMediaType('image/png')).toBe('image')
      expect(mapMediaType('IMAGE')).toBe('image')
      expect(mapMediaType(null)).toBe('image')
      expect(mapMediaType(undefined)).toBe('image')
      expect(mapMediaType('unknown-format')).toBe('image')
    })

    it('maps video formats', () => {
      expect(mapMediaType('video')).toBe('video')
      expect(mapMediaType('video/mp4')).toBe('video')
      expect(mapMediaType('VIDEO')).toBe('video')
    })

    it('maps audio formats', () => {
      expect(mapMediaType('audio')).toBe('audio')
      expect(mapMediaType('audio/mp3')).toBe('audio')
      expect(mapMediaType('AUDIO')).toBe('audio')
    })

    it('maps pdf formats', () => {
      expect(mapMediaType('pdf')).toBe('pdf')
      expect(mapMediaType('application/pdf')).toBe('pdf')
      expect(mapMediaType('PDF')).toBe('pdf')
    })
  })

  describe('mapVerificationResult', () => {
    it('maps general Error instances to error', () => {
      const err = new Error('Network timeout')
      expect(mapVerificationResult(err)).toBe('error')
    })

    it('maps No Manifest errors to none', () => {
      const noManifestErr = new Error('No manifest found')
      expect(mapVerificationResult(noManifestErr)).toBe('none')

      const namedErr = new Error('Something')
      namedErr.name = 'No Manifest'
      expect(mapVerificationResult(namedErr)).toBe('none')

      const plainObj = { name: 'No Manifest', message: 'No manifest found' }
      expect(mapVerificationResult(plainObj)).toBe('none')
    })

    it('maps computed verdicts', () => {
      expect(mapVerificationResult({}, 'verified')).toBe('valid')
      expect(mapVerificationResult({}, 'authentic')).toBe('valid')
      expect(mapVerificationResult({}, 'invalid')).toBe('invalid')
      expect(mapVerificationResult({}, 'unsigned')).toBe('none')
    })

    it('defaults unknown state to none', () => {
      expect(mapVerificationResult({}, null)).toBe('none')
    })
  })
})

describe('Auto-scan event throttle (shouldEmitScanEvent)', () => {
  beforeEach(() => {
    _resetStateForTesting()
  })

  it('first call for a tab emits', () => {
    const t0 = 1_000_000
    expect(shouldEmitScanEvent(1, t0)).toBe(true)
  })

  it('second call for the same tab inside the window does not emit', () => {
    const t0 = 1_000_000
    expect(shouldEmitScanEvent(1, t0)).toBe(true)
    expect(shouldEmitScanEvent(1, t0 + 1_000)).toBe(false)
    expect(shouldEmitScanEvent(1, t0 + SCAN_EVENT_THROTTLE_MSEC - 1)).toBe(false)
  })

  it('call after SCAN_EVENT_THROTTLE_MSEC has elapsed emits again', () => {
    const t0 = 1_000_000
    expect(shouldEmitScanEvent(1, t0)).toBe(true)
    expect(shouldEmitScanEvent(1, t0 + 1_000)).toBe(false)
    expect(shouldEmitScanEvent(1, t0 + SCAN_EVENT_THROTTLE_MSEC)).toBe(true)
    expect(shouldEmitScanEvent(1, t0 + SCAN_EVENT_THROTTLE_MSEC + 1_000)).toBe(false)
  })

  it('two different tab ids are throttled independently', () => {
    const t0 = 1_000_000
    expect(shouldEmitScanEvent(1, t0)).toBe(true)
    expect(shouldEmitScanEvent(2, t0 + 500)).toBe(true)
    expect(shouldEmitScanEvent(1, t0 + 1_000)).toBe(false)
    expect(shouldEmitScanEvent(2, t0 + 1_500)).toBe(false)
  })

  it('an undefined tab id is throttled under its own bucket rather than throwing', () => {
    const t0 = 1_000_000
    expect(shouldEmitScanEvent(undefined, t0)).toBe(true)
    expect(shouldEmitScanEvent(undefined, t0 + 5_000)).toBe(false)
    expect(shouldEmitScanEvent(1, t0 + 10_000)).toBe(true)
    expect(shouldEmitScanEvent(undefined, t0 + SCAN_EVENT_THROTTLE_MSEC)).toBe(true)
  })

  it('entries older than the window are pruned over time', () => {
    const t0 = 1_000_000
    for (let tabId = 1; tabId <= 50; tabId++) {
      expect(shouldEmitScanEvent(tabId, t0)).toBe(true)
    }
    expect(_scanThrottleSizeForTesting()).toBe(50)

    // At t0 + SCAN_EVENT_THROTTLE_MSEC, calling with a new tab should prune the old 50 entries
    const t1 = t0 + SCAN_EVENT_THROTTLE_MSEC
    expect(shouldEmitScanEvent(999, t1)).toBe(true)
    expect(_scanThrottleSizeForTesting()).toBe(1)
  })
})
