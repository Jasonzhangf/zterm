import {
  ALL_WORKSPACES,
  normalizeAccountAuthorizationGrant,
  toWorkspaceAuthorizationContext,
  type AccountAuthorizationGrant,
  type WorkspaceAuthorizationContext,
} from '../domain/authorization.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import { AccountsError } from '../public/errors.ts'
import type { AuthService } from './auth-service.ts'

export interface WorkspaceAuthorizationOptions {
  authService: AuthService
  store: AccountAuthorizationStore
  now?: () => number
}

export interface BindCreatedWorkspaceInput {
  token: string
  workspaceId: string
}

export class WorkspaceAuthorization {
  readonly #authService: AuthService
  readonly #store: AccountAuthorizationStore
  readonly #now: () => number

  constructor(options: WorkspaceAuthorizationOptions) {
    this.#authService = options.authService
    this.#store = options.store
    this.#now = options.now ?? Date.now
  }

  async verify(token: string): Promise<WorkspaceAuthorizationContext> {
    const authContext = await this.#authService.verifySession(token)
    const grant = await this.#store.getGrant(authContext.accountId)
    if (!grant) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'No workspace authorization grant exists for this account.',
      )
    }
    return toWorkspaceAuthorizationContext(grant)
  }

  async bindCreatedWorkspace(
    input: BindCreatedWorkspaceInput,
  ): Promise<WorkspaceAuthorizationContext> {
    const authContext = await this.#authService.verifySession(input?.token)
    const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : ''
    if (workspaceId.length === 0 || workspaceId === ALL_WORKSPACES) {
      throw new AccountsError(
        'INVALID_REQUEST',
        400,
        'workspaceId must be a non-empty stable ID.',
      )
    }

    const grant = await this.#store.getGrant(authContext.accountId)
    if (!grant) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'No workspace authorization grant exists for this account.',
      )
    }
    if (!grant.allWorkspaces || !grant.scopes.includes('org:write')) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The account does not have all-workspaces management authority.',
      )
    }

    const workspaceIds = grant.workspaceIds.includes(workspaceId)
      ? [...grant.workspaceIds]
      : [...grant.workspaceIds, workspaceId]
    const updated = normalizeAccountAuthorizationGrant({
      ...grant,
      workspaceIds,
      updatedAt: new Date(this.#now()).toISOString(),
    })
    await this.#store.putGrant(updated)
    return toWorkspaceAuthorizationContext(updated)
  }
}

export function createWorkspaceAuthorization(
  options: WorkspaceAuthorizationOptions,
): WorkspaceAuthorization {
  return new WorkspaceAuthorization(options)
}
