import { BoardError } from '../public/errors.ts'
import type { GoalTicketTopFiveObservation, TicketErrorCode } from '../../../tickets/src/public/contracts.ts'
import type {
  ManagerBoardResult,
  MemberStatusObservation,
} from '../domain/board-view.ts'
import type { BoardAuthReader, BoardOrganizationReader, ManagerScope } from '../ports/board-public-readers.ts'
import type { GoalReaderPort } from '../ports/goal-reader.ts'
import type { TicketReaderPort } from '../ports/ticket-reader.ts'
import type { MemberStatusReaderPort } from '../ports/member-status-reader.ts'

export interface BoardQueryInput {
  token: string
  workspaceId: string
  managerId: string
}

export interface ManagerBoardReaderOptions {
  accounts: BoardAuthReader
  organization: BoardOrganizationReader
  goals: GoalReaderPort
  tickets: TicketReaderPort
  members: MemberStatusReaderPort
  now?: () => number
}

const AUTH_ERROR_CODES = new Set([
  'AUTHENTICATION_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'UNAUTHENTICATED',
])

const SCOPE_ERROR_CODES = new Set([
  'BOARD_SCOPE_FORBIDDEN',
  'ORGANIZATION_FORBIDDEN',
  'MEMBER_FORBIDDEN_SCOPE',
  'MEMBER_FORBIDDEN_WORKSPACE',
  'MEMBER_FORBIDDEN_MEMBER',
  'TICKET_SCOPE_FORBIDDEN',
])

const TICKET_SECTION_ERROR_CODES = new Set([
  'PROVIDER_UNAUTHORIZED',
  'PROVIDER_FORBIDDEN',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_VALIDATION_FAILED',
  'PROVIDER_UNAVAILABLE',
  'WRITE_OUTCOME_UNKNOWN',
  'OPERATION_CONFLICT',
  'OPERATION_SUPERSEDED',
  'BINDING_CONFLICT',
])

const MEMBER_STATUS_ERROR_CODES = new Set([
  'MEMBER_STATUS_UNAVAILABLE',
  'STATUS_UNAVAILABLE',
  'STATUS_SOURCE_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

function requireString(value: unknown, field: keyof BoardQueryInput): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BoardError('BOARD_INVALID_REQUEST', `${field} must be a non-empty string`)
  }
  return value
}

export class ManagerBoardReader {
  readonly #accounts: BoardAuthReader
  readonly #organization: BoardOrganizationReader
  readonly #goals: GoalReaderPort
  readonly #tickets: TicketReaderPort
  readonly #members: MemberStatusReaderPort
  readonly #now: () => number

  constructor(options: ManagerBoardReaderOptions) {
    this.#accounts = options.accounts
    this.#organization = options.organization
    this.#goals = options.goals
    this.#tickets = options.tickets
    this.#members = options.members
    this.#now = options.now ?? Date.now
  }

  async queryManagerBoard(input: BoardQueryInput): Promise<ManagerBoardResult> {
    if (!isRecord(input)) {
      throw new BoardError('BOARD_INVALID_REQUEST', 'input must be an object')
    }
    const token = requireString(input.token, 'token')
    const workspaceId = requireString(input.workspaceId, 'workspaceId')
    const managerId = requireString(input.managerId, 'managerId')
    const actor = await this.#verifyActor(token, workspaceId)
    const scope = await this.#authorizeScope(token, workspaceId, managerId)
    const goals = await this.#readGoals(token, workspaceId, managerId)
    const now = this.#now()

    const goalSections = await Promise.all(goals.map(async (goal) => ({
      goal,
      tickets: await this.#readTickets(actor, workspaceId, goal.goalId, now),
    })))
    const memberStatuses = await Promise.all(scope.directMemberIds.map(async (memberId) =>
      this.#readMemberStatus(actor, workspaceId, memberId, now),
    ))

    return {
      workspaceId,
      managerId,
      observedAt: now,
      goals: goalSections,
      memberStatuses,
    }
  }

