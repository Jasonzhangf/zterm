import type { RelayAuthPort } from '../ports/relay-authority.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import {
  ALL_WORKSPACES,
  normalizeAccountAuthorizationGrant,
  type AccountAuthorizationGrantInput,
  type NormalizedAccountAuthorizationGrant,
} from '../domain/authorization.ts'
import { AccountsError } from '../public/errors.ts'
import { AuthService } from './auth-service.ts'

export interface LoginRequest {
  readonly loginName: string
  readonly credential: string
}

export interface LoginResponse {
  readonly token: string
  readonly accountId: string
  readonly loginName: string
}

export interface GrantRequest {
  readonly token: string
  readonly accountId: string
  readonly scopes: readonly string[]
  readonly allWorkspaces: boolean
  readonly workspaceIds: readonly string[]
  readonly machineIds: readonly string[]
}

export interface GrantResponse {
  readonly accountId: string
  readonly scopes: readonly string[]
  readonly allWorkspaces: boolean
  readonly workspaceIds: readonly string[]
  readonly machineIds: readonly string[]
  readonly authorizationGeneration: number
  readonly bindingGeneration: number
}

export interface RevokeRequest {
  readonly token: string
  readonly accountId: string
  readonly expectedGeneration?: number
}

export interface RevokeResponse {
  readonly accountId: string
  readonly revokedGeneration: number
}

export interface VerifyAuthorityRequest {
  readonly token: string
  readonly workspaceId: string
  readonly machineId: string
  readonly expectedGeneration?: number
}

export interface VerifyAuthorityResponse {
  readonly accountId: string
  readonly workspaceId: string
  readonly machineId: string
  readonly scopes: readonly string[]
  readonly authorizationGeneration: number
  readonly bindingGeneration: number
}

