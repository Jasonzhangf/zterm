import type { AccountStore } from '../ports/account-store.ts'
import type { AccountRecord } from '../domain/accounts.ts'
import type { LoginSessionRecord } from '../domain/login-sessions.ts'
import type { MachineRecord } from '../domain/machines.ts'

/**
 * TEST DOUBLE only — not authority. Formal consumers must use the real V1
 * relay adapter (`V1RelayAdapter`). Do not use for production account,
 * session, or machine truth.
 *
 * It keeps Map-backed records so tests and local fixtures can exercise service
 * logic hermetically. It does not verify credentials, revalidate sessions, or
 * enforce machine lifecycle policy; those belong to the relay boundary.
 */
export class InMemoryAccountStore implements AccountStore {
  readonly #accountsById = new Map<string, AccountRecord>()
  readonly #accountsByLoginName = new Map<string, AccountRecord>()
  readonly #sessionsByTokenDigest = new Map<string, LoginSessionRecord>()
  readonly #machinesByAccount = new Map<string, Map<string, MachineRecord>>()

  createAccount(record: AccountRecord): void {
    this.#accountsById.set(record.accountId, record)
    this.#accountsByLoginName.set(record.loginName, record)
  }

  findAccountByLoginName(loginName: string): AccountRecord | undefined {
    return this.#accountsByLoginName.get(loginName)
  }

  findAccountById(accountId: string): AccountRecord | undefined {
    return this.#accountsById.get(accountId)
  }

  createSession(record: LoginSessionRecord): void {
    this.#sessionsByTokenDigest.set(record.tokenDigest, record)
  }

  findSessionByTokenDigest(tokenDigest: string): LoginSessionRecord | undefined {
    return this.#sessionsByTokenDigest.get(tokenDigest)
  }

  revokeSession(sessionId: string, revokedAt: string): boolean {
    for (const [tokenDigest, record] of this.#sessionsByTokenDigest) {
      if (record.sessionId !== sessionId) continue
      if (record.revokedAt) return false
      this.#sessionsByTokenDigest.set(tokenDigest, { ...record, revokedAt })
      return true
    }
    return false
  }

  createMachine(record: MachineRecord): void {
    let machines = this.#machinesByAccount.get(record.ownerAccountId)
    if (!machines) {
      machines = new Map()
      this.#machinesByAccount.set(record.ownerAccountId, machines)
    }
    machines.set(record.machineId, record)
  }

  findMachine(accountId: string, machineId: string): MachineRecord | undefined {
    return this.#machinesByAccount.get(accountId)?.get(machineId)
  }

  listMachines(accountId: string): readonly MachineRecord[] {
    return [...(this.#machinesByAccount.get(accountId) ?? new Map<string, MachineRecord>()).values()]
  }
}
