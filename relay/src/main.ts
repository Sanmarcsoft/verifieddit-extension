import { loadConfig } from './config'
import { createHandler } from './server'

const config = loadConfig(process.env)
const handler = createHandler({ config })

const server = Bun.serve({
  port: config.port,
  async fetch (req, server) {
    const clientAddress = server.requestIP(req)?.address ?? '127.0.0.1'
    return await handler(req, clientAddress)
  }
})

console.log(`Relay service running on http://localhost:${server.port}`)
