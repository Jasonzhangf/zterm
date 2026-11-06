import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import {
  AccountsError,
  AuthService,
  MachineService,
  V1RelayAdapter,
} from '../../src/public/contracts.ts'

interface RelayServer {
  baseUrl: string
  child: ChildProcess
  tempRoot: string
  output: string[]
}

const RELAY_ROOT = fileURLToPath(new URL('../../../../../android/', import.meta.url))
const RELAY_ENTRY = 'src/traversal-relay/server.ts'
const TSX_PATH = join(RELAY_ROOT, 'node_modules', '.bin', 'tsx')

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate relay test port')))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`relay server did not become healthy: ${lastError}`)
}

async function stopRelay(relay: RelayServer | null): Promise<void> {
  if (!relay) return
  const { child, tempRoot } = relay
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 3000)
      timeout.unref?.()
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

async function startRelay(): Promise<RelayServer> {
  const port = await availablePort()
  const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-v2-accounts-relay-'))
  const output: string[] = []
  const child = spawn(TSX_PATH, [RELAY_ENTRY], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: '127.0.0.1',
      ZTERM_TRAVERSAL_PORT: String(port),
      ZTERM_TRAVERSAL_BASE_PATH: '',
      ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'data'),
      ZTERM_TRAVERSAL_UPDATES_DIR: join(tempRoot, 'updates'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))
  const relay = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    tempRoot,
    output,
  }
  try {
    await waitForHealth(`${relay.baseUrl}/health`)
    return relay
  } catch (error) {
    await stopRelay(relay)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join('')}`)
  }
}

function createFlow(baseUrl: string) {
  const adapter = new V1RelayAdapter({ baseUrl })
  const auth = new AuthService({ authority: adapter })
  const machines = new MachineService({
    machineReg: adapter,
    verifySession: (token) => auth.verifySession(token),
  })
  return { adapter, auth, machines }
}

function uniqueIdentity(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return {
    loginName: `${label}-${suffix}`,
    credential: `pw-${suffix}`,
  }
}

async function createAccount(baseUrl: string, label: string) {
  const { adapter, auth, machines } = createFlow(baseUrl)
  const identity = uniqueIdentity(label)
  const registered = await auth.register(identity)
  const login = await auth.login(identity)
  return {
    accountId: registered.accountId,
    token: login.token,
    identity,
    adapter,
    auth,
    machines,
  }
}

async function expectError(
  promise: Promise<unknown>,
  code: AccountsError['code'],
  status: AccountsError['status'],
  upstreamCode?: string,
): Promise<AccountsError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AccountsError, 'expected an AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    if (upstreamCode) assert.equal(error.details?.upstreamCode, upstreamCode)
    return error
  }
  assert.fail(`expected ${code}`)
}

let relay: RelayServer | null = null

before(async () => {
  relay = await startRelay()
}, { timeout: 15_000 })

after(async () => {
  await stopRelay(relay)
}, { timeout: 10_000 })

test('real V1 relay proves enrollment, possession, owner revoke, and logout', async () => {
  assert.ok(relay, 'real relay is unavailable')
  const alice = await createAccount(relay.baseUrl, 'alice')
  const bob = await createAccount(relay.baseUrl, 'bob')

  // Canonical list is covered by the accounts adapter contract; the real relay
  // endpoint remains a V1-owner dependency for the final black-box.

  const enrolled = await alice.machines.enrollMachine(alice.token, {
    deviceId: 'alice-laptop',
    deviceToken: 'shared-device-proof',
    displayName: 'Alice Laptop',
  })
  assert.equal(enrolled.ownerAccountId, alice.accountId)
  assert.equal(enrolled.status, 'active')
  assert.equal(enrolled.displayName, 'Alice Laptop')
  const machineId = enrolled.machineId
  assert.match(machineId, /^mach_/)

  const repeated = await alice.machines.enrollMachine(alice.token, {
    deviceId: 'alice-laptop',
    deviceToken: 'shared-device-proof',
  })
  assert.equal(repeated.machineId, machineId)

  const conflict = await expectError(
    alice.machines.enrollMachine(alice.token, {
      deviceId: 'alice-laptop',
      deviceToken: 'different-device-proof',
    }),
    'MACHINE_DEVICE_CONFLICT',
    409,
    'machine_device_conflict',
  )
  assert.equal(conflict.details?.upstreamStatus, 409)

  const crossAccount = await expectError(
    bob.machines.enrollMachine(bob.token, {
      deviceId: 'bob-laptop',
      deviceToken: 'shared-device-proof',
    }),
    'MACHINE_ALREADY_OWNED',
    409,
    'machine_already_owned',
  )
  assert.equal(crossAccount.details?.upstreamStatus, 409)

  await expectError(
    alice.machines.verifyMachinePossession(alice.token, {
      machineId,
      deviceToken: 'wrong-device-proof',
    }),
    'POSSESSION_INVALID',
    403,
    'possession_invalid',
  )

  const possession = await alice.machines.verifyMachinePossession(alice.token, {
    machineId,
    deviceToken: 'shared-device-proof',
  })
  assert.equal(possession.machineId, machineId)
  assert.equal(possession.ownerAccountId, alice.accountId)
  assert.equal(possession.status, 'active')

  const foreignRevoke = await expectError(
    bob.machines.revokeMachine(bob.token, { machineId }),
    'MACHINE_NOT_OWNED',
    403,
    'machine_not_owned',
  )
  assert.equal(foreignRevoke.details?.upstreamStatus, 403)

  const revoked = await alice.machines.revokeMachine(alice.token, { machineId })
  assert.equal(revoked.machineId, machineId)
  assert.equal(revoked.status, 'revoked')

  await expectError(
    alice.machines.verifyMachinePossession(alice.token, {
      machineId,
      deviceToken: 'shared-device-proof',
    }),
    'MACHINE_REVOKED',
    403,
    'machine_revoked',
  )

  await expectError(
    alice.machines.verifyMachinePossession(alice.token, {
      machineId: 'mach_missing',
      deviceToken: 'shared-device-proof',
    }),
    'MACHINE_NOT_FOUND',
    404,
    'machine_not_found',
  )

  const logout = await alice.auth.logout(alice.token)
  assert.equal(logout.sessionId, alice.token)

  await expectError(alice.auth.verifySession(alice.token), 'AUTHENTICATION_REQUIRED', 401)
  await expectError(
    alice.machines.listAuthorizedMachines(alice.token),
    'AUTHENTICATION_REQUIRED',
    401,
  )
})
