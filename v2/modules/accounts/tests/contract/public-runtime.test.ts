import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AccountsError,
  createAccountsRuntime,
  createFileAccountAuthorizationStore,
} from '../../src/public/index.mjs'

interface RelayAccount {
  id: string
  username: string
  password: string
}

interface RelayMachine {
  machineId: string
  ownerAccountId: string
  legacyDeviceId: string
  displayName: string
  status: 'active' | 'revoked'
  createdAt: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createRelay(
  accounts: RelayAccount[],
  initialMachines: RelayMachine[] = [],
) {
  const sessions = new Map<string, string>()
  const revoked = new Set<string>()
  const machines = [...initialMachines]
  const calls: string[] = []
  let sequence = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        username?: unknown
        password?: unknown
      }
      const account = accounts.find(
        (candidate) =>
          candidate.username === body.username &&
          candidate.password === body.password,
      )
      if (!account) return json({ error: 'invalid_credentials' }, 401)
      const token = `relay-token-${++sequence}`
      sessions.set(token, account.id)
      return json({
        accessToken: token,
        user: { id: account.id, username: account.username },
      }, 200)
    }

    const rawAuthorization =
      headers.authorization ?? headers.Authorization ?? ''
    const token = rawAuthorization.toLowerCase().startsWith('bearer ')
      ? rawAuthorization.slice(7)
      : ''
    const accountId = sessions.get(token)
    if (!accountId || revoked.has(token)) {
      return json({ error: 'unauthorized' }, 401)
    }
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account) return json({ error: 'unauthorized' }, 401)
    if (url.pathname === '/api/auth/me' && method === 'GET') {
      return json({
        user: { id: account.id, username: account.username },
      }, 200)
    }
    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      revoked.add(token)
      return json({ ok: true }, 200)
    }
    if (url.pathname === '/api/directory' && method === 'GET') {
      return json({
        ok: true,
        user: { id: account.id, username: account.username },
        directory: {
          schemaVersion: 1,
          user: { id: account.id, username: account.username },
          devices: [],
          updatedAt: '2026-11-07T00:00:00.000Z',
        },
      }, 200)
    }
    if (url.pathname === '/api/machines' && method === 'GET') {
      return json({
        ok: true,
        user: { id: account.id, username: account.username },
        machines: machines
          .filter((machine) => machine.ownerAccountId === account.id)
          .map((machine) => ({
            machineId: machine.machineId,
            ownerAccountId: machine.ownerAccountId,
            deviceId: machine.legacyDeviceId,
            displayName: machine.displayName,
            status: machine.status,
            createdAt: machine.createdAt,
          })),
      }, 200)
    }
    return json({ error: 'not_found' }, 404)
  }
  return { fetchImpl, calls, machines }
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'zterm-accounts-runtime-'))
}

function createRuntime(
  relay: ReturnType<typeof createRelay>,
  storeFile: string,
) {
  return createAccountsRuntime({
    relayBaseUrl: 'http://relay.test',
    authorizationStoreFile: storeFile,
    fetchImpl: relay.fetchImpl,
  })
}

async function seedAdmin(
  storeFile: string,
  accountId: string,
  scopes: readonly string[] = ['org:read', 'org:write'],
) {
  await createFileAccountAuthorizationStore(storeFile).putGrant({
    accountId,
    scopes,
    allWorkspaces: true,
    workspaceIds: [],
    machineIds: [],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:00.000Z',
  })
}

function relayMachine(
  ownerAccountId: string,
  machineId: string,
  status: 'active' | 'revoked' = 'active',
): RelayMachine {
  return {
    machineId,
    ownerAccountId,
    legacyDeviceId: `legacy-${machineId}`,
    displayName: machineId,
    status,
    createdAt: '2026-11-07T00:00:00.000Z',
  }
}

function expectError(
  code: AccountsError['code'],
  status: AccountsError['status'],
) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AccountsError, 'expected AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  }
}

