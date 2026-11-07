import { BoardError } from '../public/errors.ts'
import type {
  BoardOrganizationReader,
  ManagerScope,
  OrganizationAuthorizedManagerInput,
} from '../ports/board-public-readers.ts'

/**
 * Board-owned read-only adapter over the real organization public port. It
 * passes the caller token through `listDirectReports({ token, workspaceId,
 * managerMemberId })` so organization owns workspace authorization, manager
 * allowlist filtering and the explicit `member.managerMemberId` relation.
 * Board never infers a management relation from group hierarchy.
 */
export class OrganizationPublicAdapter implements BoardOrganizationReader {
  readonly #publicApi: {
    listDirectReports(input: {
      token: string
      workspaceId: string
      managerMemberId: string
    }): Promise<Record<string, unknown>>
  }

  constructor(publicApi: unknown) {
    const candidate = publicApi as {
      listDirectReports?: (input: {
        token: string
        workspaceId: string
        managerMemberId: string
      }) => Promise<Record<string, unknown>>
    }
    const listDirectReports = candidate?.listDirectReports
    if (typeof listDirectReports !== 'function') {
      throw new BoardError(
        'BOARD_INVALID_REQUEST',
        'organization public adapter requires a service with listDirectReports({ token, workspaceId, managerMemberId })',
      )
    }
    this.#publicApi = { listDirectReports }
  }

  async readAuthorizedManagerScope(
    input: OrganizationAuthorizedManagerInput,
  ): Promise<ManagerScope | null> {
    const { token, workspaceId, managerId } = input
    let reports: Record<string, unknown>
    try {
      reports = await this.#publicApi.listDirectReports({
        token,
        workspaceId,
        managerMemberId: managerId,
      })
    } catch (error) {
      // `MEMBER_NOT_FOUND` means the requested manager does not exist in the
      // workspace. Other typed failures (auth, allowlist, workspace) propagate
      // to the manager board reader, which maps them to BOARD_SCOPE_FORBIDDEN.
      if (errorCode(error) === 'MEMBER_NOT_FOUND') return null
      throw error
    }

    if (reports?.workspaceId !== workspaceId || reports?.managerMemberId !== managerId) {
      throw new BoardError(
        'BOARD_INVALID_RESPONSE',
        'organization listDirectReports returned a different manager scope',
      )
    }
    const directMemberIds = reports.directMemberIds
    if (
      !Array.isArray(directMemberIds)
      || directMemberIds.some((memberId) => typeof memberId !== 'string')
    ) {
      throw new BoardError(
        'BOARD_INVALID_RESPONSE',
        'organization listDirectReports must return a directMemberIds string array',
      )
    }
    return {
      workspaceId,
      managerId,
      directMemberIds: directMemberIds as string[],
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object'
    && error !== null
    && typeof (error as Record<string, unknown>).code === 'string'
    ? (error as Record<string, unknown>).code as string
    : undefined
}
