import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('relay/Dockerfile', () => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf-8')
  const lines = content.split('\n')

  it('pins the FROM tag matching oven/bun:\\d+\\.\\d+\\.\\d+', () => {
    const fromLine = lines.find(line => line.trim().startsWith('FROM '))
    expect(fromLine).toBeDefined()
    expect(fromLine).toMatch(/^FROM\s+oven\/bun:\d+\.\d+\.\d+/)
  })

  it('runs as a non-root USER with the last USER not root and WORKDIR appearing before that USER', () => {
    const userLines = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(item => item.line.startsWith('USER '))
    expect(userLines.length).toBeGreaterThan(0)
    const lastUser = userLines[userLines.length - 1]
    const user = lastUser.line.split(/\s+/)[1]
    expect(user).toBeDefined()
    expect(user).not.toBe('root')
    expect(user).not.toBe('0')

    const workdirIndex = lines.findIndex(line => line.trim().startsWith('WORKDIR '))
    expect(workdirIndex).toBeGreaterThanOrEqual(0)
    expect(workdirIndex).toBeLessThan(lastUser.index)
  })

  it('contains an EXPOSE instruction', () => {
    const exposeLine = lines.find(line => line.trim().startsWith('EXPOSE '))
    expect(exposeLine).toBeDefined()
    expect(exposeLine?.trim()).toBe('EXPOSE 3000')
  })

  it('does not contain sensitive environment variables baked in', () => {
    for (const line of lines) {
      expect(line).not.toContain('RELAY_TICKET_KEY=')
      expect(line).not.toContain('UMAMI_WEBSITE_ID=')
    }
  })
})
