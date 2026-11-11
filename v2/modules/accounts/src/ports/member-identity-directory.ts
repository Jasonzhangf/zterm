/**
 * Read-only structural member lookup used to validate an explicit account to
 * member designation. Production composition injects organization's public
 * `getMember` reader; accounts never owns or mutates member records.
 */
export interface MemberIdentityDirectoryMember {
  readonly memberId: string
  readonly workspaceId: string
}

export interface MemberIdentityDirectoryPort {
  getMember(memberId: string): Promise<MemberIdentityDirectoryMember | null>
}
