import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountsError, MachineService } from '../../src/public/contracts.ts'
import type {
  AuthContext,
  MachineIdentity,
  MachineProof,
  MachineRegistrationPort,
  MachineSummary,
} from '../../src/public/contracts.ts'

const NOW = Date.UTC(2026, 10, 3, 0, 0, 0)
const CREATED_AT = '2026-11-03T00:00:00.000Z'

function context(accountId: string, sessionId: string): AuthContext {
  return {
    sessionId,
    accountId,
    loginName: accountId,
    displayName: accountId,
    credentialState: 'active',
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  }
}

interface HarnessOptions {
  listMachines?: (accessToken: string) => Promise<MachineSummary[]>
  enroll?: (accessToken: string, proof: MachineProof, displayName?: string) => Promise<MachineIdentity>
  verifyPossession?: (accessToken: string, machineId: string, deviceToken: string) => Promise<MachineIdentity>
  revokeMachine?: (accessToken: string, machineId: string) => Promise<{ machineId: string; status: 'revoked' }>
}

function createHarness(options: HarnessOptions = {}) {
  const sessions = new Map<string, AuthContext>()
  const listCalls: string[] = []
  const enrollCalls: Array<{ accessToken: string; proof: MachineProof; displayName?: string }> = []
  const possessionCalls: Array<{ accessToken: string; machineId: string; deviceToken: string }> = []
  const revokeCalls: Array<{ accessToken: string; machineId: string }> = []

  const machineReg: MachineRegistrationPort = {
    async listMachines(accessToken) {
      listCalls.push(accessToken)
      if (options.listMachines) return await options.listMachines(accessToken)
      return []
    },
    async enroll(accessToken, proof, displayName) {
      enrollCalls.push({ accessToken, proof, displayName })
      if (options.enroll) return await options.enroll(accessToken, proof, displayName)
      return { machineId: `machine-${proof.deviceId}`, ownerAccountId: 'acct-a' }
    },
    async verifyPossession(accessToken, machineId, deviceToken) {
      possessionCalls.push({ accessToken, machineId, deviceToken })
      if (options.verifyPossession) return await options.verifyPossession(accessToken, machineId, deviceToken)
      return { machineId, ownerAccountId: 'acct-a' }
    },
    async revokeMachine(accessToken, machineId) {
      revokeCalls.push({ accessToken, machineId })
      if (options.revokeMachine) return await options.revokeMachine(accessToken, machineId)
      return { machineId, status: 'revoked' }
    },
  }
  const service = new MachineService({
    machineReg,
    verifySession: (token) => {
      const found = sessions.get(token)
      if (!found) {
        throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
      }
      return found
    },
    now: () => NOW,
  })
  return { service, sessions, listCalls, enrollCalls, possessionCalls, revokeCalls }
}

function expectError(code: AccountsError['code'], status: AccountsError['status'], message?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AccountsError, 'expected an AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    if (message !== undefined) {
      assert.equal(error.message, message)
    }
    return true
  }
}

function authorized(harness: ReturnType<typeof createHarness>) {
  harness.sessions.set('token-a', context('acct-a', 'token-a'))
}

test('listAuthorizedMachines maps canonical machines and keeps legacy device refs separate', async () => {
  const harness = createHarness({
    listMachines: async () => [
      {
        machineId: 'mach-1',
        ownerAccountId: 'acct-a',
        legacyDeviceId: 'device-1',
        displayName: 'Laptop',
        status: 'active',
        createdAt: CREATED_AT,
      },
      {
        machineId: 'mach-2',
        ownerAccountId: 'acct-a',
        legacyDeviceId: 'device-2',
        displayName: 'Desktop',
        status: 'revoked',
        createdAt: CREATED_AT,
      },
    ],
  })
  authorized(harness)

  const machines = await harness.service.listAuthorizedMachines('token-a')
  assert.deepEqual(machines, [
    {
      machineId: 'mach-1',
      ownerAccountId: 'acct-a',
      displayName: 'Laptop',
      status: 'active',
      createdAt: CREATED_AT,
      legacyDeviceId: 'device-1',
    },
    {
      machineId: 'mach-2',
      ownerAccountId: 'acct-a',
      displayName: 'Desktop',
      status: 'revoked',
      createdAt: CREATED_AT,
      legacyDeviceId: 'device-2',
    },
  ])
  assert.deepEqual(harness.listCalls, ['token-a'])
})

