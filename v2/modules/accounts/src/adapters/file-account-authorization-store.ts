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
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import { AccountsError } from '../public/errors.ts'

interface AuthorizationStoreState {
  version: 2
  grants: Record<string, NormalizedAccountAuthorizationGrant>
  generations: Record<string, number>
}

function emptyState(): AuthorizationStoreState {
  return { version: 2, grants: {}, generations: {} }
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
  if (version !== 1 && version !== 2) {
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
  return { version: 2, grants, generations }
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
        return current ? { ...current } : undefined
      })
    },
  })
}
