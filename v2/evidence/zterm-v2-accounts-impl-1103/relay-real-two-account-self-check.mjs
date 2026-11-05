import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AuthService, MachineService, V1RelayAdapter } from '../../modules/accounts/src/public/contracts.ts'

const repoRoot = process.env.ZTERM_REPO_ROOT || '/Volumes/extension/code/zterm'
const externalBaseUrl = process.env.ZTERM_REAL_RELAY_BASE_URL || ''
const machinePrefix = process.env.ZTERM_TWO_ACCOUNT_PREFIX || 'machine'
const tempRoot = externalBaseUrl ? '' : mkdtempSync(join(tmpdir(), 'zterm-accounts-relay-'))

let child = null
let baseUrl = externalBaseUrl.replace(/\/+$/, '')

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve relay port')))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000
  let lastError = 'not started'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(`relay health timeout: ${lastError}`)
}

async function post(path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status} ${JSON.stringify(payload)}`)
  }
  return payload
}

async function registerAndLogin(prefix) {
  const loginName = `${prefix}-${process.pid}-${Date.now()}`
  const credential = `secret-${process.pid}-${Date.now()}`
  await post('/api/auth/register', { username: loginName, password: credential })
  const login = await post('/api/auth/login', { username: loginName, password: credential })
  assert.equal(typeof login.accessToken, 'string')
  assert.ok(login.accessToken.length > 0)
  return { loginName, credential, token: login.accessToken }
}

function waitForEnvelope(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolveEnvelope, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('relay envelope timeout'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onMessage = (event) => {
      try {
        const envelope = JSON.parse(String(event.data))
        if (!predicate(envelope)) return
        cleanup()
        resolveEnvelope(envelope)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error('relay websocket error'))
    }
    const onClose = () => {
      cleanup()
      reject(new Error('relay websocket closed before expected envelope'))
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onClose, { once: true })
  })
}

async function openHost(session, hostId, deviceId, deviceName) {
  const url = new URL(baseUrl.replace(/^http/, 'ws') + '/ws/host')
  url.searchParams.set('token', session.token)
  url.searchParams.set('hostId', hostId)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('deviceName', deviceName)
  url.searchParams.set('platform', 'integration-test')
  url.searchParams.set('appVersion', 'test')
  url.searchParams.set('daemonVersion', 'test')

  const socket = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', () => reject(new Error('relay host websocket open failed')), { once: true })
  })
  await waitForEnvelope(socket, (envelope) => envelope.type === 'relay-ready')
  socket.send(JSON.stringify({
    type: 'directory-update',
    directory: {
      endpoints: [],
      sessions: [{ name: `session-${deviceId}`, updatedAt: new Date().toISOString() }],
      publishedAt: new Date().toISOString(),
    },
  }))
  return socket
}

async function waitForMachine(machines, token, machineId) {
  const deadline = Date.now() + 5_000
  let last = []
  while (Date.now() < deadline) {
    last = await machines.listAuthorizedMachines(token)
    if (last.some((machine) => machine.machineId === machineId)) return last
    await delay(50)
  }
  throw new Error(`machine ${machineId} did not appear: ${JSON.stringify(last)}`)
}

try {
  if (!baseUrl) {
    const port = await reservePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(
      resolve(repoRoot, 'android/node_modules/.bin/tsx'),
      [resolve(repoRoot, 'android/src/traversal-relay/server.ts')],
      {
        cwd: resolve(repoRoot, 'android'),
        env: {
          ...process.env,
          ZTERM_TRAVERSAL_PORT: String(port),
          ZTERM_TRAVERSAL_HOST: '127.0.0.1',
          ZTERM_TRAVERSAL_STORE_PATH: join(tempRoot, 'store.json'),
          ZTERM_TRAVERSAL_DATA_DIR: tempRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    await waitForHealth().catch((error) => {
      throw new Error(`${error.message}\nrelay stderr:\n${stderr}`)
    })
  }

  const accountA = await registerAndLogin('account-a')
  const accountB = await registerAndLogin('account-b')
  const hostA = await openHost(accountA, 'host-a', `${machinePrefix}-a`, 'Machine A')
  const hostB = await openHost(accountB, 'host-b', `${machinePrefix}-b`, 'Machine B')

  const adapter = new V1RelayAdapter({ baseUrl })
  const auth = new AuthService({ authority: adapter })
  const machines = new MachineService({
    directory: adapter,
    machineReg: adapter,
    verifySession: (token) => auth.verifySession(token),
  })

  const listA = await waitForMachine(machines, accountA.token, `${machinePrefix}-a`)
  const listB = await waitForMachine(machines, accountB.token, `${machinePrefix}-b`)
  assert.deepEqual(listA.map((machine) => machine.machineId), [`${machinePrefix}-a`])
  assert.deepEqual(listB.map((machine) => machine.machineId), [`${machinePrefix}-b`])
  assert.equal(listA.every((machine) => machine.ownerAccountId !== listB[0].ownerAccountId), true)

  const logout = auth.logout(accountA.token)
  assert.equal(logout.sessionId, accountA.token)
  await assert.rejects(auth.verifySession(accountA.token), (error) => error?.code === 'SESSION_REVOKED')

  const accountARelogin = await post('/api/auth/login', {
    username: accountA.loginName,
    password: accountA.credential,
  })
  const listAAfterLogout = await waitForMachine(machines, accountARelogin.accessToken, `${machinePrefix}-a`)
  assert.deepEqual(listAAfterLogout.map((machine) => machine.machineId), [`${machinePrefix}-a`])
  const listBStill = await machines.listAuthorizedMachines(accountB.token)
  assert.deepEqual(listBStill.map((machine) => machine.machineId), [`${machinePrefix}-b`])

  hostA.close()
  hostB.close()
  console.log('relay-real-two-account-isolation-ok register->login->host-directory->isolated-list->logout-retains-machines')
} finally {
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
}