test('listAuthorizedMachines stays account-scoped and never projects legacy ids as machine ids', async () => {
  const harness = createHarness({
    listMachines: async (token) => token === 'token-a'
      ? [{
          machineId: 'mach-a',
          ownerAccountId: 'acct-a',
          legacyDeviceId: 'shared-legacy-name',
          displayName: 'A',
          status: 'active',
          createdAt: CREATED_AT,
        }]
      : [{
          machineId: 'mach-b',
          ownerAccountId: 'acct-b',
          legacyDeviceId: 'shared-legacy-name',
          displayName: 'B',
          status: 'active',
          createdAt: CREATED_AT,
        }],
  })
  harness.sessions.set('token-a', context('acct-a', 'token-a'))
  harness.sessions.set('token-b', context('acct-b', 'token-b'))

  const a = await harness.service.listAuthorizedMachines('token-a')
  const b = await harness.service.listAuthorizedMachines('token-b')
  assert.deepEqual(a.map((machine) => machine.machineId), ['mach-a'])
  assert.deepEqual(b.map((machine) => machine.machineId), ['mach-b'])
  assert.equal(a[0].legacyDeviceId, b[0].legacyDeviceId)
})

test('listAuthorizedMachines returns an empty canonical list without consulting a legacy directory', async () => {
  const harness = createHarness()
  authorized(harness)

  assert.deepEqual(await harness.service.listAuthorizedMachines('token-a'), [])
  assert.deepEqual(harness.listCalls, ['token-a'])
})

test('enrollMachine rejects an empty device id before any registration', async () => {
  const harness = createHarness()
  authorized(harness)

  await assert.rejects(
    harness.service.enrollMachine('token-a', { deviceId: '   ', deviceToken: 'proof' }),
    expectError('INVALID_REQUEST', 400, 'Machine device ID is required.'),
  )
  assert.equal(harness.enrollCalls.length, 0)
})

test('enrollMachine requires proof-of-possession material', async () => {
  const harness = createHarness()
  authorized(harness)

  await assert.rejects(
    harness.service.enrollMachine('token-a', { deviceId: 'device-new', deviceToken: '' }),
    expectError('INVALID_REQUEST', 400, 'Device proof-of-possession material is required.'),
  )
  assert.equal(harness.enrollCalls.length, 0)
})

test('enrollMachine calls relay directly and does not reject from a legacy device directory', async () => {
  const harness = createHarness({
    listMachines: async () => {
      throw new Error('legacy list must not run during enrollment')
    },
  })
  authorized(harness)

  const machine = await harness.service.enrollMachine('token-a', {
    deviceId: 'device-existing-in-legacy-directory',
    deviceToken: 'proof-token',
  })

  assert.equal(machine.machineId, 'machine-device-existing-in-legacy-directory')
  assert.equal(machine.legacyDeviceId, 'device-existing-in-legacy-directory')
  assert.equal(harness.listCalls.length, 0)
  assert.equal(harness.enrollCalls.length, 1)
})

test('enrollMachine returns the canonical relay machine identity', async () => {
  const harness = createHarness()
  authorized(harness)

  const machine = await harness.service.enrollMachine('token-a', {
    deviceId: 'device-new',
    deviceToken: 'proof-token',
    displayName: ' New Box ',
  })

  assert.deepEqual(machine, {
    machineId: 'machine-device-new',
    ownerAccountId: 'acct-a',
    displayName: 'New Box',
    status: 'active',
    createdAt: new Date(NOW).toISOString(),
    legacyDeviceId: 'device-new',
  })
  assert.deepEqual(harness.enrollCalls, [
    {
      accessToken: 'token-a',
      proof: { deviceId: 'device-new', deviceToken: 'proof-token' },
      displayName: 'New Box',
    },
  ])
})

test('enrollMachine preserves a cross-account canonical proof conflict', async () => {
  const harness = createHarness({
    enroll: async () => {
      throw new AccountsError('MACHINE_ALREADY_OWNED', 409, 'machine_already_owned')
    },
  })
  authorized(harness)

  await assert.rejects(
    harness.service.enrollMachine('token-a', { deviceId: 'device-new', deviceToken: 'shared-proof' }),
    expectError('MACHINE_ALREADY_OWNED', 409, 'machine_already_owned'),
  )
})

