import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import {
  AccountsError,
  AuthService,
  MachineService,
  V1RelayAdapter,
  createAccountsAuthorizationPort,
  createFileAccountAuthorizationStore,
  createWorkspaceAuthorization,
} from '../../src/public/contracts.ts'
import { createAccountsRuntime } from '../../src/public/index.mjs'
import type {
  AccountAuthorizationGrant,
  MachineAuthorizationRoute,
  MachineRouteSource,
} from '../../src/public/contracts.ts'
import { startRelay, stopRelay, type RelayServer } from './relay-harness.ts'

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
})

after(async () => {
  await stopRelay(relay)
}, { timeout: 10_000 })

test('real V1 relay proves enrollment, possession, owner revoke, and logout', async () => {
  assert.ok(relay, 'real relay is unavailable')
  const alice = await createAccount(relay.baseUrl, 'alice')
  const bob = await createAccount(relay.baseUrl, 'bob')

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

test('real V1 relay drives workspace and machine authorization adapters end to end', async () => {
  assert.ok(relay, 'real relay is unavailable')
  const alice = await createAccount(relay.baseUrl, 'authz-alice')
  const bob = await createAccount(relay.baseUrl, 'authz-bob')

  const enrolled = await alice.machines.enrollMachine(alice.token, {
    deviceId: 'alice-authz-laptop',
    deviceToken: 'alice-authz-device-proof',
    displayName: 'Alice Authz Laptop',
  })
  const machineId = enrolled.machineId
  assert.match(machineId, /^mach_/)

  const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-v2-accounts-authz-'))
  try {
    const store = createFileAccountAuthorizationStore(join(tempRoot, 'authorization.json'))
    const grant: AccountAuthorizationGrant = {
      accountId: alice.accountId,
      scopes: ['org:read', 'org:write'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      memberIds: ['mbr-a'],
      updatedAt: '2026-11-07T00:00:00.000Z',
    }
    await store.putGrant(grant)
    const workspaceAuthz = createWorkspaceAuthorization({ authService: alice.auth, store })

    const context = await workspaceAuthz.verify(alice.token)
    assert.equal(context.accountId, alice.accountId)
    assert.deepEqual(context.workspaces, ['ws-a'])
    assert.deepEqual(context.members, ['mbr-a'])

    await expectError(
      workspaceAuthz.verify(bob.token),
      'WORKSPACE_AUTHORIZATION_REQUIRED',
      403,
    )

    const canonicalRoute: MachineAuthorizationRoute = {
      machineId,
      daemonHostId: 'daemon-alice',
      capabilities: { transportKind: 'websocket', channelKinds: ['terminal'] },
      target: {
        bridgeHost: '127.0.0.1',
        bridgePort: 47821,
        daemonHostId: 'daemon-alice',
        transportMode: 'websocket',
      },
      settings: { transportMode: 'websocket' },
    }
    const routes: MachineRouteSource = {
      async get(requested) {
        return requested === machineId ? canonicalRoute : undefined
      },
    }
    const alicePort = createAccountsAuthorizationPort({
      token: alice.token,
      authService: alice.auth,
      machineService: alice.machines,
      routes,
    })

    const link = await alicePort.authorizeMachine(machineId)
    assert.equal(link.machineId, machineId)
    assert.equal(link.accountId, alice.accountId)
    assert.equal(link.daemonHostId, 'daemon-alice')
    assert.match(link.authorizationId, /^authz_/)
    assert.notEqual(link.authorizationId, alice.token)

    await expectError(alicePort.authorizeMachine('mach_missing'), 'MACHINE_NOT_FOUND', 404)

    const bobPort = createAccountsAuthorizationPort({
      token: bob.token,
      authService: bob.auth,
      machineService: bob.machines,
      routes,
    })
    await expectError(bobPort.authorizeMachine(machineId), 'MACHINE_NOT_FOUND', 404)

    const noProofPort = createAccountsAuthorizationPort({
      token: alice.token,
      authService: alice.auth,
      machineService: alice.machines,
      routes: {
        async get() {
          return {
            machineId,
            daemonHostId: '',
            capabilities: { transportKind: 'websocket', channelKinds: ['terminal'] },
            target: { bridgeHost: '127.0.0.1', bridgePort: 47822, transportMode: 'websocket' },
            settings: { transportMode: 'websocket' },
          }
        },
      },
    })
    await expectError(
      noProofPort.authorizeMachine(machineId),
      'MACHINE_IDENTITY_UNVERIFIED',
      403,
    )

    await alice.machines.revokeMachine(alice.token, { machineId })
    await expectError(
      alicePort.authorizeMachine(machineId),
      'MACHINE_REVOKED',
      403,
    )

    await alice.auth.logout(alice.token)
    await expectError(
      workspaceAuthz.verify(alice.token),
      'AUTHENTICATION_REQUIRED',
      401,
    )
    await expectError(
      alicePort.authorizeMachine(machineId),
      'AUTHENTICATION_REQUIRED',
      401,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('real V1 relay verifies grant targets and exposes the cross-account lookup gap', async (t) => {
  assert.ok(relay, 'real relay is unavailable')
  const storeRoot = mkdtempSync(join(tmpdir(), 'zterm-accounts-runtime-real-'))
  t.after(() => rmSync(storeRoot, { recursive: true, force: true }))
  const storeFile = join(storeRoot, 'authorization.json')

  const admin = await createAccount(relay.baseUrl, 'public-admin')
  const alice = await createAccount(relay.baseUrl, 'public-alice')
  const bob = await createAccount(relay.baseUrl, 'public-bob')

  const adminMachine = await admin.machines.enrollMachine(admin.token, {
    deviceId: 'public-admin-machine',
    deviceToken: 'public-admin-proof',
  })
  const aliceMachine = await alice.machines.enrollMachine(alice.token, {
    deviceId: 'public-alice-machine',
    deviceToken: 'public-alice-proof',
  })
  const bobMachine = await bob.machines.enrollMachine(bob.token, {
    deviceId: 'public-bob-machine',
    deviceToken: 'public-bob-proof',
  })

  const store = createFileAccountAuthorizationStore(storeFile)
  await store.putGrant({
    accountId: admin.accountId,
    scopes: ['org:read', 'org:write'],
    allWorkspaces: true,
    workspaceIds: [],
    machineIds: [],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:00.000Z',
  })
  const aliceInitial = await store.putGrant({
    accountId: alice.accountId,
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: [aliceMachine.machineId],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:00.000Z',
  })

  const runtime = createAccountsRuntime({
    relayBaseUrl: relay.baseUrl,
    authorizationStoreFile: storeFile,
  })
  const adminLogin = await runtime.login(admin.identity)
  const aliceLogin = await runtime.login(alice.identity)

  await expectError(
    runtime.login({ loginName: admin.identity.loginName, credential: 'wrong' }),
    'AUTHENTICATION_REQUIRED',
    401,
  )
  await expectError(
    runtime.grant({
      token: alice.token,
      accountId: alice.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: [aliceMachine.machineId],
    }),
    'WORKSPACE_AUTHORIZATION_REQUIRED',
    403,
  )

  const adminGrantBefore = await store.getGrant(admin.accountId)
  const aliceGrantBefore = await store.getGrant(alice.accountId)
  assert.ok(adminGrantBefore)
  assert.ok(aliceGrantBefore)

  await expectError(
    runtime.grant({
      token: adminLogin.token,
      accountId: 'acct_missing',
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: [adminMachine.machineId],
    }),
    'UNSUPPORTED',
    501,
  )
  await expectError(
    runtime.grant({
      token: adminLogin.token,
      accountId: adminLogin.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach_missing'],
    }),
    'MACHINE_NOT_FOUND',
    404,
  )
  await expectError(
    runtime.grant({
      token: adminLogin.token,
      accountId: adminLogin.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: [bobMachine.machineId],
    }),
    'MACHINE_NOT_FOUND',
    404,
  )

  assert.equal(
    (await store.getGrant(admin.accountId))?.authorizationGeneration,
    adminGrantBefore.authorizationGeneration,
  )
  assert.equal(
    (await store.getGrant(alice.accountId))?.authorizationGeneration,
    aliceGrantBefore.authorizationGeneration,
  )
  assert.equal(await store.getGrant('acct_missing'), undefined)

  const revoked = await runtime.revoke({
    token: adminLogin.token,
    accountId: aliceLogin.accountId,
    expectedGeneration: aliceInitial.authorizationGeneration,
  })
  assert.equal(revoked.revokedGeneration, aliceInitial.authorizationGeneration)
  await expectError(
    runtime.verifyAuthority({
      token: aliceLogin.token,
      workspaceId: 'ws-a',
      machineId: aliceMachine.machineId,
      expectedGeneration: aliceInitial.authorizationGeneration,
    }),
    'WORKSPACE_AUTHORIZATION_REQUIRED',
    403,
  )

  const aliceReplacement = await store.putGrant({
    accountId: alice.accountId,
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: [aliceMachine.machineId],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:01.000Z',
  })
  assert.ok(
    aliceReplacement.authorizationGeneration
      > aliceInitial.authorizationGeneration,
  )
  await expectError(
    runtime.verifyAuthority({
      token: aliceLogin.token,
      workspaceId: 'ws-a',
      machineId: aliceMachine.machineId,
      expectedGeneration: aliceInitial.authorizationGeneration,
    }),
    'AUTHORIZATION_GENERATION_STALE',
    409,
  )

  const selfGrant = await runtime.grant({
    token: adminLogin.token,
    accountId: adminLogin.accountId,
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: [adminMachine.machineId],
  })
  assert.equal(selfGrant.accountId, admin.accountId)
  assert.equal(
    selfGrant.authorizationGeneration,
    adminGrantBefore.authorizationGeneration + 1,
  )

  const authority = await runtime.verifyAuthority({
    token: adminLogin.token,
    workspaceId: 'ws-a',
    machineId: adminMachine.machineId,
    expectedGeneration: selfGrant.bindingGeneration,
  })
  assert.equal(authority.accountId, admin.accountId)
  assert.equal(authority.bindingGeneration, selfGrant.bindingGeneration)
  await expectError(
    runtime.verifyAuthority({
      token: adminLogin.token,
      workspaceId: 'ws-b',
      machineId: adminMachine.machineId,
    }),
    'WORKSPACE_FORBIDDEN',
    403,
  )
  await expectError(
    runtime.verifyAuthority({
      token: adminLogin.token,
      workspaceId: 'ws-a',
      machineId: bobMachine.machineId,
    }),
    'MACHINE_NOT_OWNED',
    403,
  )
})

test('public Accounts consumer keeps relay authority across two canonical machines and rejected operations', async (t) => {
  assert.ok(relay, 'real relay is unavailable')
  const root = mkdtempSync(join(tmpdir(), 'zterm-accounts-matrix-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false)
    console.log(`Accounts policy cleanup: ${root} removed`)
  })
  const storeFile = join(root, 'authorization.json')
  const store = createFileAccountAuthorizationStore(storeFile)
  const flow = createFlow(relay.baseUrl)
  const identity = uniqueIdentity('matrix-owner')
  const registered = await flow.auth.register(identity)
  assert.deepEqual(Object.keys(registered).sort(), ['accountId', 'loginName'])
  assert.equal(existsSync(storeFile), false, 'registration must not create local policy')
  const sessionA = await flow.auth.login(identity)
  const sessionB = await flow.auth.login(identity)
  assert.notEqual(sessionA.token, sessionB.token)
  assert.equal((await flow.auth.verifySession(sessionA.token)).accountId, registered.accountId)
  assert.equal((await flow.auth.verifySession(sessionB.token)).accountId, registered.accountId)
  assert.equal(existsSync(storeFile), false, 'login/revalidation must not create local policy')
  const foreign = await createAccount(relay.baseUrl, 'matrix-foreign')
  const machineA = await flow.machines.enrollMachine(sessionA.token, {
    deviceId: 'matrix-host-a', deviceToken: 'matrix-proof-a', displayName: 'Matrix A',
  })
  const machineB = await flow.machines.enrollMachine(sessionB.token, {
    deviceId: 'matrix-host-b', deviceToken: 'matrix-proof-b', displayName: 'Matrix B',
  })
  assert.notEqual(machineA.machineId, machineB.machineId)
  for (const machine of [machineA, machineB]) {
    assert.match(machine.machineId, /^mach_/)
    assert.notEqual(machine.machineId, machine.legacyDeviceId)
    assert.equal(machine.ownerAccountId, registered.accountId)
  }
  const list = () => flow.machines.listAuthorizedMachines(sessionB.token)
  assert.deepEqual(
    (await list()).map((machine) => machine.machineId).sort(),
    [machineA.machineId, machineB.machineId].sort(),
  )
  assert.deepEqual(await foreign.machines.listAuthorizedMachines(foreign.token), [])
  const beforeRepeat = await list()
  assert.equal((await flow.machines.enrollMachine(sessionA.token, {
    deviceId: 'matrix-host-a', deviceToken: 'matrix-proof-a',
  })).machineId, machineA.machineId)
  assert.deepEqual(await list(), beforeRepeat, 'repeat enrollment must not add or rewrite a machine')
  for (const [machine, deviceToken] of [[machineA, 'matrix-proof-a'], [machineB, 'matrix-proof-b']] as const) {
    const proof = await flow.machines.verifyMachinePossession(sessionB.token, {
      machineId: machine.machineId, deviceToken,
    })
    assert.equal(proof.machineId, machine.machineId)
    assert.equal(proof.ownerAccountId, registered.accountId)
  }
  await store.putGrant({
    accountId: registered.accountId, scopes: ['org:read', 'org:write'],
    allWorkspaces: true, workspaceIds: [],
    machineIds: [machineA.machineId, machineB.machineId, 'mach_missing'],
    memberIds: [], updatedAt: '2026-11-27T00:00:00.000Z',
  })
  const runtime = createAccountsRuntime({
    relayBaseUrl: relay.baseUrl, authorizationStoreFile: storeFile,
  })
  const authorityInput = (machineId: string) => ({
    token: sessionB.token, workspaceId: 'matrix-workspace', machineId,
  })
  for (const machine of [machineA, machineB]) {
    assert.equal((await runtime.verifyAuthority(authorityInput(machine.machineId))).machineId, machine.machineId)
  }
  const route: MachineAuthorizationRoute = {
    machineId: machineB.machineId, daemonHostId: 'matrix-daemon-b',
    capabilities: { transportKind: 'websocket', channelKinds: ['terminal'] },
    target: { bridgeHost: '127.0.0.1', bridgePort: 47821, daemonHostId: 'matrix-daemon-b' },
    settings: { transportMode: 'websocket' },
  }
  const port = createAccountsAuthorizationPort({
    token: sessionB.token, authService: flow.auth, machineService: flow.machines,
    routes: { async get() { return route } },
  })
  assert.equal((await port.authorizeMachine(machineB.machineId)).machineId, machineB.machineId)
  assert.equal((await port.authorizeCallerMachine(machineB.machineId, sessionA.token)).accountId, registered.accountId)

  async function rejectUnchanged(
    label: string, operation: () => Promise<unknown>,
    code: AccountsError['code'], status: AccountsError['status'], upstreamCode?: string,
  ) {
    const policyBefore = readFileSync(storeFile, 'utf8')
    const machinesBefore = await list()
    const foreignBefore = await foreign.machines.listAuthorizedMachines(foreign.token)
    await expectError(operation(), code, status, upstreamCode)
    assert.equal(readFileSync(storeFile, 'utf8'), policyBefore, `${label}: policy unchanged`)
    assert.deepEqual(await list(), machinesBefore, `${label}: canonical machines unchanged`)
    assert.deepEqual(await foreign.machines.listAuthorizedMachines(foreign.token), foreignBefore, `${label}: foreign directory unchanged`)
    console.log(`public matrix PASS: ${label}; ${code}/${status}; policy and canonical directories unchanged`)
  }

  await rejectUnchanged('wrong credential', () => runtime.login({ ...identity, credential: 'wrong' }), 'AUTHENTICATION_REQUIRED', 401)
  await rejectUnchanged('invalid session', () => flow.machines.listAuthorizedMachines('invalid-token'), 'AUTHENTICATION_REQUIRED', 401)
  await rejectUnchanged('device identity conflict', () => flow.machines.enrollMachine(sessionA.token, {
    deviceId: 'matrix-host-a', deviceToken: 'different-proof',
  }), 'MACHINE_DEVICE_CONFLICT', 409, 'machine_device_conflict')
  await rejectUnchanged('foreign proof enrollment', () => foreign.machines.enrollMachine(foreign.token, {
    deviceId: 'matrix-foreign-device', deviceToken: 'matrix-proof-a',
  }), 'MACHINE_ALREADY_OWNED', 409, 'machine_already_owned')
  await rejectUnchanged('invalid possession', () => flow.machines.verifyMachinePossession(sessionA.token, {
    machineId: machineB.machineId, deviceToken: 'wrong-proof',
  }), 'POSSESSION_INVALID', 403, 'possession_invalid')
  await rejectUnchanged('non-owner revoke', () => foreign.machines.revokeMachine(foreign.token, {
    machineId: machineB.machineId,
  }), 'MACHINE_NOT_OWNED', 403, 'machine_not_owned')
  assert.equal((await flow.machines.verifyMachinePossession(sessionA.token, {
    machineId: machineB.machineId, deviceToken: 'matrix-proof-b',
  })).machineId, machineB.machineId)
  await rejectUnchanged('missing target retained in grant', () => runtime.verifyAuthority(authorityInput('mach_missing')), 'MACHINE_NOT_FOUND', 404)
  const wrongIdentityPort = createAccountsAuthorizationPort({
    token: sessionA.token, authService: flow.auth, machineService: flow.machines,
    routes: { async get() { return { ...route, target: { ...route.target, daemonHostId: 'other-daemon' } } } },
  })
  await rejectUnchanged('wrong daemon identity', () => wrongIdentityPort.authorizeMachine(machineB.machineId), 'MACHINE_IDENTITY_UNVERIFIED', 403)
  await rejectUnchanged('cross-account sharing grant', () => flow.machines.grantMachineAccess(sessionA.token, {
    machineId: machineB.machineId, granteeAccountId: foreign.accountId,
  }), 'CROSS_ACCOUNT_ACCESS_DISABLED', 403)
  await rejectUnchanged('cross-account sharing revoke', () => flow.machines.revokeMachineAccess(sessionA.token, {
    machineId: machineB.machineId, granteeAccountId: foreign.accountId,
  }), 'CROSS_ACCOUNT_ACCESS_DISABLED', 403)
  await rejectUnchanged('foreign-account runtime grant', () => runtime.grant({
    token: sessionA.token, accountId: foreign.accountId, scopes: ['org:read'],
    allWorkspaces: false, workspaceIds: ['matrix-workspace'], machineIds: [machineB.machineId],
  }), 'UNSUPPORTED', 501)

  const policyBeforeRevocation = readFileSync(storeFile, 'utf8')
  assert.equal((await flow.machines.revokeMachine(sessionA.token, { machineId: machineB.machineId })).status, 'revoked')
  assert.equal(readFileSync(storeFile, 'utf8'), policyBeforeRevocation, 'relay revoke must leave the local grant intact')
  const machinesAfterRevocation = await list()
  assert.equal(machinesAfterRevocation.find((machine) => machine.machineId === machineB.machineId)?.status, 'revoked')
  assert.equal(machinesAfterRevocation.find((machine) => machine.machineId === machineA.machineId)?.status, 'active')
  await rejectUnchanged('revoked possession', () => flow.machines.verifyMachinePossession(sessionA.token, {
    machineId: machineB.machineId, deviceToken: 'matrix-proof-b',
  }), 'MACHINE_REVOKED', 403, 'machine_revoked')
  await rejectUnchanged('revoked target with retained local grant', () => runtime.verifyAuthority(authorityInput(machineB.machineId)), 'MACHINE_REVOKED', 403)
  await rejectUnchanged('revoked service admission', () => port.authorizeMachine(machineB.machineId), 'MACHINE_REVOKED', 403)
  await rejectUnchanged('revoked caller admission', () => port.authorizeCallerMachine(machineB.machineId, sessionA.token), 'MACHINE_REVOKED', 403)
  assert.equal((await runtime.verifyAuthority(authorityInput(machineA.machineId))).machineId, machineA.machineId)
  assert.equal((await flow.machines.verifyMachinePossession(sessionB.token, {
    machineId: machineA.machineId, deviceToken: 'matrix-proof-a',
  })).status, 'active')
  await flow.auth.logout(sessionA.token)
  await rejectUnchanged('logged-out session revalidation', () => flow.auth.verifySession(sessionA.token), 'AUTHENTICATION_REQUIRED', 401)
  await rejectUnchanged('logged-out runtime authority', () => runtime.verifyAuthority({
    ...authorityInput(machineA.machineId), token: sessionA.token,
  }), 'AUTHENTICATION_REQUIRED', 401)
  assert.equal((await flow.auth.verifySession(sessionB.token)).accountId, registered.accountId)
  assert.equal((await runtime.verifyAuthority(authorityInput(machineA.machineId))).machineId, machineA.machineId)
  console.log('public matrix PASS: register/login/revalidate, two distinct canonical IDs, possession, owner revoke, independent session and active-machine survival')
})

test('public Accounts consumer preserves a relay transport failure after a successful authority query', async (t) => {
  const isolated = await startRelay()
  let activeRelay: RelayServer | null = isolated
  t.after(async () => {
    if (activeRelay) await stopRelay(activeRelay)
  })
  const policyRoot = mkdtempSync(join(tmpdir(), 'zterm-accounts-relay-lost-'))
  t.after(() => {
    rmSync(policyRoot, { recursive: true, force: true })
    assert.equal(existsSync(policyRoot), false)
  })
  const storeFile = join(policyRoot, 'authorization.json')
  const store = createFileAccountAuthorizationStore(storeFile)
  const flow = createFlow(isolated.baseUrl)
  const identity = uniqueIdentity('relay-lost')
  const registered = await flow.auth.register(identity)
  const session = await flow.auth.login(identity)
  const machine = await flow.machines.enrollMachine(session.token, {
    deviceId: 'relay-lost-host', deviceToken: 'relay-lost-proof', displayName: 'Relay Lost',
  })
  const grant = await store.putGrant({
    accountId: registered.accountId, scopes: ['org:read'], allWorkspaces: false,
    workspaceIds: ['relay-lost-workspace'], machineIds: [machine.machineId],
    memberIds: [], updatedAt: '2026-11-27T00:00:00.000Z',
  })
  const runtime = createAccountsRuntime({
    relayBaseUrl: isolated.baseUrl, authorizationStoreFile: storeFile,
  })
  const query = {
    token: session.token, workspaceId: 'relay-lost-workspace', machineId: machine.machineId,
  }
  assert.equal((await runtime.verifyAuthority(query)).machineId, machine.machineId)
  const policyBefore = readFileSync(storeFile, 'utf8')
  await stopRelay(isolated)
  activeRelay = null
  const failure = await expectError(
    runtime.verifyAuthority(query),
    'RELAY_TRANSPORT_ERROR',
    503,
  )
  assert.equal(typeof failure.details?.cause, 'string')
  assert.ok(String(failure.details?.cause).length > 0, 'transport cause must be preserved')
  assert.ok(failure.cause instanceof Error, 'typed relay failure must retain its Error cause')
  assert.equal(readFileSync(storeFile, 'utf8'), policyBefore, 'unreachable relay must leave policy unchanged')
  const retained = await store.getGrant(registered.accountId)
  assert.equal(retained?.authorizationGeneration, grant.authorizationGeneration)
  assert.deepEqual(retained?.machineIds, [machine.machineId])
  console.log('public relay-unavailable PASS: typed transport cause; no authority value; policy unchanged')
})
