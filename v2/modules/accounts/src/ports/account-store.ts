import type { AccountRecord } from '../domain/accounts.ts'
import type { LoginSessionRecord } from '../domain/login-sessions.ts'
import type { MachineRecord } from '../domain/machines.ts'

/**
 * TEST DOUBLE contract only. This port exists so tests and local fixtures can
 * exercise the service logic without a live relay. It is NOT the account
 * authority.
 *
 * Production account, session, and machine truth is owned by the V1 relay
 * boundary (`RelayAuthPort`, `AccountDirectoryPort`,
 * `MachineRegistrationPort`). Do not wire this store into a formal consumer.
 */
export interface AccountStore {
  createAccount(record: AccountRecord): void
  findAccountByLoginName(loginName: string): AccountRecord | undefined
  findAccountById(accountId: string): AccountRecord | undefined
  createSession(record: LoginSessionRecord): void
  findSessionByTokenDigest(tokenDigest: string): LoginSessionRecord | undefined
  revokeSession(sessionId: string, revokedAt: string): boolean
  createMachine(record: MachineRecord): void
  findMachine(accountId: string, machineId: string): MachineRecord | undefined
  listMachines(accountId: string): readonly MachineRecord[]
}
