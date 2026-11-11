import { V1RelayAdapter } from '../adapters/v1-relay.ts'
import { createFileAccountAuthorizationStore } from '../adapters/file-account-authorization-store.ts'
import { AuthService } from '../application/auth-service.ts'
import { createAccountsAuthorityRuntime } from '../application/accounts-authority-runtime.ts'
import { createMemberIdentityService } from '../application/member-identity.ts'

export { AccountsError } from './errors.ts'
export { AuthService } from '../application/auth-service.ts'
export { createAccountsAuthorityRuntime } from '../application/accounts-authority-runtime.ts'
export { MemberIdentityService, createMemberIdentityService } from '../application/member-identity.ts'
export { createFileAccountAuthorizationStore } from '../adapters/file-account-authorization-store.ts'
export { V1RelayAdapter } from '../adapters/v1-relay.ts'

export function createAccountsRuntime(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createAccountsRuntime requires an options object.')
  }
  const relay = new V1RelayAdapter({
    baseUrl: options.relayBaseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  if (
    typeof options.authorizationStoreFile !== 'string' ||
    options.authorizationStoreFile.trim().length === 0
  ) {
    throw new TypeError('createAccountsRuntime requires an authorization store file.')
  }
  const store = createFileAccountAuthorizationStore(
    options.authorizationStoreFile,
  )
  const authService = new AuthService({
    authority: relay,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
  })
  const runtime = createAccountsAuthorityRuntime({
    authService,
    relay,
    store,
  })
  const identity = options.members
    ? createMemberIdentityService({
        authService,
        store,
        members: options.members,
      })
    : undefined
  return Object.freeze({
    login: runtime.login.bind(runtime),
    grant: runtime.grant.bind(runtime),
    revoke: runtime.revoke.bind(runtime),
    verifyAuthority: runtime.verifyAuthority.bind(runtime),
    ...(identity
      ? {
          setMemberIdentity: identity.setMemberIdentity.bind(identity),
          revokeMemberIdentity: identity.revokeMemberIdentity.bind(identity),
          resolveWorkspaceActor: identity.resolveWorkspaceActor.bind(identity),
        }
      : {}),
  })
}
