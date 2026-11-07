import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AccountsError,
  AuthService,
  MachineService,
  createAccountsAuthorizationPort,
  createFileAccountAuthorizationStore,
  createWorkspaceAuthorization,
} from '../../src/public/contracts.ts'
import type {
  AccountAuthorizationGrant,
  AuthContext,
  MachineRegistrationPort,
  MachineSummary,
  RelayAuthPort,
  RelayAuthSession,
} from '../../src/public/contracts.ts'

const NOW = Date.UTC(2026, 10, 7, 0, 0, 0)
const UPDATED_AT = '2026-11-07T00:00:00.000Z'

function session(accountId: string, loginName: string, token: string): RelayAuthSession {
  return { accessToken: token, accountId, loginName }
}

function createAuthority(sessions: readonly RelayAuthSession[]) {
  const active = new Map(sessions.map((record) => [record.accessToken, record]))
  return {
    async register(): Promise<never> {
      throw new Error('register is not used by authorization contract tests')
    },
    async authenticate(): Promise<never> {
      throw new Error('authenticate is not used by authorization contract tests')
    },
    async validateSession(accessToken: string): Promise<RelayAuthSession> {
      const found = active.get(accessToken)
      if (!found) throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
      return found
    },
    async logout(accessToken: string): Promise<void> {
      active.delete(accessToken)
    },
  } satisfies RelayAuthPort
}

function createAuthService(sessions: readonly RelayAuthSession[]): AuthService {
  return new AuthService({
    authority: createAuthority(sessions),
    now: () => NOW,
    sessionTtlMs: 60_000,
  })
}

function grant(
  accountId: string,
  overrides: Partial<AccountAuthorizationGrant> = {},
): AccountAuthorizationGrant {
  return {
    accountId,
    scopes: ['org:read', 'org:write'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    memberIds: ['mbr-a'],
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'zterm-accounts-authorization-'))
  return {
    file: join(root, 'authorization.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function machine(machineId: string, ownerAccountId: string, status: 'active' | 'revoked'): MachineSummary {
  return {
    machineId,
    ownerAccountId,
    legacyDeviceId: `legacy-${machineId}`,
    displayName: machineId,
    status,
    createdAt: UPDATED_AT,
  }
}

function createMachineService(
  auth: AuthService,
  listByToken: Record<string, readonly MachineSummary[]>,
): MachineService {
  const machineReg = {
    async listMachines(accessToken: string) {
      return [...(listByToken[accessToken] ?? [])]
    },
    async enroll(): Promise<never> {
      throw new Error('enroll is not used by authorization contract tests')
    },
    async verifyPossession(): Promise<never> {
      throw new Error('verifyPossession is not used by authorization contract tests')
    },
    async revokeMachine(): Promise<never> {
      throw new Error('revokeMachine is not used by authorization contract tests')
    },
  } satisfies MachineRegistrationPort
  return new MachineService({
    machineReg,
    verifySession: (token) => auth.verifySession(token),
    now: () => NOW,
  })
}

function expectError(code: AccountsError['code'], status: AccountsError['status']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AccountsError, 'expected an AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  }
}

test('workspace authorization verifies an active session and persists explicit stable-ID grants', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(grant('acct-a'))

  const authorization = createWorkspaceAuthorization({ authService: auth, store })
  const context = await authorization.verify('token-a')
  assert.deepEqual(context, {
    accountId: 'acct-a',
    scopes: ['org:read', 'org:write'],
    workspaces: ['ws-a'],
    members: ['mbr-a'],
  })

  const reopened = createFileAccountAuthorizationStore(tmp.file)
  const replayed = createWorkspaceAuthorization({ authService: auth, store: reopened })
  assert.deepEqual(await replayed.verify('token-a'), context)
})

test('workspace authorization rejects logout, unknown sessions, and accounts without a grant', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([
    session('acct-a', 'alice', 'token-a'),
    session('acct-b', 'bob', 'token-b'),
  ])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(grant('acct-a'))
  const authorization = createWorkspaceAuthorization({ authService: auth, store })

  await auth.logout('token-a')
  await assert.rejects(
    authorization.verify('token-a'),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
  await assert.rejects(
    authorization.verify('unknown-token'),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
  await assert.rejects(
    authorization.verify('token-b'),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )
})

test('authorization store persists policy without session secrets and deletion revokes access', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-secret')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(grant('acct-a'))

  const persisted = readFileSync(tmp.file, 'utf8')
  assert.equal(persisted.includes('token-secret'), false)
  assert.equal(persisted.includes('credential'), false)

  await store.deleteGrant('acct-a')
  await assert.rejects(
    createWorkspaceAuthorization({ authService: auth, store }).verify('token-secret'),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )
})

test('workspace authorization preserves expired and revoked session rejection', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const base = createAuthority([])
  for (const [code, token] of [
    ['SESSION_EXPIRED', 'expired-token'],
    ['SESSION_REVOKED', 'revoked-token'],
  ] as const) {
    const auth = new AuthService({
      authority: {
        ...base,
        async validateSession() {
          throw new AccountsError(code, 401)
        },
      },
      now: () => NOW,
      sessionTtlMs: 60_000,
    })
    const authorization = createWorkspaceAuthorization({
      authService: auth,
      store: createFileAccountAuthorizationStore(tmp.file),
    })
    await assert.rejects(authorization.verify(token), expectError(code, 401))
  }
})

