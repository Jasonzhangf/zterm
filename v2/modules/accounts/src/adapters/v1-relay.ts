import { AccountsError } from '../public/errors.ts'
import type { RelayAuthPort, RelayAuthSession, RelayRegistration } from '../ports/relay-authority.ts'
import type { AccountDirectoryPort, RelayAccountDirectory, RelayDirectoryDevice } from '../ports/account-directory.ts'
import type {
  MachineIdentity,
  MachineProof,
  MachineRegistrationPort,
  MachineRevocation,
  MachineSummary,
} from '../ports/machine-registration.ts'

export interface V1RelayAdapterOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

interface RelayUserBody {
  id?: unknown
  username?: unknown
}

interface RelayAuthBody {
  accessToken?: unknown
  user?: RelayUserBody
}

interface RelayRegisterBody {
  user?: RelayUserBody
}

interface RelayErrorDetail {
  code?: unknown
  message?: unknown
}

interface RelayErrorBody {
  message?: unknown
  error?: RelayErrorDetail | unknown
}

interface RelayDirectoryBody {
  schemaVersion?: unknown
  user?: RelayUserBody
  devices?: unknown
  updatedAt?: unknown
  directory?: RelayDirectoryBody
}

interface RelayChallengeBody {
  requestId?: unknown
  challenge?: unknown
  expiresAt?: unknown
}

interface RelayMachineIdentityBody {
  machineId?: unknown
  ownerAccountId?: unknown
}

interface RelayMachineRevokeBody {
  machineId?: unknown
  status?: unknown
}

interface RelayMachineListBody {
  machines?: unknown
}

const LOGIN_PATH = '/api/auth/login'
const REGISTER_PATH = '/api/auth/register'
const LOGOUT_PATH = '/api/auth/logout'
const ME_PATH = '/api/auth/me'
const DIRECTORY_PATH = '/api/directory'
const ENROLL_CHALLENGE_PATH = '/api/machines/enroll/challenge'
const ENROLL_VERIFY_PATH = '/api/machines/enroll/verify'
const POSSESSION_CHALLENGE_PATH = '/api/machines/possession/challenge'
const POSSESSION_VERIFY_PATH = '/api/machines/possession/verify'
const MACHINES_PATH = '/api/machines'

/**
 * Minimal HTTP boundary to the V1 relay account/machine endpoints.
 *
 * It implements the V2 account and machine ports over the V1 public relay
 * contract. The V1 relay remains the single account/session/directory/machine
 * authority; this adapter never stores a second copy of that truth.
 *
 * The adapter forwards the caller's bearer access token, so every machine
 * endpoint is authenticated and owner-scoped by the relay. Canonical
 * conflicts and rejections keep their upstream status classification:
 * 409 machine_already_owned, 403 machine_not_owned, 403 machine_revoked, and
 * 403 possession_invalid become typed AccountsError codes with the upstream
 * code and message preserved in `details`.
 */