export interface AccountsAuthorityRuntime {
  login(request: LoginRequest): Promise<LoginResponse>
  grant(request: GrantRequest): Promise<GrantResponse>
  revoke(request: RevokeRequest): Promise<RevokeResponse>
  verifyAuthority(
    request: VerifyAuthorityRequest,
  ): Promise<VerifyAuthorityResponse>
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} is required.`)
  }
  return value.trim()
}

function toStringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must be an array.`)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, `${field} must contain non-empty strings.`)
    }
    const normalized = entry.trim()
    if (normalized === ALL_WORKSPACES) {
      throw new AccountsError('INVALID_REQUEST', 400, `${field} must not use the workspace wildcard.`)
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

/**
 * Accounts-owned authority lifecycle over the relay identity boundary and the
 * persistent accounts policy store. The relay remains the single account and
 * session authority; this runtime never mints a local session or accepts a
 * token as proof of a workspace/machine grant. Every action revalidates the
 * caller session through the relay and then enforces the exact stored policy.
 */
export function createAccountsAuthorityRuntime(options: {
  readonly authService: AuthService
  readonly relay: RelayAuthPort
  readonly store: AccountAuthorizationStore
}): AccountsAuthorityRuntime {
  const authService = options.authService
  const relay = options.relay
  const store = options.store

  async function requireManagementGrant(token: string) {
    const authContext = await authService.verifySession(token)
    const adminGrant = await store.getGrant(authContext.accountId)
    if (
      !adminGrant ||
      !adminGrant.allWorkspaces ||
      !adminGrant.scopes.includes('org:write')
    ) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'A currently verified all-workspaces org:write management grant is required.',
      )
    }
    return { authContext, adminGrant }
  }

  async function login(request: LoginRequest): Promise<LoginResponse> {
    if (!request || typeof request !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'Login request is required.')
    }
    const loginName = requireNonEmpty(request.loginName, 'loginName')
    const credential = requireNonEmpty(request.credential, 'credential')
    const session = await relay.authenticate(loginName, credential)
    return {
      token: session.accessToken,
      accountId: session.accountId,
      loginName: session.loginName,
    }
  }

  async function grant(request: GrantRequest): Promise<GrantResponse> {
    if (!request || typeof request !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'Grant request is required.')
    }
    await requireManagementGrant(request.token)
    const input: AccountAuthorizationGrantInput = {
      accountId: request.accountId,
      scopes: toStringList(request.scopes, 'scopes'),
      allWorkspaces: request.allWorkspaces === true,
      workspaceIds: toStringList(request.workspaceIds, 'workspaceIds'),
      machineIds: toStringList(request.machineIds, 'machineIds'),
      memberIds: [],
      updatedAt: new Date().toISOString(),
    }
    const saved = await store.putGrant(input)
    return toGrantResponse(saved)
  }

  async function revoke(request: RevokeRequest): Promise<RevokeResponse> {
    if (!request || typeof request !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'Revoke request is required.')
    }
    await requireManagementGrant(request.token)
    const accountId = requireNonEmpty(request.accountId, 'accountId')
    const revoked = await store.deleteGrant(accountId, request.expectedGeneration)
    if (!revoked) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'No workspace authorization grant exists for this account.',
      )
    }
    return {
      accountId,
      revokedGeneration: revoked.authorizationGeneration,
    }
  }

  async function verifyAuthority(
    request: VerifyAuthorityRequest,
  ): Promise<VerifyAuthorityResponse> {
    if (!request || typeof request !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'verifyAuthority request is required.')
    }
    const workspaceId = requireNonEmpty(request.workspaceId, 'workspaceId')
    const machineId = requireNonEmpty(request.machineId, 'machineId')
    if (workspaceId === ALL_WORKSPACES) {
      throw new AccountsError('INVALID_REQUEST', 400, 'workspaceId must not use the workspace wildcard.')
    }
    const authContext = await authService.verifySession(request.token)
    const grant = await store.getGrant(authContext.accountId)
    if (!grant) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'No workspace authorization grant exists for this account.',
      )
    }
    if (request.expectedGeneration !== undefined) {
      if (
        !Number.isSafeInteger(request.expectedGeneration) ||
        request.expectedGeneration < 0
      ) {
        throw new AccountsError('INVALID_REQUEST', 400, 'expectedGeneration must be a non-negative safe integer.')
      }
      if (grant.authorizationGeneration !== request.expectedGeneration) {
        throw new AccountsError(
          'AUTHORIZATION_GENERATION_STALE',
          409,
          `authorization generation ${grant.authorizationGeneration} != expected ${request.expectedGeneration}`,
          {
            accountId: authContext.accountId,
            expectedGeneration: request.expectedGeneration,
            currentGeneration: grant.authorizationGeneration,
          },
        )
      }
    }
    const normalized: NormalizedAccountAuthorizationGrant =
      normalizeAccountAuthorizationGrant(grant)
    const workspaceAllowed =
      normalized.allWorkspaces || normalized.workspaceIds.includes(workspaceId)
    if (!workspaceAllowed) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The account is not authorized for this workspace.',
        { workspaceId },
      )
    }
    if (!normalized.machineIds.includes(machineId)) {
      throw new AccountsError(
        'MACHINE_NOT_OWNED',
        403,
        'The account is not authorized for this machine.',
        { machineId },
      )
    }
    return {
      accountId: normalized.accountId,
      workspaceId,
      machineId,
      scopes: [...normalized.scopes],
      authorizationGeneration: normalized.authorizationGeneration,
      bindingGeneration: normalized.authorizationGeneration,
    }
  }

  return Object.freeze({
    login,
    grant,
    revoke,
    verifyAuthority,
  })
}

function toGrantResponse(grant: NormalizedAccountAuthorizationGrant): GrantResponse {
  const normalized = normalizeAccountAuthorizationGrant(grant)
  return {
    accountId: normalized.accountId,
    scopes: [...normalized.scopes],
    allWorkspaces: normalized.allWorkspaces,
    workspaceIds: [...normalized.workspaceIds],
    machineIds: [...normalized.machineIds],
    authorizationGeneration: normalized.authorizationGeneration,
    bindingGeneration: normalized.authorizationGeneration,
  }
}
