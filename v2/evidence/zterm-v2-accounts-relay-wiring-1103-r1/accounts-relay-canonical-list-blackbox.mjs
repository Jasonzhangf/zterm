import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AuthService, MachineService, V1RelayAdapter } from '../../modules/accounts/src/public/contracts.ts'

// Black-box: real V1 relay -> non-empty host-directory -> enroll -> canonical
// list -> revoke -> inactive list, driven through the V2 accounts public API.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-accounts-canonical-list-'))

let child = null
let baseUrl = ''

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
  const suffix = `${process.pid}-${Date.now()}`
  const loginName = `${prefix}-${suffix}`
  const credential = `secret-${suffix}`
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

// A real host publishes its directory, so the relay holds a non-empty
// host-directory (a device row) before any machine is enrolled.
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

try {
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
        ZTERM_TRAVERSAL_BASE_PATH: '',
        ZTERM_TRAVERSAL_STORE_PATH: join(tempRoot, 'store.json'),
        ZTERM_TRAVERSAL_DATA_DIR: tempRoot,
        ZTERM_TRAVERSAL_UPDATES_DIR: join(tempRoot, 'updates'),
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

  const account = await registerAndLogin('canonical-list')
  const adapter = new V1RelayAdapter({ baseUrl })
  const auth = new AuthService({ authority: adapter })
  const machines = new MachineService({
    machineReg: adapter,
    verifySession: (token) => auth.verifySession(token),
  })

  const host = await openHost(account, 'host-dir', 'host-device', 'Host Directory Device')
  const directory = await adapter.getDirectory(account.token)
  assert.ok(directory.devices.some((device) => device.deviceId === 'host-device'))
  console.log(`host-directory-non-empty devices=${directory.devices.length}`)

  const enrolled = await machines.enrollMachine(account.token, {
    deviceId: 'canonical-laptop',
    deviceToken: 'canonical-proof',
    displayName: 'Canonical Laptop',
  })
  assert.match(enrolled.machineId, /^mach_/)
  console.log(`enrolled machineId=${enrolled.machineId} status=${enrolled.status}`)

  const activeList = await machines.listAuthorizedMachines(account.token)
  const activeRow = activeList.find((machine) => machine.machineId === enrolled.machineId)
  assert.ok(activeRow, 'enrolled machine missing from canonical list')
  assert.equal(activeRow.status, 'active')
  assert.equal(activeRow.legacyDeviceId, 'canonical-laptop')
  console.log(`canonical-list-active count=${activeList.length} machineId=${activeRow.machineId} status=${activeRow.status} legacyDeviceId=${activeRow.legacyDeviceId}`)

  const revoked = await machines.revokeMachine(account.token, { machineId: enrolled.machineId })
  assert.equal(revoked.status, 'revoked')
  console.log(`revoked machineId=${revoked.machineId} status=${revoked.status}`)

  const inactiveList = await machines.listAuthorizedMachines(account.token)
  const inactiveRow = inactiveList.find((machine) => machine.machineId === enrolled.machineId)
  assert.ok(inactiveRow, 'revoked machine missing from canonical list')
  assert.equal(inactiveRow.status, 'revoked')
  console.log(`canonical-list-inactive count=${inactiveList.length} machineId=${inactiveRow.machineId} status=${inactiveRow.status}`)

  host.close()
  console.log('accounts-relay-canonical-list-blackbox-ok host-directory->enroll->canonical-list->revoke->inactive-list')
} finally {
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
  rmSync(tempRoot, { recursive: true, force: true })
}
