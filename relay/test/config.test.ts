import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  const validKey = '01234567890123456789012345678901' // 32 bytes

  it('loads valid configuration successfully', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'https://umami.example.com',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000',
      PORT: '4000'
    }

    const config = loadConfig(env)
    expect(config.ticketKey).toBe(validKey)
    expect(config.umamiUrl).toBe('https://umami.example.com')
    expect(config.umamiWebsiteId).toBe('00000000-0000-0000-0000-000000000000')
    expect(config.port).toBe(4000)
  })

  it('normalizes umamiUrl by stripping trailing slashes', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'https://umami.example.com/',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    const config = loadConfig(env)
    expect(config.umamiUrl).toBe('https://umami.example.com')
  })

  it('defaults port to 3000 when PORT is not provided', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'https://umami.example.com',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    const config = loadConfig(env)
    expect(config.port).toBe(3000)
  })

  it('throws if RELAY_TICKET_KEY is missing', () => {
    const env = {
      UMAMI_URL: 'https://umami.example.com',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    expect(() => loadConfig(env)).toThrow('RELAY_TICKET_KEY is required and must be at least 32 bytes')
  })

  it('throws if RELAY_TICKET_KEY is shorter than 32 bytes', () => {
    const env = {
      RELAY_TICKET_KEY: 'too-short',
      UMAMI_URL: 'https://umami.example.com',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    expect(() => loadConfig(env)).toThrow('RELAY_TICKET_KEY is required and must be at least 32 bytes')
  })

  it('throws if UMAMI_URL is missing', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    expect(() => loadConfig(env)).toThrow('UMAMI_URL is required')
  })

  it('throws if UMAMI_URL is invalid', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'not-a-valid-url',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000'
    }

    expect(() => loadConfig(env)).toThrow('UMAMI_URL must be a valid HTTP or HTTPS URL')
  })

  it('throws if UMAMI_WEBSITE_ID is missing', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'https://umami.example.com'
    }

    expect(() => loadConfig(env)).toThrow('UMAMI_WEBSITE_ID is required')
  })

  it('throws if PORT is not a valid integer', () => {
    const env = {
      RELAY_TICKET_KEY: validKey,
      UMAMI_URL: 'https://umami.example.com',
      UMAMI_WEBSITE_ID: '00000000-0000-0000-0000-000000000000',
      PORT: 'invalid-port'
    }

    expect(() => loadConfig(env)).toThrow('PORT must be a valid integer')
  })
})
