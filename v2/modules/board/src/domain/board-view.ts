import type { GoalTicketTopFiveObservation } from '../../../tickets/src/public/contracts.ts'

export interface GoalView {
  goalId: string
  workspaceId: string
  managerId: string
  title: string
  status: string
}

export interface MemberSubjectRef {
  kind: 'member'
  workspaceId: string
  memberId: string
}

export type MemberStatusValue = 'busy' | 'idle' | 'unknown'
export type MemberStatusFreshness = 'fresh' | 'stale' | 'unavailable' | 'unknown'

export interface MemberStatusErrorRef {
  code: string
  message?: string
}

export interface MemberStatusObservation {
  subjectRef: MemberSubjectRef
  source: string
  observedAt: number | string
  freshness: MemberStatusFreshness
  value: MemberStatusValue
  errorRef?: MemberStatusErrorRef
}

export interface ManagerGoalBoardSection {
  goal: GoalView
  tickets: GoalTicketTopFiveObservation
}

export interface ManagerBoardResult {
  workspaceId: string
  managerId: string
  observedAt: number
  goals: ManagerGoalBoardSection[]
  memberStatuses: MemberStatusObservation[]
}

