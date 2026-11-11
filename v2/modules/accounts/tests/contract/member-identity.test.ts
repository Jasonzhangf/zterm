import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AccountsError,
  AuthService,
  createFileAccountAuthorizationStore,
  createMemberIdentityService,
} from '../../src/public/contracts.ts'
import type {
  AccountAuthorizationGrant,
  AuthContext,
  RelayAuthPort,
  RelayAuthSession,
} from '../../src/public/contracts.ts'

const NOW = Date.UTC(2026, 10, 10, 0, 0, 0)
const UPDATED_AT = '2026-11-10T00:00:00.000Z'

function session(accountId: string, loginName: string, token: string): RelayAuthSession {
  return { accessToken: token, accountId, loginName }
}

function createAuthService(sessions: readonly RelayAuthSession[]): AuthService {
  const active = new Map(sessions.map((record) => [record.accessToken, record]))
  const authority: RelayAuthPort = {
    async register(): Promise<never> {
      throw new Error('register is not used by identity contract tests')
    },
    async authenticate(): Promise<never> {
      throw new Error('authenticate is not used by identity contract tests')
    },
    async validateSession(accessToken: string): Promise<RelayAuthSession> {
      const found = active.get(accessToken)
      if (!found) throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
      return found
    },
    async logout(accessToken: string): Promise<void> {
      active.delete(accessToken)
    },
  }
  return new AuthService({ authority, now: () => NOW, sessionTtlMs: 60_000 })
}

function managementGrant(
  accountId: string,
  overrides: Partial<AccountAuthorizationGrant> = {},
): AccountAuthorizationGrant {
  return {
    accountId,
    scopes: ['org:read', 'org:write'],
    allWorkspaces: true,
    workspaceIds: [],
    machineIds: [],
    memberIds: [],
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'zterm-accounts-identity-'))
  return {
    file: join(root, 'authorization.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function members(entries: Record<string, { memberId: string; workspaceId: string }>) {
  return {
    async getMember(memberId: string) {
      return entries[memberId] ?? null
    },
  }
}

function expectError(code: AccountsError['code'], status: AccountsError['status']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AccountsError, 'expected an AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  }
}

test('resolver denies an authorized account that has no explicit identity binding', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  // Allowlist contains exactly one member. It must not be used as identity.
  await store.putGrant(managementGrant('acct-a', { memberIds: ['mbr-a'] }))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({ 'mbr-a': { memberId: 'mbr-a', workspaceId: 'ws-1' } }),
  })

  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' }),
    expectError('ACCOUNT_MEMBER_IDENTITY_REQUIRED', 403),
  )
})

test('management designation derives the account from the verified session and ignores forged fields', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([
    session('acct-a', 'alice', 'token-a'),
    session('acct-b', 'bob', 'token-b'),
  ])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  await store.putGrant(managementGrant('acct-b'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({
      'mbr-a': { memberId: 'mbr-a', workspaceId: 'ws-1' },
      'mbr-b': { memberId: 'mbr-b', workspaceId: 'ws-1' },
    }),
  })

  // A forged target accountId is ignored; the caller account owns the binding.
  const saved = await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-a',
    expectedRevision: null,
    accountId: 'acct-b',
  } as never)
  assert.equal(saved.accountId, 'acct-a')
  assert.equal(saved.memberId, 'mbr-a')
  assert.equal(saved.state, 'active')
  assert.equal(saved.revision, 1)
  assert.equal(await store.getMemberIdentity('acct-b', 'ws-1'), undefined)

  const forged = await identity.resolveWorkspaceActor({
    token: 'token-a',
    workspaceId: 'ws-1',
    accountId: 'acct-b',
    memberId: 'mbr-b',
  } as never)
  assert.equal(forged.accountId, 'acct-a')
  assert.equal(forged.memberId, 'mbr-a')
})

test('resolver rejects a workspace outside the grant', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(
    managementGrant('acct-a', {
      allWorkspaces: false,
      workspaceIds: ['ws-1'],
    }),
  )
  // Controlled store record: this account is not a management account, so the
  // binding is seeded directly to isolate the workspace-scope check.
  await store.putMemberIdentity({
    accountId: 'acct-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({
      'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' },
    }),
  })

  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-2' }),
    expectError('WORKSPACE_FORBIDDEN', 403),
  )
  assert.equal(
    (await identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' })).memberId,
    'mbr-1',
  )
})

test('management designation rejects a member that does not belong to the target workspace', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({
      'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' },
      'mbr-2': { memberId: 'mbr-2', workspaceId: 'ws-2' },
    }),
  })

  await assert.rejects(
    identity.setMemberIdentity({
      token: 'token-a',
      workspaceId: 'ws-1',
      memberId: 'mbr-2',
      expectedRevision: null,
    }),
    expectError('ACCOUNT_MEMBER_IDENTITY_INVALID', 403),
  )
  assert.equal(await store.getMemberIdentity('acct-a', 'ws-1'), undefined)
})

test('management replacement requires the current revision and rejects stale mutations', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({
      'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' },
      'mbr-2': { memberId: 'mbr-2', workspaceId: 'ws-1' },
    }),
  })
  const created = await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })
  assert.equal(created.revision, 1)

  await assert.rejects(
    identity.setMemberIdentity({
      token: 'token-a',
      workspaceId: 'ws-1',
      memberId: 'mbr-1',
      expectedRevision: null,
    }),
    expectError('ACCOUNT_MEMBER_IDENTITY_CONFLICT', 409),
  )
  await assert.rejects(
    identity.setMemberIdentity({
      token: 'token-a',
      workspaceId: 'ws-1',
      memberId: 'mbr-2',
      expectedRevision: 7,
    }),
    expectError('ACCOUNT_MEMBER_IDENTITY_CONFLICT', 409),
  )

  const replaced = await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-2',
    expectedRevision: created.revision,
  })
  assert.equal(replaced.memberId, 'mbr-2')
  assert.equal(replaced.revision, 2)
  assert.equal(
    (await identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' })).memberId,
    'mbr-2',
  )
})

