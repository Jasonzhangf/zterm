import { createServer } from 'node:http'

// The teardown regression needs a serving process that ignores the graceful
// signal. It still exposes the same health/pid shape the real relay uses.
process.on('SIGTERM', () => {})

const host = '127.0.0.1'
const port = Number(process.env.ZTERM_TRAVERSAL_PORT)
const server = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not_found' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, pid: process.pid }))
})
server.listen(port, host)
