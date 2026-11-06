import { toMachineRef, type MachineRef } from '../domain/machines.ts'
import type { AuthContext } from '../domain/accounts.ts'
import type { MachineRegistrationPort } from '../ports/machine-registration.ts'
import { AccountsError } from '../public/errors.ts'

export interface MachineServiceOptions {
  machineReg: MachineRegistrationPort
  verifySession: (token: string) => AuthContext | Promise<AuthContext>
  now?: () => number
}

export interface EnrollMachineInput {
  deviceId: string
  deviceToken: string
  displayName?: string
}

export interface VerifyMachinePossessionInput {
  machineId: string
  deviceToken: string
}

export interface RevokeMachineInput {
  machineId: string
}

/**
 * Machine use cases backed by the V1 relay machine endpoints.
 *
 * Listing reads the account-scoped canonical machine directory. Enrollment and
 * possession verify drive the relay challenge/verify endpoints with the
 * caller's bearer token, and revoke is owner-only at the relay. The relay is
 * the single machine authority: same-account legacy device names remain only
 * an explicit compatibility reference and never become canonical identity.
 * Cross-account proof conflicts and rejected possession stay relay decisions
 * surfaced as typed errors.
 */
export class MachineService {
  readonly #machineReg: MachineRegistrationPort
  readonly #verifySession: (token: string) => AuthContext | Promise<AuthContext>
  readonly #now: () => number

  constructor(options: MachineServiceOptions) {
    this.#machineReg = options.machineReg
    this.#verifySession = options.verifySession
    this.#now = options.now ?? Date.now
  }

  async listAuthorizedMachines(token: string): Promise<MachineRef[]> {
    const authContext = await this.#verifySession(token)
    const machines = await this.#machineReg.listMachines(authContext.sessionId)
    return machines.map((machine) =>
      toMachineRef(
        {
          machineId: machine.machineId,
          deviceName: machine.displayName,
          legacyDeviceId: machine.legacyDeviceId,
        },
        machine.ownerAccountId,
        machine.createdAt,
        machine.status,
      ),
    )
  }

  async enrollMachine(token: string, input: EnrollMachineInput): Promise<MachineRef> {
    const authContext = await this.#verifySession(token)

    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId.trim() : ''
    if (deviceId.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Machine device ID is required.')
    }

    const deviceToken = typeof input?.deviceToken === 'string' ? input.deviceToken : ''
    if (deviceToken.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Device proof-of-possession material is required.')
    }

    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
    const enrollment = await this.#machineReg.enroll(
      authContext.sessionId,
      { deviceId, deviceToken },
      displayName.length > 0 ? displayName : undefined,
    )
    return toMachineRef(
      {
        machineId: enrollment.machineId,
        deviceName: displayName.length > 0 ? displayName : enrollment.machineId,
        legacyDeviceId: deviceId,
      },
      enrollment.ownerAccountId,
      new Date(this.#now()).toISOString(),
    )
  }

  async verifyMachinePossession(token: string, input: VerifyMachinePossessionInput): Promise<MachineRef> {
    const authContext = await this.#verifySession(token)

    const machineId = typeof input?.machineId === 'string' ? input.machineId.trim() : ''
    if (machineId.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Machine ID is required.')
    }

    const deviceToken = typeof input?.deviceToken === 'string' ? input.deviceToken : ''
    if (deviceToken.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Device proof-of-possession material is required.')
    }

    const possession = await this.#machineReg.verifyPossession(authContext.sessionId, machineId, deviceToken)
    return toMachineRef(
      {
        machineId: possession.machineId,
        deviceName: possession.machineId,
      },
      possession.ownerAccountId,
      new Date(this.#now()).toISOString(),
    )
  }

  async revokeMachine(token: string, input: RevokeMachineInput): Promise<MachineRef> {
    const authContext = await this.#verifySession(token)

    const machineId = typeof input?.machineId === 'string' ? input.machineId.trim() : ''
    if (machineId.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'Machine ID is required.')
    }

    const revocation = await this.#machineReg.revokeMachine(authContext.sessionId, machineId)
    return toMachineRef(
      {
        machineId: revocation.machineId,
        deviceName: revocation.machineId,
      },
      authContext.accountId,
      new Date(this.#now()).toISOString(),
      'revoked',
    )
  }

  async grantMachineAccess(token: string, _input: { machineId: string; granteeAccountId: string }): Promise<never> {
    await this.#verifySession(token)
    throw new AccountsError('CROSS_ACCOUNT_ACCESS_DISABLED', 403, 'Cross-account machine access is disabled.')
  }

  async revokeMachineAccess(token: string, _input: { machineId: string; granteeAccountId: string }): Promise<never> {
    await this.#verifySession(token)
    throw new AccountsError('CROSS_ACCOUNT_ACCESS_DISABLED', 403, 'Cross-account machine access is disabled.')
  }
}