test('a member with an active owner cannot be claimed by another account', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([
    session('acct-a', 'alice', 'token-a'),
    session('acct-b', 'bob', 'token-b'),
  ])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a', { memberIds: ['mbr-1'] }))
  await store.putGrant(managementGrant('acct-b', { memberIds: ['mbr-1'] }))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({ 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }),
  })
  await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })

  await assert.rejects(
    identity.setMemberIdentity({
      token: 'token-b',
      workspaceId: 'ws-1',
      memberId: 'mbr-1',
      expectedRevision: null,
    }),
    expectError('ACCOUNT_MEMBER_IDENTITY_CONFLICT', 409),
  )
  assert.equal(await store.getMemberIdentity('acct-b', 'ws-1'), undefined)
})

test('revoked identity cannot resolve, including through a retained actor value', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({ 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }),
  })
  const created = await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })
  const retained = await identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' })
  assert.deepEqual(retained, {
    sessionId: 'token-a',
    accountId: 'acct-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    credentialState: 'active',
  })

  const revoked = await identity.revokeMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    expectedRevision: created.revision,
  })
  assert.equal(revoked.state, 'revoked')
  assert.equal(revoked.revision, created.revision + 1)

  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' }),
    expectError('ACCOUNT_MEMBER_IDENTITY_REVOKED', 403),
  )
  // The retained actor object cannot be re-verified because resolution now fails.
  assert.equal(retained.memberId, 'mbr-1')
})

test('grant revocation revokes identity atomically and re-grant does not resurrect it', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  const grant = await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({ 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }),
  })
  await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })

  await store.deleteGrant('acct-a', grant.authorizationGeneration)
  const revoked = await store.getMemberIdentity('acct-a', 'ws-1')
  assert.equal(revoked?.state, 'revoked')
  assert.equal(revoked?.revision, 2)

  await store.putGrant(managementGrant('acct-a'))
  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' }),
    expectError('ACCOUNT_MEMBER_IDENTITY_REVOKED', 403),
  )
})

test('identity binding survives a store restart', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({ 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }),
  })
  await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })

  const reopenedStore = createFileAccountAuthorizationStore(tmp.file)
  const reopened = createMemberIdentityService({
    authService: auth,
    store: reopenedStore,
    members: members({ 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }),
  })
  assert.deepEqual(
    await reopened.resolveWorkspaceActor({ token: 'token-a', workspaceId: 'ws-1' }),
    {
      sessionId: 'token-a',
      accountId: 'acct-a',
      workspaceId: 'ws-1',
      memberId: 'mbr-1',
      credentialState: 'active',
    },
  )
  const persisted = readFileSync(tmp.file, 'utf8')
  assert.equal(persisted.includes('token-a'), false)
  assert.equal(persisted.includes('credential'), false)
})

test('workspace input is required and the wildcard is rejected', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({}),
  })

  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a' } as never),
    expectError('INVALID_REQUEST', 400),
  )
  await assert.rejects(
    identity.resolveWorkspaceActor({ token: 'token-a', workspaceId: '*' }),
    expectError('INVALID_REQUEST', 400),
  )
})

test('ordinary accounts cannot self-claim identity and member allowlist is honored', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([
    session('acct-ordinary', 'ordinary', 'ordinary-token'),
    session('acct-admin', 'admin', 'admin-token'),
  ])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(
    managementGrant('acct-ordinary', {
      scopes: ['org:read'],
      allWorkspaces: false,
      workspaceIds: ['ws-1'],
    }),
  )
  await store.putGrant(managementGrant('acct-admin', { memberIds: ['mbr-allowed'] }))
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members({
      'mbr-allowed': { memberId: 'mbr-allowed', workspaceId: 'ws-1' },
      'mbr-excluded': { memberId: 'mbr-excluded', workspaceId: 'ws-1' },
    }),
  })

  await assert.rejects(
    identity.setMemberIdentity({
      token: 'ordinary-token',
      workspaceId: 'ws-1',
      memberId: 'mbr-allowed',
      expectedRevision: null,
    }),
    expectError('WORKSPACE_AUTHORIZATION_REQUIRED', 403),
  )
  assert.equal(await store.getMemberIdentity('acct-ordinary', 'ws-1'), undefined)

  await assert.rejects(
    identity.setMemberIdentity({
      token: 'admin-token',
      workspaceId: 'ws-1',
      memberId: 'mbr-excluded',
      expectedRevision: null,
    }),
    expectError('WORKSPACE_FORBIDDEN', 403),
  )
  assert.equal(await store.getMemberIdentity('acct-admin', 'ws-1'), undefined)
})

test('revocation remains possible after the referenced organization member is deleted', async (t) => {
  const tmp = tempStore()
  t.after(tmp.cleanup)
  const auth = createAuthService([session('acct-a', 'alice', 'token-a')])
  const store = createFileAccountAuthorizationStore(tmp.file)
  await store.putGrant(managementGrant('acct-a'))
  const entry = { 'mbr-1': { memberId: 'mbr-1', workspaceId: 'ws-1' } }
  const identity = createMemberIdentityService({
    authService: auth,
    store,
    members: members(entry),
  })
  const created = await identity.setMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    memberId: 'mbr-1',
    expectedRevision: null,
  })
  delete entry['mbr-1']

  const revoked = await identity.revokeMemberIdentity({
    token: 'token-a',
    workspaceId: 'ws-1',
    expectedRevision: created.revision,
  })
  assert.equal(revoked.state, 'revoked')
})
