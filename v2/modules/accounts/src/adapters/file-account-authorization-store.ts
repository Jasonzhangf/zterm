// Atomic JSON store for accounts-owned workspace authorization policy. The
// account ID is the subject and stable workspace/member IDs are the resources.
// Reads and read-modify-write updates are serialized per store instance.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  normalizeAccountAuthorizationGrant,
  type AccountAuthorizationGrantInput,
  type NormalizedAccountAuthorizationGrant,
} from '../domain/authorization.ts'
import {
  normalizeAccountMemberIdentityBinding,
  requireConcreteWorkspaceId,
  requirePositiveRevision,
  requireStableId,
  type AccountMemberIdentityBinding,
  type RevokeMemberIdentityStoreInput,
  type SetMemberIdentityStoreInput,
} from '../domain/member-identity.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import { AccountsError } from '../public/errors.ts'

// Version 2 added grant generation counters. Version 3 adds the explicit
// accounts-owned account/member identity collection. Version 3 is written only
// when an identity mutation occurs so an older reader fails explicitly instead
// of rewriting the finer format.
type AuthorizationStoreVersion = 2 | 3

interface AuthorizationStoreState {
  version: AuthorizationStoreVersion
  grants: Record<string, NormalizedAccountAuthorizationGrant>
  generations: Record<string, number>
  identities: Record<string, Record<string, AccountMemberIdentityBinding>>
}

function emptyState(): AuthorizationStoreState {
  return { version: 2, grants: {}, generations: {}, identities: {} }
}

function requiredAccountId(accountId: unknown): string {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, 'accountId must be a non-empty stable ID.')
  }
  return accountId.trim()
}

function parseState(text: string): AuthorizationStoreState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('grants' in value) ||
    !value.grants ||
    typeof value.grants !== 'object' ||
    Array.isArray(value.grants)
  ) {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
  }

  const version = 'version' in value ? value.version : undefined
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
  }
  const generations: Record<string, number> = {}
  if ('generations' in value && value.generations !== undefined) {
    if (
      !value.generations ||
      typeof value.generations !== 'object' ||
      Array.isArray(value.generations)
    ) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
    }
    for (const [accountId, generation] of Object.entries(value.generations)) {
      const normalizedAccountId = requiredAccountId(accountId)
      if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
        throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
      }
      generations[normalizedAccountId] = generation as number
    }
  }
  const grants: Record<string, NormalizedAccountAuthorizationGrant> = {}
  for (const [storedAccountId, storedGrant] of Object.entries(value.grants)) {
    const grant = normalizeAccountAuthorizationGrant(
      storedGrant as AccountAuthorizationGrantInput,
    )
    if (grant.accountId !== storedAccountId) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
    }
    grants[storedAccountId] = grant
    generations[storedAccountId] = Math.max(
      generations[storedAccountId] ?? 0,
      grant.authorizationGeneration,
    )
  }

  const identities: Record<string, Record<string, AccountMemberIdentityBinding>> = {}
  // A stable member may have at most one active owner across the whole store.
  // Detect a malformed or imported ambiguity at load instead of choosing one.
  const activeMemberOwner = new Map<string, string>()
  if ('identities' in value && value.identities !== undefined) {
    if (
      !value.identities ||
      typeof value.identities !== 'object' ||
      Array.isArray(value.identities)
    ) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
    }
    for (const [storedAccountId, storedWorkspaces] of Object.entries(value.identities)) {
      const normalizedAccountId = requiredAccountId(storedAccountId)
      if (
        !storedWorkspaces ||
        typeof storedWorkspaces !== 'object' ||
        Array.isArray(storedWorkspaces)
      ) {
        throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
      }
      const byWorkspace: Record<string, AccountMemberIdentityBinding> = {}
      for (const [storedWorkspaceId, storedBinding] of Object.entries(storedWorkspaces)) {
        const binding = normalizeAccountMemberIdentityBinding(storedBinding)
        if (
          binding.accountId !== normalizedAccountId ||
          binding.workspaceId !== storedWorkspaceId
        ) {
          throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
        }
        if (binding.state === 'active') {
          const key = `${normalizedAccountId}\u0000${storedWorkspaceId}`
          if (activeMemberOwner.has(binding.memberId) && activeMemberOwner.get(binding.memberId) !== key) {
            throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
          }
          activeMemberOwner.set(binding.memberId, key)
        }
        byWorkspace[binding.workspaceId] = binding
      }
      identities[normalizedAccountId] = byWorkspace
    }
  }

  return { version: version === 3 ? 3 : 2, grants, generations, identities }
}