  async #verifyActor(token: string, workspaceId: string) {
    try {
      return await this.#accounts.verifySession(token, workspaceId)
    } catch (error) {
      if (errorCode(error) && AUTH_ERROR_CODES.has(errorCode(error)!)) {
        throw new BoardError('BOARD_UNAUTHORIZED', 'board query requires a verified session', { cause: error })
      }
      throw error
    }
  }

  async #authorizeScope(token: string, workspaceId: string, managerId: string) {
    let scope: ManagerScope | null
    try {
      scope = await this.#organization.readAuthorizedManagerScope({ token, workspaceId, managerId })
    } catch (error) {
      const code = errorCode(error)
      if (code && SCOPE_ERROR_CODES.has(code)) {
        throw new BoardError('BOARD_SCOPE_FORBIDDEN', 'caller cannot query this manager board', { cause: error })
      }
      throw error
    }
    if (!scope) {
      throw new BoardError('BOARD_SCOPE_FORBIDDEN', 'caller cannot query this manager board')
    }
    if (scope.workspaceId !== workspaceId || scope.managerId !== managerId) {
      throw new BoardError('BOARD_INVALID_RESPONSE', 'organization reader returned a different manager scope')
    }
    return scope
  }

  async #readGoals(
    token: string,
    workspaceId: string,
    managerId: string,
  ) {
    try {
      const goals = await this.#goals.listDirectForManager({ token, workspaceId, managerId })
      if (!Array.isArray(goals)) {
        throw new BoardError('BOARD_INVALID_RESPONSE', 'goals reader must return an array')
      }
      return goals
    } catch (error) {
      const code = errorCode(error)
      if (code && (
        code === 'GOAL_FORBIDDEN'
        || code === 'GOAL_WORKSPACE_NOT_FOUND'
        || code === 'AUTHENTICATION_REQUIRED'
        || code === 'UNAUTHENTICATED'
      )) {
        throw new BoardError(
          'BOARD_SCOPE_FORBIDDEN',
          'caller cannot read goals for this manager board',
          { cause: error },
        )
      }
      throw error
    }
  }

  async #readTickets(
    actor: Awaited<ReturnType<BoardAuthReader['verifySession']>>,
    workspaceId: string,
    goalId: string,
    now: number,
  ): Promise<GoalTicketTopFiveObservation> {
    try {
      return await this.#tickets.listForGoalTopFive(actor, workspaceId, goalId)
    } catch (error) {
      const code = errorCode(error)
      if (code && SCOPE_ERROR_CODES.has(code)) {
        throw new BoardError('BOARD_SCOPE_FORBIDDEN', 'caller cannot read one or more goals', { cause: error })
      }
      if (code && TICKET_SECTION_ERROR_CODES.has(code)) {
        return {
          goalId,
          items: [],
          freshness: 'unavailable',
          observedAt: now,
          errorRef: {
            code: code as TicketErrorCode,
            message: errorMessage(error),
          },
        }
      }
      throw error
    }
  }

  async #readMemberStatus(
    actor: Awaited<ReturnType<BoardAuthReader['verifySession']>>,
    workspaceId: string,
    memberId: string,
    now: number,
  ): Promise<MemberStatusObservation> {
    try {
      const observation = await this.#members.observeMember({ actor, workspaceId, memberId })
      if (!isRecord(observation) || typeof observation.source !== 'string') {
        throw new BoardError('BOARD_INVALID_RESPONSE', 'status reader must return an observation')
      }
      return {
        ...observation,
        subjectRef: { kind: 'member', workspaceId, memberId },
        freshness: observation.freshness ?? 'unknown',
        value: observation.value ?? 'unknown',
      }
    } catch (error) {
      const code = errorCode(error)
      if (code && MEMBER_STATUS_ERROR_CODES.has(code)) {
        return {
          subjectRef: { kind: 'member', workspaceId, memberId },
          source: 'status-provider',
          observedAt: now,
          freshness: 'unavailable',
          value: 'unknown',
          errorRef: {
            code,
            message: errorMessage(error),
          },
        }
      }
      if (error instanceof BoardError) throw error
      throw error
    }
  }
}