test('workspace binding records the created workspace only for an explicit all-workspaces org writer', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([
    session('acct-admin', 'admin', 'admin-token'),
    session('acct-ordinary', 'ordinary', 'ordinary-token'),
  ])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(grant('acct-admin', { allWorkspaces: true, workspaceIds: [] }))
  await store.putGrant(grant('acct-ordinary', { allWorkspaces: false, workspaceIds: ['ws-a'] }))
  const authorization = createWorkspaceAuthorization({ authService: auth, store })

  const bound = await authorization.bindCreatedWorkspace({
    token: 'admin-token',
    workspaceId: 'ws-created',
  })
  assert.deepEqual(bound.workspaces, '*')
  assert.deepEqual((await store.getGrant('acct-admin'))?.workspaceIds, ['ws-created'])

  await assert.rejects(
    authorization.bindCreatedWorkspace({
      token: 'ordinary-token',
      workspaceId: 'ws-denied',
    }),
    expectError('WORKSPACE_FORBIDDEN', 403),
  )
  assert.deepEqual((await store.getGrant('acct-ordinary'))?.workspaceIds, ['ws-a'])
})

test('machine authorization returns a canonical active link from typed route evidence', async () => {
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const machineService = createMachineService(auth, {
    'token-a': [
      machine('mach-a', 'acct-a', 'active'),
      machine('mach-revoked', 'acct-a', 'revoked'),
      machine('mach-no-proof', 'acct-a', 'active'),
    ],
  })
  const routes = {
    async get(machineId: string) {
      if (machineId === 'mach-a') {
        return {
          machineId: 'mach-a',
          daemonHostId: 'daemon-a',
          capabilities: { channelKinds: ['terminal'], transportKind: 'ws' },
          target: {
            bridgeHost: '127.0.0.1',
            bridgePort: 47001,
            daemonHostId: 'daemon-a',
            transportMode: 'websocket',
          },
          settings: { transportMode: 'websocket' },
        }
      }
      if (machineId === 'mach-no-proof') {
        return {
          machineId: 'mach-no-proof',
          daemonHostId: '',
          capabilities: { channelKinds: ['terminal'], transportKind: 'ws' },
          target: {
            bridgeHost: '127.0.0.1',
            bridgePort: 47002,
            authToken: 'server-secret-must-not-leak',
          },
          settings: { transportMode: 'websocket' },
        }
      }
      return undefined
    },
  }
  const port = createAccountsAuthorizationPort({
    token: 'token-a',
    authService: auth,
    machineService,
    routes,
  })

  const link = await port.authorizeMachine('mach-a')
  assert.equal(link.machineId, 'mach-a')
  assert.equal(link.daemonHostId, 'daemon-a')
  assert.equal(link.accountId, 'acct-a')
  assert.equal(link.capabilities.transportKind, 'ws')
  assert.equal(link.target.bridgePort, 47001)
  assert.notEqual(link.authorizationId, 'token-a')
})