test('verifyMachinePossession returns the owner machine or preserves rejection', async () => {
  const harness = createHarness()
  authorized(harness)

  const machine = await harness.service.verifyMachinePossession('token-a', {
    machineId: 'machine-1',
    deviceToken: 'proof-token',
  })
  assert.deepEqual(machine, {
    machineId: 'machine-1',
    ownerAccountId: 'acct-a',
    displayName: 'machine-1',
    status: 'active',
    createdAt: new Date(NOW).toISOString(),
  })
  assert.deepEqual(harness.possessionCalls, [
    { accessToken: 'token-a', machineId: 'machine-1', deviceToken: 'proof-token' },
  ])

  const rejected = createHarness({
    verifyPossession: async () => {
      throw new AccountsError('MACHINE_REVOKED', 403, 'machine_revoked')
    },
  })
  authorized(rejected)
  await assert.rejects(
    rejected.service.verifyMachinePossession('token-a', { machineId: 'machine-1', deviceToken: 'proof-token' }),
    expectError('MACHINE_REVOKED', 403, 'machine_revoked'),
  )
})

test('verifyMachinePossession rejects missing machine or proof material', async () => {
  const harness = createHarness()
  authorized(harness)

  await assert.rejects(
    harness.service.verifyMachinePossession('token-a', { machineId: '  ', deviceToken: 'proof' }),
    expectError('INVALID_REQUEST', 400, 'Machine ID is required.'),
  )
  await assert.rejects(
    harness.service.verifyMachinePossession('token-a', { machineId: 'machine-1', deviceToken: '' }),
    expectError('INVALID_REQUEST', 400, 'Device proof-of-possession material is required.'),
  )
  assert.equal(harness.possessionCalls.length, 0)
})

test('revokeMachine returns a revoked machine and preserves owner rejection', async () => {
  const harness = createHarness()
  authorized(harness)

  const machine = await harness.service.revokeMachine('token-a', { machineId: 'machine-1' })
  assert.deepEqual(machine, {
    machineId: 'machine-1',
    ownerAccountId: 'acct-a',
    displayName: 'machine-1',
    status: 'revoked',
    createdAt: new Date(NOW).toISOString(),
  })
  assert.deepEqual(harness.revokeCalls, [{ accessToken: 'token-a', machineId: 'machine-1' }])

  const rejected = createHarness({
    revokeMachine: async () => {
      throw new AccountsError('MACHINE_NOT_OWNED', 403, 'machine_not_owned')
    },
  })
  authorized(rejected)
  await assert.rejects(
    rejected.service.revokeMachine('token-a', { machineId: 'machine-1' }),
    expectError('MACHINE_NOT_OWNED', 403, 'machine_not_owned'),
  )
})

test('missing or invalid token is rejected before list, enroll, possession, or revoke work', async () => {
  const harness = createHarness()
  await assert.rejects(
    harness.service.listAuthorizedMachines('missing-token'),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
  await assert.rejects(
    harness.service.enrollMachine('missing-token', { deviceId: 'device-new', deviceToken: 'proof' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
  await assert.rejects(
    harness.service.verifyMachinePossession('missing-token', { machineId: 'machine-1', deviceToken: 'proof' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
  await assert.rejects(
    harness.service.revokeMachine('missing-token', { machineId: 'machine-1' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
})

test('cross-account grant and revoke are disabled, but the token is verified first', async () => {
  const harness = createHarness()
  authorized(harness)

  await assert.rejects(
    harness.service.grantMachineAccess('token-a', { machineId: 'machine-1', granteeAccountId: 'acct-b' }),
    expectError('CROSS_ACCOUNT_ACCESS_DISABLED', 403, 'Cross-account machine access is disabled.'),
  )
  await assert.rejects(
    harness.service.revokeMachineAccess('token-a', { machineId: 'machine-1', granteeAccountId: 'acct-b' }),
    expectError('CROSS_ACCOUNT_ACCESS_DISABLED', 403, 'Cross-account machine access is disabled.'),
  )
  await assert.rejects(
    harness.service.grantMachineAccess('missing-token', { machineId: 'machine-1', granteeAccountId: 'acct-b' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
  await assert.rejects(
    harness.service.revokeMachineAccess('missing-token', { machineId: 'machine-1', granteeAccountId: 'acct-b' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
})
