export { TicketError } from './errors.ts'
export type {
  RetryDisposition,
  TicketErrorCode,
  TicketErrorOptions,
} from './errors.ts'

export type { OperationRef, WriteOperation, WriteOperationKind, WriteOperationState, Resolution, SuccessSource } from '../domain/write-operation.ts'
export type { TicketBinding, TicketCategory, WorkspaceProviderBinding } from '../domain/ticket-binding.ts'
export type {
  CreateTicketResult,
  ErrorRef,
  GoalTicketTopFiveObservation,
  OperationFreshness,
  OperationView,
  PendingWriteObservation,
  TicketBindingView,
  TicketFreshness,
  TicketListObservation,
  TicketObservation,
  TicketView,
  WriteOperationResult,
} from '../domain/ticket-view.ts'

export type { BindingStorePort, BindingFilter, CommitWriteResult, CreateOperationResult, Lease, OperationFilter, PendingWriteScope } from '../ports/binding-store.ts'
export type { ProviderInstance, ProviderInstanceStatus } from '../domain/provider-instance.ts'
export type { CredentialProviderPort, ProviderCredential } from '../ports/credential-provider.ts'
export type {
  CreateCommentRequest,
  CreateTaskRequest,
  GetTaskRequest,
  ListCommentsRequest,
  ListTasksRequest,
  UpdateTaskRequest,
  VikunjaClientPort,
  VikunjaComment,
  VikunjaRequest,
  VikunjaResult,
  VikunjaTask,
  VikunjaTaskPage,
} from '../ports/vikunja-client.ts'
export type {
  ActionCheck,
  DelegationCheck,
  TicketAction,
  TicketPublicReaders,
  VerifiedAuthContext,
} from '../ports/ticket-public-readers.ts'

export { InMemoryBindingStore } from '../adapters/in-memory-binding-store.ts'
export { SqliteBindingStore } from '../adapters/sqlite-binding-store.ts'
export type { SqliteBindingStoreOptions } from '../adapters/sqlite-binding-store.ts'
export { VikunjaV2Adapter } from '../adapters/vikunja-v2/vikunja-adapter.ts'
export { TicketService } from '../application/ticket-service.ts'
export type {
  AppendReportInput,
  ConfirmRemoteResultInput,
  CreateTicketInput,
  GetTicketInput,
  ListTicketsInput,
  MutateTicketStateInput,
  TicketServiceOptions,
} from '../application/ticket-service.ts'
