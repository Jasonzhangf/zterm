export { AccountsError } from './errors.ts'
export type { AccountsErrorCode } from './errors.ts'

export type { AccountRef, AuthContext, AccountRecord } from '../domain/accounts.ts'
export { ALL_WORKSPACES } from '../domain/authorization.ts'
export type {
  AccountAuthorizationGrant,
  WorkspaceAuthorizationContext,
} from '../domain/authorization.ts'
export type { LoginSessionRecord } from '../domain/login-sessions.ts'
export type { MachineRef, MachineRecord } from '../domain/machines.ts'

export type { AccountStore } from '../ports/account-store.ts'
export type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
export type { RelayAuthPort, RelayAuthSession, RelayRegistration } from '../ports/relay-authority.ts'
export type {
  AccountDirectoryPort,
  RelayAccountDirectory,
  RelayDirectoryDevice,
} from '../ports/account-directory.ts'
export type {
  MachineIdentity,
  MachineProof,
  MachineRegistrationPort,
  MachineRevocation,
  MachineSummary,
} from '../ports/machine-registration.ts'

export { AuthService } from '../application/auth-service.ts'
export type { RegisterResult, LoginResult, LogoutResult } from '../application/auth-service.ts'
export {
  WorkspaceAuthorization,
  createWorkspaceAuthorization,
} from '../application/workspace-authorization.ts'
export type {
  BindCreatedWorkspaceInput,
  WorkspaceAuthorizationOptions,
} from '../application/workspace-authorization.ts'
export { MachineService } from '../application/machine-service.ts'
export type {
  EnrollMachineInput,
  VerifyMachinePossessionInput,
  RevokeMachineInput,
} from '../application/machine-service.ts'
export {
  AccountsAuthorizationAdapter,
  createAccountsAuthorizationPort,
} from '../application/accounts-authorization.ts'
export {
  createAccountsAuthorityRuntime,
} from '../application/accounts-authority-runtime.ts'
export type {
  AccountsAuthorizationOptions,
  AccountsAuthorizationPort,
  AccountsLinkKind,
  AccountsTraversalPath,
  AuthorizedMachineLink,
  MachineAuthorizationCapabilities,
  MachineAuthorizationRoute,
  MachineAuthorizationSettings,
  MachineAuthorizationTarget,
  MachineRouteSource,
} from '../application/accounts-authorization.ts'
export { V1RelayAdapter } from '../adapters/v1-relay.ts'
export { createFileAccountAuthorizationStore } from '../adapters/file-account-authorization-store.ts'

// TEST DOUBLE only: not authority. Formal consumers must use V1RelayAdapter.
export { InMemoryAccountStore } from '../adapters/in-memory-account-store.ts'
