import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { AuthService, MachineService, V1RelayAdapter } from '../../modules/accounts/src/public/contracts.ts'

const users = new Map()
const tokens = new Map()
let sequence = 0

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const method = req.method
  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readBody(req)
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username) return json(res, 400, { ok: false, message: 'username is required' })
    if (!password.trim()) return json(res, 400, { ok: false, message: 'password is required' })
    if (users.has(username)) return json(res, 400, { ok: false, message: 'username already exists' })
    const id = `acct-${username}`
    users.set(username, { id, username, password })
    return json(res, 201, { ok: true, user: { id, username, createdAt: '2026-11-03T00:00:00.000Z' } })
  }
  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req)
    const user = users.get(typeof body.username === 'string' ? body.username.trim() : '')
    if (!user || user.password !== body.password) return json(res, 401, { ok: false, message: 'invalid username or password' })
    const token = `real-token-${++sequence}`
    tokens.set(token, user.id)
    return json(res, 200, { ok: true, accessToken: token, user: { id: user.id, username: user.username } })
  }
  if (method === 'GET' && path === '/api/auth/me') {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('bearer ') ? auth.slice(7) : ''
    const userId = tokens.get(token)
    const user = userId ? [...users.values()].find((u) => u.id === userId) : undefined
    if (!user) return json(res, 401, { ok: false, message: 'unauthorized' })
    return json(res, 200, { ok: true, user: { id: user.id, username: user.username } })
  }
  if (method === 'GET' && path === '/api/directory') {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('bearer ') ? auth.slice(7) : ''
    const userId = tokens.get(token)
    const user = userId ? [...users.values()].find((u) => u.id === userId) : undefined
    if (!user) return json(res, 401, { ok: false, message: 'unauthorized' })
    return json(res, 200, {
      ok: true,
      schemaVersion: 1,
      user: { id: user.id, username: user.username },
      devices: [{ deviceId: 'real-device-1', deviceName: 'Real Device', platform: 'macos' }],
      updatedAt: '2026-11-03T00:00:00.000Z',
    })
  }
  return json(res, 404, { ok: false, message: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const adapter = new V1RelayAdapter({ baseUrl: `http://127.0.0.1:${address.port}` })
const auth = new AuthService({ authority: adapter, now: () => Date.now(), sessionTtlMs: 60000 })
const machines = new MachineService({
  directory: adapter,
  machineReg: adapter,
  verifySession: (token) => auth.verifySession(token),
  now: () => Date.now(),
})

try {
  const registered = await auth.register({ loginName: 'relay-user', credential: 'secret-real' })
  assert.deepEqual(registered, { accountId: 'acct-relay-user', loginName: 'relay-user' })

  await assert.rejects(
    auth.register({ loginName: 'relay-user', credential: 'other' }),
    (error) => error?.code === 'ACCOUNT_EXISTS' && error?.status === 409,
  )

  const login = await auth.login({ loginName: 'relay-user', credential: 'secret-real' })
  assert.ok(login.token.startsWith('real-token-'))
  assert.equal(login.authContext.accountId, 'acct-relay-user')

  const verified = await auth.verifySession(login.token)
  assert.equal(verified.accountId, 'acct-relay-user')
  assert.equal(verified.sessionId, login.token)

  const list = await machines.listAuthorizedMachines(login.token)
  assert.equal(list.length, 1)
  assert.equal(list[0].machineId, 'real-device-1')
  assert.equal(list[0].ownerAccountId, 'acct-relay-user')

  console.log('relay-compose-ok register->login->verifySession->list')
} finally {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
}
