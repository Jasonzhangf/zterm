export type TicketCategory = 'requirement' | 'bug' | 'report' | 'other'

/**
 * Workspace -> provider project mapping. This is typed control owned by tickets;
 * it is never written into a task description, label, or title.
 */
export interface WorkspaceProviderBinding {
  workspaceId: string
  providerInstanceId: string
  externalProjectId: number
  authority: string
  createdAt: number
  updatedAt: number
}

/**
 * Ticket -> goal/owner association. Content and done state stay in Vikunja; this
 * record only holds stable references plus the last observed projection.
 */
export interface TicketBinding {
  bindingId: string
  workspaceId: string
  goalId: string
  ownerMemberId: string
  providerInstanceId: string
  /**
   * Provider project the ticket was created in. It is fixed at bind time so a
   * later workspace mapping change cannot retarget an existing ticket.
   */
  externalProjectId: number
  externalTaskId: number
  category: TicketCategory
  providerAssigneeId?: number
  lastObservedTitle?: string
  lastObservedPriority?: number
  lastObservedDone?: boolean
  lastObservedAt?: number
  stateIntentVersion: number
}
