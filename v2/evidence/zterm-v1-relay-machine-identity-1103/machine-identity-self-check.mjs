import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate relay port')))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 10_000
  let lastError = 'not attempted'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`relay exited before health check\n${output.join('')}`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`relay health timeout: ${lastError}\n${output.join('')}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      resolve()
    }, 3_000)
    timeout.unref?.()
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let body = {}
  if (text.trim()) {
    body = JSON.parse(text)
  }
  return { status: response.status, body }
}

function postJson(baseUrl, path, payload, accessToken) {
  return requestJson(baseUrl, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

async function registerAndLogin(baseUrl, label) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const username = `machine-identity-${label}-${suffix}`
  const password = `fixture-password-${suffix}`
  const registered = await postJson(baseUrl, '/api/auth/register', { username, password })
  assert.equal(registered.status, 201)
  const login = await postJson(baseUrl, '/api/auth/login', { username, password })
  assert.equal(login.status, 200)
  assert.equal(typeof login.body.accessToken, 'string')
  assert.equal(typeof login.body.user?.id, 'string')
  return {
    accessToken: login.body.accessToken,
    accountId: login.body.user.id,
  }
}

async function enroll(baseUrl, accessToken, deviceId, deviceToken) {
  const challenge = await postJson(
    baseUrl,
    '/api/machines/enroll/challenge',
    { deviceId },
    accessToken,
  )
  assert.equal(challenge.status, 200)
  const verified = await postJson(
    baseUrl,
    '/api/machines/enroll/verify',
    {
      requestId: challenge.body.requestId,
      challenge: challenge.body.challenge,
      deviceToken,
      displayName: deviceId,
    },
    accessToken,
  )
  return verified
}

async function possession(baseUrl, accessToken, machineId, deviceToken) {
  const challenge = await postJson(
    baseUrl,
    '/api/machines/possession/challenge',
    { machineId },
    accessToken,
  )
  assert.equal(challenge.status, 200)
  return postJson(
    baseUrl,
    '/api/machines/possession/verify',
    {
      requestId: challenge.body.requestId,
      challenge: challenge.body.challenge,
      deviceToken,
    },
    accessToken,
  )
}

const root = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-relay-machine-identity-check-'))
const storePath = join(tempRoot, 'data', 'store.json')
const output = []
let child

try {
  const port = await availablePort()
  child = spawn(
    join(root, 'android', 'node_modules', '.bin', 'tsx'),
    ['android/src/traversal-relay/server.ts'],
    {
      cwd: root,
      env: {
        ...process.env,
        ZTERM_TRAVERSAL_HOST: '127.0.0.1',
        ZTERM_TRAVERSAL_PORT: String(port),
        ZTERM_TRAVERSAL_BASE_PATH: '',
        ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'data'),
        ZTERM_TRAVERSAL_UPDATES_DIR: join(tempRoot, 'updates'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl, child, output)

  const alice = await registerAndLogin(baseUrl, 'alice')
  const bob = await registerAndLogin(baseUrl, 'bob')
  const sharedProof = 'fixture-device-proof-shared'

  const enrollment = await enroll(
    baseUrl,
    alice.accessToken,
    'alice-machine',
    sharedProof,
  )
  assert.equal(enrollment.status, 200)
  assert.equal(enrollment.body.ownerAccountId, alice.accountId)
  assert.equal(typeof enrollment.body.machineId, 'string')
  const machineId = enrollment.body.machineId

  const replayedEnrollment = await enroll(
    baseUrl,
    alice.accessToken,
    'alice-machine',
    sharedProof,
  )
  assert.equal(replayedEnrollment.status, 200)
  assert.equal(replayedEnrollment.body.machineId, machineId)

  const crossAccountClaim = await enroll(
    baseUrl,
    bob.accessToken,
    'bob-machine',
    sharedProof,
  )
  assert.equal(crossAccountClaim.status, 409)
  assert.equal(crossAccountClaim.body.error?.code, 'machine_already_owned')

  const wrongPossession = await possession(
    baseUrl,
    alice.accessToken,
    machineId,
    'wrong-device-proof',
  )
  assert.equal(wrongPossession.status, 403)
  assert.equal(wrongPossession.body.error?.code, 'possession_invalid')

  const validPossession = await possession(
    baseUrl,
    alice.accessToken,
    machineId,
    sharedProof,
  )
  assert.equal(validPossession.status, 200)
  assert.equal(validPossession.body.machineId, machineId)
  assert.equal(validPossession.body.ownerAccountId, alice.accountId)

  const foreignRevoke = await requestJson(
    baseUrl,
    `/api/machines/${encodeURIComponent(machineId)}/revoke`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.accessToken}` },
    },
  )
  assert.equal(foreignRevoke.status, 403)
  assert.equal(foreignRevoke.body.error?.code, 'machine_not_owned')

  const ownerRevoke = await requestJson(
    baseUrl,
    `/api/machines/${encodeURIComponent(machineId)}/revoke`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    },
  )
  assert.equal(ownerRevoke.status, 200)
  assert.equal(ownerRevoke.body.status, 'revoked')

  const possessionAfterRevoke = await postJson(
    baseUrl,
    '/api/machines/possession/challenge',
    { machineId },
    alice.accessToken,
  )
  assert.equal(possessionAfterRevoke.status, 403)
  assert.equal(possessionAfterRevoke.body.error?.code, 'machine_revoked')

  const logout = await requestJson(baseUrl, '/api/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.accessToken}` },
  })
  assert.equal(logout.status, 200)
  const meAfterLogout = await requestJson(baseUrl, '/api/auth/me', {
    headers: { authorization: `Bearer ${alice.accessToken}` },
  })
  assert.equal(meAfterLogout.status, 401)

  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(store.machines.length, 1)
  assert.equal(store.machines[0].status, 'revoked')
  assert.equal(JSON.stringify(store).includes(sharedProof), false)

  console.log(JSON.stringify({
    ok: true,
    endpoint: baseUrl,
    cases: [
      { name: 'logout-current-session', status: logout.status },
      { name: 'me-after-logout', status: meAfterLogout.status },
      {
        name: 'enroll-canonical-owner',
        status: enrollment.status,
        ownerMatches: enrollment.body.ownerAccountId === alice.accountId,
        returnedMachineId: true,
      },
      {
        name: 'same-account-idempotent-enrollment',
        status: replayedEnrollment.status,
        sameMachineId: replayedEnrollment.body.machineId === machineId,
      },
      {
        name: 'cross-account-proof-reuse',
        status: crossAccountClaim.status,
        code: crossAccountClaim.body.error?.code,
      },
      {
        name: 'wrong-possession-proof',
        status: wrongPossession.status,
        code: wrongPossession.body.error?.code,
      },
      {
        name: 'valid-possession-proof',
        status: validPossession.status,
        sameMachineId: validPossession.body.machineId === machineId,
      },
      {
        name: 'foreign-machine-revoke',
        status: foreignRevoke.status,
        code: foreignRevoke.body.error?.code,
      },
      {
        name: 'owner-machine-revoke',
        status: ownerRevoke.status,
        machineStatus: ownerRevoke.body.status,
      },
      {
        name: 'possession-after-revoke',
        status: possessionAfterRevoke.status,
        code: possessionAfterRevoke.body.error?.code,
      },
    ],
    persistence: {
      machineRecords: store.machines.length,
      machineStatus: store.machines[0].status,
      proofMaterialPersistedAsPlaintext: false,
    },
  }, null, 2))
} finally {
  await stopChild(child)
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('relay-machine-identity-blackbox-ok')
