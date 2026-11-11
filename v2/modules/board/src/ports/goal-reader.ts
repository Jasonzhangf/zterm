import type { GoalView } from '../domain/board-view.ts'

export interface GoalReaderPort {
  listDirectForManager(input: {
    token: string
    workspaceId: string
    managerId: string
  }): Promise<GoalView[]>
}

