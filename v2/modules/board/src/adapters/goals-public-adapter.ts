import { BoardError } from '../public/errors.ts'
import type { GoalView } from '../domain/board-view.ts'
import type { GoalsPublicAdapterPort } from '../ports/board-public-readers.ts'

/**
 * Board-owned read-only adapter over the real goals public port. The caller
 * token is passed through so goals owns authorization. Direct manager goals
 * are selected only by the declared `ownerMemberId` relationship; the goal
 * parent hierarchy is never used as a manager relation.
 */
export class GoalsPublicAdapter implements GoalsPublicAdapterPort {
  readonly #publicApi: {
    listGoals(input: {
      token: string
      workspaceId: string
      parentGoalId?: string
    }): Promise<Array<Record<string, unknown>>>
  }

  constructor(publicApi: unknown) {
    const candidate = publicApi as {
      listGoals?: (input: {
        token: string
        workspaceId: string
        parentGoalId?: string
      }) => Promise<Array<Record<string, unknown>>>
    }
    const listGoals = candidate?.listGoals
    if (typeof listGoals !== 'function') {
      throw new BoardError(
        'BOARD_INVALID_REQUEST',
        'goals public adapter requires a service with listGoals({ token, workspaceId, parentGoalId })',
      )
    }
    this.#publicApi = { listGoals }
  }

  async listGoals(input: {
    token: string
    workspaceId: string
    parentGoalId?: string
  }): Promise<Array<Record<string, unknown>>> {
    const { token, workspaceId } = input
    const goals = await this.#publicApi.listGoals({
      token,
      workspaceId,
      parentGoalId: input.parentGoalId,
    })
    if (!Array.isArray(goals)) {
      throw new BoardError(
        'BOARD_INVALID_RESPONSE',
        'goals public service must return an array from listGoals',
      )
    }
    return goals
  }

  listDirectForManager(input: {
    token: string
    workspaceId: string
    managerId: string
  }): Promise<GoalView[]> {
    return this.listGoals(input).then((goals) => {
      const managerGoals = goals.filter((goal) =>
        goal.workspaceId === input.workspaceId
        && goal.ownerMemberId === input.managerId,
      )
      return managerGoals.map((goal) => ({
        goalId: String(goal.goalId),
        workspaceId: String(goal.workspaceId),
        managerId: String(goal.ownerMemberId),
        title: String(goal.name ?? goal.title ?? ''),
        status: String(goal.status ?? ''),
      }))
    })
  }
}
