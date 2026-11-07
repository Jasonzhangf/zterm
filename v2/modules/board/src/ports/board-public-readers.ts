import type { VerifiedAuthContext } from '../../../tickets/src/public/contracts.ts'

export type BoardAuthContext = VerifiedAuthContext

export interface OrganizationAuthorizedManagerInput {
  token: string
  workspaceId: string
  managerId: string
}

export interface BoardAuthReader {
  verifySession(token: string): Promise<BoardAuthContext>
}

export interface ManagerScope {
  workspaceId: string
  managerId: string
  directMemberIds: readonly string[]
}

/**
 * Board-owned read-only upstream adapter contract. The adapter receives the
 * caller token so the goals owner preserves its own authorization.
 */
export interface GoalsPublicAdapterPort {
  listGoals(input: {
    token: string
    workspaceId: string
    parentGoalId?: string
  }): Promise<Array<Record<string, unknown>>>
}

export interface BoardOrganizationReader {
  readAuthorizedManagerScope(input: OrganizationAuthorizedManagerInput): Promise<ManagerScope | null>
}

