// Atomic JSON store for accounts-owned workspace authorization policy. The
// account ID is the subject and stable workspace/member IDs are the resources.
// Reads and read-modify-write updates are serialized per store instance.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  normalizeAccountAuthorizationGrant,
  type AccountAuthorizationGrant,
} from '../domain/authorization.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import { AccountsError } from '../public/errors.ts'

interface AuthorizationStoreState {
  version: 1
  grants: Record<string, AccountAuthorizationGrant>
}

function emptyState(): AuthorizationStoreState {
  return { version: 1, grants: {} }
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

  const grants: Record<string, AccountAuthorizationGrant> = {}
  for (const [storedAccountId, storedGrant] of Object.entries(value.grants)) {
    const grant = normalizeAccountAuthorizationGrant(
      storedGrant as AccountAuthorizationGrant,
    )
    if (grant.accountId !== storedAccountId) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization store is invalid.')
    }
    grants[storedAccountId] = grant
  }
  return { version: 1, grants }
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

  function update(
    mutator: (state: AuthorizationStoreState) => void,
  ): Promise<void> {
    const run = chain.then(async () => {
      const state = await load()
      mutator(state)
      await persist(state)
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return Object.freeze({
    async getGrant(accountId: string): Promise<AccountAuthorizationGrant | undefined> {
      const state = await read()
      const grant = state.grants[requiredAccountId(accountId)]
      return grant ? normalizeAccountAuthorizationGrant(grant) : undefined
    },

    async putGrant(grant: AccountAuthorizationGrant): Promise<void> {
      const normalized = normalizeAccountAuthorizationGrant(grant)
      await update((state) => {
        state.grants[normalized.accountId] = normalized
      })
    },

    async deleteGrant(accountId: string): Promise<void> {
      const normalizedAccountId = requiredAccountId(accountId)
      await update((state) => {
        delete state.grants[normalizedAccountId]
      })
    },
  })
}