test('public runtime delegates login to HTTP relay and rejects bad or unknown credentials without policy side effects', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relay = createRelay([
    { id: 'acct-alice', username: 'alice', password: 'secret-a' },
  ])
  const runtime = createRuntime(relay, join(root, 'authorization.json'))

  const login = await runtime.login({
    loginName: ' alice ',
    credential: 'secret-a',
  })
  assert.equal(login.accountId, 'acct-alice')
  assert.equal(login.loginName, 'alice')
  assert.match(login.token, /^relay-token-/)

  await assert.rejects(
    runtime.login({ loginName: 'alice', credential: 'wrong' }),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
  await assert.rejects(
    runtime.login({ loginName: 'unknown', credential: 'secret-a' }),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
  assert.deepEqual(relay.calls, [
    'POST /api/auth/login',
    'POST /api/auth/login',
    'POST /api/auth/login',
  ])
  assert.throws(
    () => readFileSync(join(root, 'authorization.json'), 'utf8'),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT',
  )
})

test('grant persists exact workspace and machine scope and verifies only that pair', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relay = createRelay([
    { id: 'acct-admin', username: 'admin', password: 'admin-secret' },
  ], [relayMachine('acct-admin', 'mach-a')])
  const storeFile = join(root, 'authorization.json')
  await seedAdmin(storeFile, 'acct-admin')
  const runtime = createRuntime(relay, storeFile)
  const admin = await runtime.login({
    loginName: 'admin',
    credential: 'admin-secret',
  })
  const granted = await runtime.grant({
    token: admin.token,
    accountId: admin.accountId,
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: ['mach-a'],
  })
  assert.equal(granted.accountId, admin.accountId)
  assert.equal(granted.authorizationGeneration, 2)
  assert.deepEqual(granted.workspaceIds, ['ws-a'])
  assert.deepEqual(granted.machineIds, ['mach-a'])

  const authority = await runtime.verifyAuthority({
    token: admin.token,
    workspaceId: 'ws-a',
    machineId: 'mach-a',
  })
  assert.deepEqual(authority, {
    accountId: admin.accountId,
    workspaceId: 'ws-a',
    machineId: 'mach-a',
    scopes: ['org:read'],
    authorizationGeneration: 2,
    bindingGeneration: 2,
  })

  await assert.rejects(
    runtime.verifyAuthority({
      token: admin.token,
      workspaceId: 'ws-b',
      machineId: 'mach-a',
    }),
    expectError('WORKSPACE_FORBIDDEN', 403),
  )
  await assert.rejects(
    runtime.verifyAuthority({
      token: admin.token,
      workspaceId: 'ws-a',
      machineId: 'mach-b',
    }),
    expectError('MACHINE_NOT_OWNED', 403),
  )
  await assert.rejects(
    runtime.verifyAuthority({
      token: admin.token,
      workspaceId: 'ws-a',
      machineId: 'mach-a',
      expectedGeneration: 0,
    }),
    expectError('AUTHORIZATION_GENERATION_STALE', 409),
  )

  const reopened = createRuntime(
    createRelay([
      { id: 'acct-admin', username: 'admin', password: 'admin-secret' },
    ], [relayMachine('acct-admin', 'mach-a')]),
    storeFile,
  )
  const adminAfterRestart = await reopened.login({
    loginName: 'admin',
    credential: 'admin-secret',
  })
  assert.equal(
    (await reopened.verifyAuthority({
      token: adminAfterRestart.token,
      workspaceId: 'ws-a',
      machineId: 'mach-a',
    })).authorizationGeneration,
    2,
  )
  const persisted = readFileSync(storeFile, 'utf8')
  assert.equal(persisted.includes('admin-secret'), false)
  assert.equal(persisted.includes('relay-token-'), false)
})

