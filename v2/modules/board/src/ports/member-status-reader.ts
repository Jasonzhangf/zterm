import type { BoardAuthContext } from './board-public-readers.ts'
import type { MemberStatusObservation } from '../domain/board-view.ts'

export interface MemberStatusReaderPort {
  observeMember(input: {
    actor: BoardAuthContext
    workspaceId: string
    memberId: string
  }): Promise<MemberStatusObservation>
}

