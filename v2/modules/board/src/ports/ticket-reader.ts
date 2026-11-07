import type { GoalTicketTopFiveObservation, VerifiedAuthContext } from '../../../tickets/src/public/contracts.ts'

export interface TicketReaderPort {
  listForGoalTopFive(
    actor: VerifiedAuthContext,
    workspaceId: string,
    goalId: string,
  ): Promise<GoalTicketTopFiveObservation>
}

