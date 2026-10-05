import { loadConfig } from './config'
import { createHandler, resolveClientAddress } from './server'

const config = loadConfig(process.env)
const handler = createHandler({ config })

const server = Bun.serve({
  port: config.port,
  async fetch (req, server) {
    const socketAddress = server.requestIP(req)?.address ?? '127.0.0.1'
    const clientAddress = resolveClientAddress(req.headers, socketAddress, config.clientIpHeader)
    return await handler(req, clientAddress)
  }
})

console.log(`Relay service running on http://localhost:${server.port}`)
