import { describe, expect, it } from 'bun:test'
import { resolveClientAddress } from '../src/server'

describe('resolveClientAddress', () => {
  const socketAddress = '192.0.2.1'

  it('returns socket address when headerName is unset (undefined)', () => {
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.195' })
    expect(resolveClientAddress(headers, socketAddress, undefined)).toBe(socketAddress)
  })

  it('returns header value when set and present', () => {
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.195' })
    expect(resolveClientAddress(headers, socketAddress, 'CF-Connecting-IP')).toBe('203.0.113.195')
  })

  it('returns socket address when set but absent', () => {
    const headers = new Headers({ 'x-other-header': '203.0.113.195' })
    expect(resolveClientAddress(headers, socketAddress, 'CF-Connecting-IP')).toBe(socketAddress)
  })

  it('returns socket address when set but blank', () => {
    const headers = new Headers({ 'cf-connecting-ip': '   ' })
    expect(resolveClientAddress(headers, socketAddress, 'CF-Connecting-IP')).toBe(socketAddress)
  })

  it('returns first entry of a list when header value contains a comma-separated list', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.195, 198.51.100.1, 192.0.2.1' })
    expect(resolveClientAddress(headers, socketAddress, 'X-Forwarded-For')).toBe('203.0.113.195')
  })

  it('falls back to socket address if first entry of comma-separated list is blank', () => {
    const headers = new Headers({ 'x-forwarded-for': ' , 198.51.100.1' })
    expect(resolveClientAddress(headers, socketAddress, 'X-Forwarded-For')).toBe(socketAddress)
  })

  it('ignores a header other than the configured one even when present', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.195',
      'cf-connecting-ip': '198.51.100.1'
    })
    expect(resolveClientAddress(headers, socketAddress, 'CF-Connecting-IP')).toBe('198.51.100.1')
  })

  it('with the variable unset a forged CF-Connecting-IP or X-Forwarded-For is ignored', () => {
    const headers = new Headers({
      'cf-connecting-ip': '10.0.0.1',
      'x-forwarded-for': '10.0.0.2'
    })
    expect(resolveClientAddress(headers, socketAddress, undefined)).toBe(socketAddress)
  })

  it('works with a plain headers object', () => {
    const headers = { 'CF-Connecting-IP': ' 203.0.113.195 ' }
    expect(resolveClientAddress(headers, socketAddress, 'cf-connecting-ip')).toBe('203.0.113.195')
  })
})