export class V1RelayAdapter implements RelayAuthPort, AccountDirectoryPort, MachineRegistrationPort {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: V1RelayAdapterOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetchImpl ?? fetch
  }

  async register(username: string, password: string): Promise<RelayRegistration> {
    const response = await this.#request(REGISTER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await this.#readJson<RelayRegisterBody>(response)
    const id = body?.user && typeof body.user.id === 'string' ? body.user.id : ''
    if (id.length === 0) {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay registration response is missing the account',
      )
    }
    const loginName = body?.user && typeof body.user.username === 'string' && body.user.username.length > 0
      ? body.user.username
      : username
    return { accountId: id, loginName }
  }

  async authenticate(username: string, password: string): Promise<RelayAuthSession> {
    const response = await this.#request(LOGIN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await this.#readJson<RelayAuthBody>(response)
    return this.#toSession(body)
  }

  async validateSession(accessToken: string): Promise<RelayAuthSession> {
    const response = await this.#request(ME_PATH, {
      method: 'GET',
      headers: { authorization: `bearer ${accessToken}` },
    })
    const body = await this.#readJson<RelayAuthBody>(response)
    return this.#toSession(body, accessToken)
  }

  async logout(accessToken: string): Promise<void> {
    const response = await this.#request(LOGOUT_PATH, {
      method: 'POST',
      headers: { authorization: `bearer ${accessToken}` },
    })
    await this.#readJson<Record<string, unknown>>(response)
  }

  async getDirectory(accessToken: string): Promise<RelayAccountDirectory> {
    const response = await this.#request(DIRECTORY_PATH, {
      method: 'GET',
      headers: { authorization: `bearer ${accessToken}` },
    })
    const body = await this.#readJson<RelayDirectoryBody>(response)
    const directory = body?.directory && typeof body.directory === 'object' ? body.directory : body
    return this.#toDirectory(directory)
  }

  async listMachines(accessToken: string): Promise<MachineSummary[]> {
    const response = await this.#request(MACHINES_PATH, {
      method: 'GET',
      headers: { authorization: `bearer ${accessToken}` },
    })
    const body = await this.#readJson<RelayMachineListBody>(response)
    if (!Array.isArray(body?.machines)) {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay machine list response is missing machines',
      )
    }
    return body.machines.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AccountsError(
          'RELAY_PROTOCOL_ERROR',
          502,
          'relay machine list entry is invalid',
        )
      }
      const row = entry as Record<string, unknown>
      if (row.status !== 'active' && row.status !== 'revoked') {
        throw new AccountsError(
          'RELAY_PROTOCOL_ERROR',
          502,
          'relay machine list status is invalid',
        )
      }
      const legacyDeviceId = this.#requiredString(row.deviceId, 'machine list device id')
      return {
        machineId: this.#requiredString(row.machineId, 'machine list machine id'),
        ownerAccountId: this.#requiredString(row.ownerAccountId, 'machine list owner account id'),
        legacyDeviceId,
        displayName: typeof row.displayName === 'string' && row.displayName.length > 0
          ? row.displayName
          : legacyDeviceId,
        status: row.status,
        createdAt: this.#requiredString(row.createdAt, 'machine list createdAt'),
      }
    })
  }

  async enroll(
    accessToken: string,
    proof: MachineProof,
    displayName?: string,
  ): Promise<MachineIdentity> {
    const challenge = await this.#postJson<RelayChallengeBody>(ENROLL_CHALLENGE_PATH, accessToken, {
      deviceId: proof.deviceId,
    })
    const requestId = this.#requiredString(challenge?.requestId, 'enroll challenge request id')
    const challengeToken = this.#requiredString(challenge?.challenge, 'enroll challenge token')
    const verifyBody: Record<string, unknown> = {
      requestId,
      challenge: challengeToken,
      deviceToken: proof.deviceToken,
    }
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      verifyBody.displayName = displayName.trim()
    }
    const verified = await this.#postJson<RelayMachineIdentityBody>(ENROLL_VERIFY_PATH, accessToken, verifyBody)
    return this.#toMachineIdentity(verified)
  }

  async verifyPossession(
    accessToken: string,
    machineId: string,
    deviceToken: string,
  ): Promise<MachineIdentity> {
    const challenge = await this.#postJson<RelayChallengeBody>(
      POSSESSION_CHALLENGE_PATH,
      accessToken,
      { machineId },
    )
    const requestId = this.#requiredString(challenge?.requestId, 'possession challenge request id')
    const challengeToken = this.#requiredString(challenge?.challenge, 'possession challenge token')
    const verified = await this.#postJson<RelayMachineIdentityBody>(
      POSSESSION_VERIFY_PATH,
      accessToken,
      { requestId, challenge: challengeToken, deviceToken },
    )
    return this.#toMachineIdentity(verified)
  }

  async revokeMachine(accessToken: string, machineId: string): Promise<MachineRevocation> {
    const response = await this.#request(`${MACHINES_PATH}/${encodeURIComponent(machineId)}/revoke`, {
      method: 'POST',
      headers: { authorization: `bearer ${accessToken}` },
    })
    const body = await this.#readJson<RelayMachineRevokeBody>(response)
    const canonicalMachineId = this.#requiredString(body?.machineId, 'machine revoke machine id')
    if (body?.status !== 'revoked') {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay machine revoke response did not confirm revocation',
      )
    }
    return { machineId: canonicalMachineId, status: 'revoked' }
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`
  }

  async #postJson<T>(path: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.#request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    return await this.#readJson<T>(response)
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(this.#url(path), init)
    } catch (error) {
      throw this.#errorWithCause(
        'RELAY_TRANSPORT_ERROR',
        503,
        'relay transport failed',
        { cause: error instanceof Error ? error.message : String(error) },
        error,
      )
    }
  }

  async #readJson<T>(response: Response): Promise<T> {
    const upstreamStatus = response.status
    if (upstreamStatus === 401) {
      throw new AccountsError('AUTHENTICATION_REQUIRED', 401, undefined, { upstreamStatus })
    }
    if (upstreamStatus === 429) {
      throw new AccountsError(
        'RELAY_SERVICE_ERROR',
        429,
        'relay responded with status 429',
        { upstreamStatus: 429 },
      )
    }
    if (!response.ok) {
      const body = await this.#tryReadJson<RelayErrorBody>(response)
      if (upstreamStatus === 403 && body !== null) {
        throw this.#forbidden(body)
      }
      if (body === null) {
        throw new AccountsError(
          'RELAY_PROTOCOL_ERROR',
          502,
          'relay response was not valid JSON',
          { upstreamStatus },
        )
      }
      throw this.#upstreamError(upstreamStatus, body)
    }
    try {
      return (await response.json()) as T
    } catch (error) {
      throw this.#errorWithCause(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay response was not valid JSON',
        { cause: error instanceof Error ? error.message : String(error) },
        error,
      )
    }
  }

  #forbidden(body: RelayErrorBody | null): AccountsError {
    const upstreamCode = this.#errorCode(body)
    const upstreamMessage = this.#errorMessage(body)
    const details = this.#errorDetails(403, upstreamCode, upstreamMessage)
    switch (upstreamCode) {
      case 'machine_not_owned':
        return new AccountsError('MACHINE_NOT_OWNED', 403, upstreamMessage || 'machine_not_owned', details)
      case 'machine_revoked':
        return new AccountsError('MACHINE_REVOKED', 403, upstreamMessage || 'machine_revoked', details)
      case 'possession_invalid':
        return new AccountsError('POSSESSION_INVALID', 403, upstreamMessage || 'possession_invalid', details)
      case 'session_revoked':
        return new AccountsError('SESSION_REVOKED', 403, upstreamMessage || 'SESSION_REVOKED', details)
      default:
        return new AccountsError(
          'RELAY_PERMISSION_DENIED',
          403,
          upstreamMessage || 'RELAY_PERMISSION_DENIED',
          details,
        )
    }
  }

  #upstreamError(upstreamStatus: number, body: RelayErrorBody): AccountsError {
    const upstreamCode = this.#errorCode(body)
    const upstreamMessage = this.#errorMessage(body)
    const details = this.#errorDetails(upstreamStatus, upstreamCode, upstreamMessage)
    if (upstreamStatus === 400) {
      if (upstreamCode === 'invalid_machine_request') {
        return new AccountsError('INVALID_MACHINE_REQUEST', 400, upstreamMessage || 'INVALID_MACHINE_REQUEST', details)
      }
      if (/already exists/i.test(upstreamMessage)) {
        return new AccountsError('ACCOUNT_EXISTS', 409, 'ACCOUNT_EXISTS', details)
      }
      if (/required/i.test(upstreamMessage)) {
        return new AccountsError('INVALID_REQUEST', 400, 'INVALID_REQUEST', details)
      }
    }
    if (upstreamStatus === 404 && upstreamCode === 'machine_not_found') {
      return new AccountsError('MACHINE_NOT_FOUND', 404, upstreamMessage || 'machine_not_found', details)
    }
    if (upstreamStatus === 409) {
      if (upstreamCode === 'machine_already_owned') {
        return new AccountsError('MACHINE_ALREADY_OWNED', 409, upstreamMessage || 'machine_already_owned', details)
      }
      if (upstreamCode === 'machine_device_conflict') {
        return new AccountsError('MACHINE_DEVICE_CONFLICT', 409, upstreamMessage || 'machine_device_conflict', details)
      }
    }
    return new AccountsError(
      'RELAY_SERVICE_ERROR',
      502,
      `relay responded with status ${upstreamStatus}`,
      details,
    )
  }

  #errorCode(body: RelayErrorBody | null): string {
    if (!body || typeof body !== 'object') return ''
    const detail = body.error
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return ''
    return typeof (detail as RelayErrorDetail).code === 'string'
      ? (detail as RelayErrorDetail).code as string
      : ''
  }

  #errorMessage(body: RelayErrorBody | null): string {
    if (!body || typeof body !== 'object') return ''
    const detail = body.error
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const message = (detail as RelayErrorDetail).message
      if (typeof message === 'string') return message
    }
    return typeof body.message === 'string' ? body.message : ''
  }

  #errorDetails(
    upstreamStatus: number,
    upstreamCode: string,
    upstreamMessage: string,
  ): Readonly<Record<string, unknown>> {
    const details: Record<string, unknown> = { upstreamStatus }
    if (upstreamCode.length > 0) details.upstreamCode = upstreamCode
    if (upstreamMessage.length > 0) details.upstreamMessage = upstreamMessage
    return details
  }

  #requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        `relay machine response is missing the ${field}`,
      )
    }
    return value
  }

  #toMachineIdentity(body: RelayMachineIdentityBody): MachineIdentity {
    const machineId = typeof body?.machineId === 'string' ? body.machineId : ''
    const ownerAccountId = typeof body?.ownerAccountId === 'string' ? body.ownerAccountId : ''
    if (machineId.length === 0 || ownerAccountId.length === 0) {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay machine response is missing the canonical identity',
      )
    }
    return { machineId, ownerAccountId }
  }

  async #tryReadJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T
    } catch {
      return null
    }
  }

  #toSession(body: RelayAuthBody, callerToken?: string): RelayAuthSession {
    const accessToken = callerToken ?? (typeof body?.accessToken === 'string' ? body.accessToken : '')
    const id = body?.user && typeof body.user.id === 'string' ? body.user.id : ''
    if (accessToken.length === 0 || id.length === 0) {
      throw new AccountsError(
        'RELAY_PROTOCOL_ERROR',
        502,
        'relay auth response is missing the access token or account',
      )
    }
    const username = body?.user && typeof body.user.username === 'string' && body.user.username.length > 0
      ? body.user.username
      : id
    return { accessToken, accountId: id, loginName: username }
  }

  #toDirectory(body: RelayDirectoryBody): RelayAccountDirectory {
    if (body?.schemaVersion !== 1) {
      throw new AccountsError('RELAY_PROTOCOL_ERROR', 502, 'relay directory schema version is unsupported')
    }
    const id = body.user && typeof body.user.id === 'string' ? body.user.id : ''
    const username = body.user && typeof body.user.username === 'string' ? body.user.username : id
    if (id.length === 0) {
      throw new AccountsError('RELAY_PROTOCOL_ERROR', 502, 'relay directory response is missing the account')
    }
    const devices: RelayDirectoryDevice[] = Array.isArray(body.devices)
      ? body.devices
          .filter((device): device is Record<string, unknown> => Boolean(device) && typeof device === 'object')
          .map((device) => ({
            deviceId: typeof device.deviceId === 'string' ? device.deviceId : '',
            deviceName: typeof device.deviceName === 'string' ? device.deviceName : '',
            platform: typeof device.platform === 'string' ? device.platform : '',
          }))
          .filter((device) => device.deviceId.length > 0)
      : []
    const updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString()
    return {
      schemaVersion: 1,
      user: { id, username },
      devices,
      updatedAt,
    }
  }

  #errorWithCause(
    code: AccountsError['code'],
    status: AccountsError['status'],
    message: string,
    details?: Readonly<Record<string, unknown>>,
    cause: unknown,
  ): AccountsError {
    const error = new AccountsError(code, status, message, details)
    ;(error as { cause?: unknown }).cause = cause
    return error
  }
}
