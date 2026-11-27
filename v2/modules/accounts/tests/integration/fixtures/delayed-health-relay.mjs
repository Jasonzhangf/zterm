import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'

const host = '127.0.0.1'
const port = Number(process.env.ZTERM_TRAVERSAL_PORT)
const delayMs = Number(process.env.ZTERM_HEALTH_BODY_DELAY_MS)
const pidFile = process.env.ZTERM_HEALTH_PID_FILE
const headersFile = process.env.ZTERM_HEALTH_HEADERS_FILE
const stateDir = process.env.ZTERM_HEALTH_STATE_DIR
if (!pidFile || !headersFile || !stateDir) {
  throw new Error('ZTERM_HEALTH_PID_FILE, ZTERM_HEALTH_HEADERS_FILE and ZTERM_HEALTH_STATE_DIR are required')
}
mkdirSync(stateDir, { recursive: true })
writeFileSync(`${stateDir}/owned-state`, 'relay-owned')

const server = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not_found' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.flushHeaders()
  writeFileSync(headersFile, String(Date.now()))
  setTimeout(() => {
    response.end(JSON.stringify({ ok: true, pid: process.pid }))
  }, delayMs)
})
server.listen(port, host, () => {
  writeFileSync(pidFile, String(process.pid))
})