test('machine authorization separates revoked, unknown, cross-account, and missing identity proof', async () => {
  const auth = createAuthService([
    session('acct-a', 'alice', 'token-a'),
    session('acct-b', 'bob', 'token-b'),
  ])
  const machineService = createMachineService(auth, {
    'token-a': [
      machine('mach-a', 'acct-a', 'active'),
      machine('mach-revoked', 'acct-a', 'revoked'),
      machine('mach-no-proof', 'acct-a', 'active'),
    ],
    'token-b': [machine('mach-b', 'acct-b', 'active')],
  })
  const routes = {
    async get(machineId: string) {
      if (machineId === 'mach-revoked' || machineId === 'mach-no-proof') {
        return {
          machineId,
          daemonHostId: '',
          capabilities: { channelKinds: ['terminal'], transportKind: 'ws' },
          target: { bridgeHost: '127.0.0.1', bridgePort: 47002, authToken: 'server-secret-must-not-leak' },
          settings: { transportMode: 'websocket' },
        }
      }
      if (machineId === 'mach-a') {
        return {
          machineId: 'mach-a',
          daemonHostId: 'daemon-a',
          capabilities: { channelKinds: ['terminal'], transportKind: 'ws' },
          target: { bridgeHost: '127.0.0.1', bridgePort: 47001, daemonHostId: 'daemon-other' },
          settings: { transportMode: 'websocket' },
        }
      }
      return undefined
    },
  }
  const a = createAccountsAuthorizationPort({
    token: 'token-a',
    authService: auth,
    machineService,
    routes,
  })
  const b = createAccountsAuthorizationPort({
    token: 'token-b',
    authService: auth,
    machineService,
    routes,
  })

  await assert.rejects(a.authorizeMachine('mach-revoked'), expectError('MACHINE_REVOKED', 403))
  await assert.rejects(a.authorizeMachine('mach-unknown'), expectError('MACHINE_NOT_FOUND', 404))
  await assert.rejects(b.authorizeMachine('mach-a'), expectError('MACHINE_NOT_FOUND', 404))
  await assert.rejects(a.authorizeMachine('mach-no-proof'), expectError('MACHINE_IDENTITY_UNVERIFIED', 403))
  await assert.rejects(a.authorizeMachine('mach-a'), expectError('MACHINE_IDENTITY_UNVERIFIED', 403))
})

test('machine authorization rejects a revoked caller and keeps connection material out of error details', async () => {
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const machineService = createMachineService(auth, {
    'token-a': [machine('mach-no-proof', 'acct-a', 'active')],
  })
  const routes = {
    async get() {
      return {
        machineId: 'mach-no-proof',
        daemonHostId: '',
        capabilities: { channelKinds: ['terminal'], transportKind: 'ws' },
        target: { bridgeHost: '127.0.0.1', bridgePort: 47002, authToken: 'server-secret-must-not-leak' },
        settings: { transportMode: 'websocket' },
      }
    },
  }
  const port = createAccountsAuthorizationPort({
    token: 'token-a',
    authService: auth,
    machineService,
    routes,
  })

  await assert.rejects(
    port.authorizeMachine('mach-no-proof'),
    (error: unknown) => {
      assert.ok(error instanceof AccountsError)
      assert.equal(error.code, 'MACHINE_IDENTITY_UNVERIFIED')
      assert.equal(JSON.stringify(error.details).includes('server-secret-must-not-leak'), false)
      return true
    },
  )

  await auth.logout('token-a')
  await assert.rejects(
    port.authorizeMachine('mach-no-proof'),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
})
