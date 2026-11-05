import type { OperationRef } from '../domain/write-operation.ts'

/**
 * A context that accounts has already verified at the trust boundary. tickets
 * never mints or trusts a self-reported actor.
 */
export interface VerifiedAuthContext {
  sessionId: string
  accountId: string
  memberId: string
  credentialState: 'active'
}

export type TicketAction =
  | 'ticket.create'
  | 'ticket.read'
  | 'ticket.report'
  | 'ticket.state.write'
  | 'ticket.operation.reconcile'

export interface ActionCheck {
  actor: VerifiedAuthContext
  workspaceId: string
  goalId?: string
  bindingId?: string
  action: TicketAction
}

export interface DelegationCheck {
  actor: VerifiedAuthContext
  workspaceId: string
  goalId: string
  actorMemberId: string
  executingMemberId?: string
}

/**
 * Public readers from accounts/organization/goals. tickets only references
 * stable IDs; it never owns workspace, goal, member, or permission truth.
 */
export interface TicketPublicReaders {
  hasWorkspaceAction(check: ActionCheck): Promise<boolean>
  goalBelongsToWorkspace(workspaceId: string, goalId: string): Promise<boolean>
  memberExists(memberId: string): Promise<boolean>
  actorOwnsMember(actor: VerifiedAuthContext, memberId: string): Promise<boolean>
  hasReportDelegation(check: DelegationCheck): Promise<boolean>
}

export type { OperationRef }
