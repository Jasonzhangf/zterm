export { BoardError } from './errors.ts'
export type { BoardErrorCode, BoardErrorOptions } from './errors.ts'

export { ManagerBoardReader } from '../application/manager-board-reader.ts'
export type { BoardQueryInput, ManagerBoardReaderOptions } from '../application/manager-board-reader.ts'
export { GoalsPublicAdapter } from '../adapters/goals-public-adapter.ts'
export { OrganizationPublicAdapter } from '../adapters/organization-public-adapter.ts'

export type {
  GoalView,
  ManagerBoardResult,
  ManagerGoalBoardSection,
  MemberStatusErrorRef,
  MemberStatusFreshness,
  MemberStatusObservation,
  MemberStatusValue,
  MemberSubjectRef,
} from '../domain/board-view.ts'

export type {
  BoardAuthContext,
  BoardAuthReader,
  BoardOrganizationReader,
  GoalsPublicAdapterPort,
  ManagerScope,
  OrganizationAuthorizedManagerInput,
} from '../ports/board-public-readers.ts'
export type { GoalReaderPort } from '../ports/goal-reader.ts'
export type { TicketReaderPort } from '../ports/ticket-reader.ts'
export type { MemberStatusReaderPort } from '../ports/member-status-reader.ts'