function identityConflict(message: string, details: Readonly<Record<string, unknown>>): AccountsError {
  return new AccountsError('ACCOUNT_MEMBER_IDENTITY_CONFLICT', 409, message, details)
}

export function createFileAccountAuthorizationStore(file: string): AccountAuthorizationStore {
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new TypeError('Account authorization store requires a file path.')
  }

  let chain: Promise<void> = Promise.resolve()

  async function load(): Promise<AuthorizationStoreState> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return emptyState()
      }
      throw error
    }
    return parseState(text)
  }

  async function persist(state: AuthorizationStoreState): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temp, file)
  }

  function read(): Promise<AuthorizationStoreState> {
    return chain.then(load)
  }

  function update<T>(
    mutator: (state: AuthorizationStoreState) => T,
  ): Promise<T> {
    const run = chain.then(async () => {
      const state = await load()
      const result = mutator(state)
      await persist(state)
      return result
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return Object.freeze({
    async getGrant(accountId: string): Promise<NormalizedAccountAuthorizationGrant | undefined> {
      const state = await read()
      const grant = state.grants[requiredAccountId(accountId)]
      return grant ? normalizeAccountAuthorizationGrant(grant) : undefined
    },

    async putGrant(
      grant: AccountAuthorizationGrantInput,
    ): Promise<NormalizedAccountAuthorizationGrant> {
      if (!grant || typeof grant !== 'object') {
        throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization grant is required.')
      }
      const hasExplicitGeneration = grant.authorizationGeneration !== undefined
      const normalized = normalizeAccountAuthorizationGrant(grant)
      return await update((state) => {
        const currentGeneration = state.generations[normalized.accountId] ?? 0
        if (
          hasExplicitGeneration &&
          normalized.authorizationGeneration < currentGeneration
        ) {
          throw new AccountsError(
            'AUTHORIZATION_GENERATION_STALE',
            409,
            'Account authorization generation is stale.',
            {
              accountId: normalized.accountId,
              expectedGeneration: normalized.authorizationGeneration,
              currentGeneration,
            },
          )
        }
        const saved = normalizeAccountAuthorizationGrant({
          ...normalized,
          authorizationGeneration: hasExplicitGeneration
            ? normalized.authorizationGeneration
            : currentGeneration + 1,
        })
        state.grants[saved.accountId] = saved
        state.generations[saved.accountId] = saved.authorizationGeneration
        return saved
      })
    },

    async deleteGrant(
      accountId: string,
      expectedGeneration?: number,
    ): Promise<NormalizedAccountAuthorizationGrant | undefined> {
      const normalizedAccountId = requiredAccountId(accountId)
      return await update((state) => {
        const current = state.grants[normalizedAccountId]
        if (expectedGeneration !== undefined) {
          if (
            !current ||
            current.authorizationGeneration !== expectedGeneration
          ) {
            throw new AccountsError(
              'AUTHORIZATION_GENERATION_STALE',
              409,
              'Account authorization generation is stale.',
              {
                accountId: normalizedAccountId,
                expectedGeneration,
                currentGeneration: current?.authorizationGeneration ?? null,
              },
            )
          }
        }
        delete state.grants[normalizedAccountId]
        // Revoking the management/grant record revokes the account's active
        // identity records in the same serialized mutation. A later grant must
        // not silently reactivate them.
        const accountIdentities = state.identities[normalizedAccountId]
        if (accountIdentities) {
          for (const [workspaceId, binding] of Object.entries(accountIdentities)) {
            if (binding.state === 'active') {
              accountIdentities[workspaceId] = {
                ...binding,
                state: 'revoked',
                revision: binding.revision + 1,
              }
              state.version = 3
            }
          }
        }
        return current ? { ...current } : undefined
      })
    },

    async getMemberIdentity(
      accountId: string,
      workspaceId: string,
    ): Promise<AccountMemberIdentityBinding | undefined> {
      const state = await read()
      const binding =
        state.identities[requiredAccountId(accountId)]?.[requireConcreteWorkspaceId(workspaceId)]
      return binding ? { ...binding } : undefined
    },

    async putMemberIdentity(
      input: SetMemberIdentityStoreInput,
    ): Promise<AccountMemberIdentityBinding> {
      if (!input || typeof input !== 'object') {
        throw new AccountsError('INVALID_REQUEST', 400, 'Member identity input is required.')
      }
      const accountId = requireStableId(input.accountId, 'accountId')
      const workspaceId = requireConcreteWorkspaceId(input.workspaceId)
      const memberId = requireStableId(input.memberId, 'memberId')
      const expectedRevision = input.expectedRevision
      if (expectedRevision !== null) {
        requirePositiveRevision(expectedRevision, 'expectedRevision')
      }
      return await update((state) => {
        const current = state.identities[accountId]?.[workspaceId]
        if (expectedRevision === null) {
          if (current) {
            throw identityConflict(
              'An account/member identity binding already exists for this workspace.',
              { accountId, workspaceId },
            )
          }
        } else if (!current || current.revision !== expectedRevision) {
          throw identityConflict('Member identity revision is stale.', {
            accountId,
            workspaceId,
            expectedRevision,
            currentRevision: current?.revision ?? null,
          })
        }
        for (const [otherAccountId, byWorkspace] of Object.entries(state.identities)) {
          for (const [otherWorkspaceId, binding] of Object.entries(byWorkspace)) {
            if (binding.state !== 'active' || binding.memberId !== memberId) continue
            if (otherAccountId === accountId && otherWorkspaceId === workspaceId) continue
            throw identityConflict('The member already has an active account owner.', {
              memberId,
            })
          }
        }
        const saved: AccountMemberIdentityBinding = {
          accountId,
          workspaceId,
          memberId,
          state: 'active',
          revision: current ? current.revision + 1 : 1,
        }
        const byWorkspace =
          state.identities[accountId] ?? (state.identities[accountId] = {})
        byWorkspace[workspaceId] = saved
        state.version = 3
        return { ...saved }
      })
    },

    async revokeMemberIdentity(
      input: RevokeMemberIdentityStoreInput,
    ): Promise<AccountMemberIdentityBinding> {
      if (!input || typeof input !== 'object') {
        throw new AccountsError('INVALID_REQUEST', 400, 'Member identity input is required.')
      }
      const accountId = requireStableId(input.accountId, 'accountId')
      const workspaceId = requireConcreteWorkspaceId(input.workspaceId)
      const expectedRevision = requirePositiveRevision(input.expectedRevision, 'expectedRevision')
      return await update((state) => {
        const current = state.identities[accountId]?.[workspaceId]
        if (!current) {
          throw new AccountsError(
            'ACCOUNT_MEMBER_IDENTITY_REQUIRED',
            403,
            'No account/member identity binding exists for this workspace.',
            { accountId, workspaceId },
          )
        }
        if (current.revision !== expectedRevision) {
          throw identityConflict('Member identity revision is stale.', {
            accountId,
            workspaceId,
            expectedRevision,
            currentRevision: current.revision,
          })
        }
        const saved: AccountMemberIdentityBinding = {
          ...current,
          state: 'revoked',
          revision: current.revision + 1,
        }
        state.identities[accountId][workspaceId] = saved
        state.version = 3
        return { ...saved }
      })
    },

    async findActiveMemberIdentityByMember(
      memberId: string,
    ): Promise<AccountMemberIdentityBinding | undefined> {
      const normalized = requireStableId(memberId, 'memberId')
      const state = await read()
      for (const byWorkspace of Object.values(state.identities)) {
        for (const binding of Object.values(byWorkspace)) {
          if (binding.state === 'active' && binding.memberId === normalized) {
            return { ...binding }
          }
        }
      }
      return undefined
    },
  })
}