test('grant rejects unverified targets and leaves the policy store unchanged', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relay = createRelay([
    { id: 'acct-admin', username: 'admin', password: 'admin-secret' },
    { id: 'acct-bob', username: 'bob', password: 'bob-secret' },
  ], [
    relayMachine('acct-admin', 'mach-admin'),
    relayMachine('acct-admin', 'mach-revoked', 'revoked'),
    relayMachine('acct-bob', 'mach-bob'),
  ])
  const storeFile = join(root, 'authorization.json')
  await seedAdmin(storeFile, 'acct-admin')
  const store = createFileAccountAuthorizationStore(storeFile)
  const runtime = createRuntime(relay, storeFile)
  const admin = await runtime.login({
    loginName: 'admin',
    credential: 'admin-secret',
  })
  const before = await store.getGrant('acct-admin')
  assert.ok(before)

  await assert.rejects(
    runtime.grant({
      token: admin.token,
      accountId: 'acct-unknown',
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach-admin'],
    }),
    expectError('UNSUPPORTED', 501),
  )
  await assert.rejects(
    runtime.grant({
      token: admin.token,
      accountId: admin.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach-missing'],
    }),
    expectError('MACHINE_NOT_FOUND', 404),
  )
  await assert.rejects(
    runtime.grant({
      token: admin.token,
      accountId: admin.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach-bob'],
    }),
    expectError('MACHINE_NOT_FOUND', 404),
  )
  await assert.rejects(
    runtime.grant({
      token: admin.token,
      accountId: admin.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach-revoked'],
    }),
    expectError('MACHINE_REVOKED', 403),
  )

  const after = await store.getGrant('acct-admin')
  assert.equal(after?.authorizationGeneration, before.authorizationGeneration)
  assert.deepEqual(after?.workspaceIds, before.workspaceIds)
  assert.deepEqual(after?.machineIds, before.machineIds)
  assert.equal(await store.getGrant('acct-unknown'), undefined)
})

test('revoke invalidates the existing grant and generation, and regrant advances the generation', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relay = createRelay([
    { id: 'acct-admin', username: 'admin', password: 'admin-secret' },
    { id: 'acct-alice', username: 'alice', password: 'alice-secret' },
  ])
  const storeFile = join(root, 'authorization.json')
  const store = createFileAccountAuthorizationStore(storeFile)
  await seedAdmin(storeFile, 'acct-admin', ['org:write'])
  const first = await store.putGrant({
    accountId: 'acct-alice',
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: ['mach-a'],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:00.000Z',
  })
  const runtime = createRuntime(relay, storeFile)
  const admin = await runtime.login({
    loginName: 'admin',
    credential: 'admin-secret',
  })
  const alice = await runtime.login({
    loginName: 'alice',
    credential: 'alice-secret',
  })
  await runtime.verifyAuthority({
    token: alice.token,
    workspaceId: 'ws-a',
    machineId: 'mach-a',
    expectedGeneration: first.authorizationGeneration,
  })

  const revoked = await runtime.revoke({
    token: admin.token,
    accountId: alice.accountId,
    expectedGeneration: first.authorizationGeneration,
  })
  assert.equal(revoked.accountId, alice.accountId)
  assert.equal(revoked.revokedGeneration, first.authorizationGeneration)
  await assert.rejects(
    runtime.verifyAuthority({
      token: alice.token,
      workspaceId: 'ws-a',
      machineId: 'mach-a',
      expectedGeneration: first.authorizationGeneration,
    }),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )

  const second = await store.putGrant({
    accountId: alice.accountId,
    scopes: ['org:read'],
    allWorkspaces: false,
    workspaceIds: ['ws-a'],
    machineIds: ['mach-a'],
    memberIds: [],
    updatedAt: '2026-11-07T00:00:01.000Z',
  })
  assert.ok(second.authorizationGeneration > first.authorizationGeneration)
  await assert.rejects(
    runtime.verifyAuthority({
      token: alice.token,
      workspaceId: 'ws-a',
      machineId: 'mach-a',
      expectedGeneration: first.authorizationGeneration,
    }),
    expectError('AUTHORIZATION_GENERATION_STALE', 409),
  )
  assert.equal(
    (await runtime.verifyAuthority({
      token: alice.token,
      workspaceId: 'ws-a',
      machineId: 'mach-a',
      expectedGeneration: second.authorizationGeneration,
    })).bindingGeneration,
    second.authorizationGeneration,
  )
})

test('grant and revoke require a currently verified management grant', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relay = createRelay([
    { id: 'acct-alice', username: 'alice', password: 'alice-secret' },
    { id: 'acct-bob', username: 'bob', password: 'bob-secret' },
  ])
  const runtime = createRuntime(relay, join(root, 'authorization.json'))
  const alice = await runtime.login({
    loginName: 'alice',
    credential: 'alice-secret',
  })
  const bob = await runtime.login({
    loginName: 'bob',
    credential: 'bob-secret',
  })
  await assert.rejects(
    runtime.grant({
      token: alice.token,
      accountId: bob.accountId,
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-a'],
      machineIds: ['mach-a'],
    }),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )
  await assert.rejects(
    runtime.revoke({
      token: alice.token,
      accountId: bob.accountId,
    }),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )
})
