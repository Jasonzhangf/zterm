import { randomUUID } from 'node:crypto'
import type { AuthService } from './auth-service.ts'
import type { MachineService } from './machine-service.ts'
import { AccountsError } from '../public/errors.ts'

export interface MachineAuthorizationCapabilities {
  readonly transportKind: string
  readonly channelKinds: readonly AccountsLinkKind[]
  readonly [key: string]: unknown
}

export type AccountsLinkKind =
  | 'terminal'
  | 'message'
  | 'file'
  | 'receipt'
  | 'status'

export type AccountsTraversalPath =
  | 'lan'
  | 'tailscale'
  | 'ipv4'
  | 'ipv6'
  | 'rtc-direct'
  | 'rtc-relay'

export interface MachineAuthorizationTarget {
  readonly bridgeHost: string
  readonly bridgePort: number
  readonly authToken?: string
  readonly relayHostId?: string
  readonly daemonHostId?: string
  readonly tailscaleHost?: string
  readonly ipv6Host?: string
  readonly ipv4Host?: string
  readonly signalUrl?: string
  readonly transportMode?: 'auto' | 'websocket' | 'webrtc'
  readonly [key: string]: unknown
}

export interface MachineAuthorizationSettings {
  readonly signalUrl?: string
  readonly turnServerUrl?: string
  readonly turnUsername?: string
  readonly turnCredential?: string
  readonly transportMode?: 'auto' | 'websocket' | 'webrtc'
  readonly traversalRelay?: string
  readonly traversalPathPriority?: readonly AccountsTraversalPath[]
  readonly rtcIceTransportPolicy?: 'all' | 'relay'
  readonly [key: string]: unknown
}

export interface MachineAuthorizationRoute {
  readonly machineId: string
  readonly daemonHostId?: string
  readonly capabilities: MachineAuthorizationCapabilities
  readonly target: MachineAuthorizationTarget
  readonly settings: MachineAuthorizationSettings
}

/**
 * Typed accounts-owned view of the route configuration. The route owner keeps
 * the endpoint and connection material; accounts only reads the fields needed
 * to prove that the configured target is the canonical machine requested.
 */
export interface MachineRouteSource {
  get(machineId: string): Promise<MachineAuthorizationRoute | undefined>
}

export interface AuthorizedMachineLink {
  readonly machineId: string
  readonly daemonHostId: string
  readonly accountId: string
  /** Opaque authorization reference. It is not a bearer token. */
  readonly authorizationId: string
  readonly capabilities: MachineAuthorizationCapabilities
  readonly target: MachineAuthorizationTarget
  readonly settings: MachineAuthorizationSettings
}

export interface AccountsAuthorizationPort {
  authorizeMachine(machineId: string): Promise<AuthorizedMachineLink>
  authorizeCallerMachine(
    machineId: string,
    callerToken: string,
  ): Promise<AuthorizedMachineLink>
}

export interface AccountsAuthorizationOptions {
  /**
   * Explicit service credential for internal delivery-target authorization.
   * Browser machine actions must use `authorizeCallerMachine` instead.
   */
  token?: string
  authService: AuthService
  machineService: MachineService
  routes: MachineRouteSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validCapabilities(value: unknown): value is MachineAuthorizationCapabilities {
  return (
    isRecord(value) &&
    Array.isArray(value.channelKinds) &&
    value.channelKinds.every(
      (kind) =>
        kind === 'terminal' ||
        kind === 'message' ||
        kind === 'file' ||
        kind === 'receipt' ||
        kind === 'status',
    ) &&
    typeof value.transportKind === 'string' &&
    value.transportKind.length > 0
  )
}

function validTarget(value: unknown): value is MachineAuthorizationTarget {
  return (
    isRecord(value) &&
    typeof value.bridgeHost === 'string' &&
    value.bridgeHost.length > 0 &&
    typeof value.bridgePort === 'number' &&
    Number.isInteger(value.bridgePort) &&
    value.bridgePort > 0 &&
    (typeof value.transportMode !== 'string' ||
      value.transportMode === 'auto' ||
      value.transportMode === 'websocket' ||
      value.transportMode === 'webrtc')
  )
}

export class AccountsAuthorizationAdapter implements AccountsAuthorizationPort {
  readonly #token: string
  readonly #authService: AuthService
  readonly #machineService: MachineService
  readonly #routes: MachineRouteSource

  constructor(options: AccountsAuthorizationOptions) {
    this.#token = typeof options?.token === 'string' ? options.token : ''
    this.#authService = options.authService
    this.#machineService = options.machineService
    this.#routes = options.routes
  }

  async authorizeMachine(machineId: string): Promise<AuthorizedMachineLink> {
    const requestedMachineId = nonEmpty(machineId)
    if (requestedMachineId.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'machineId is required.')
    }
    const serviceToken = nonEmpty(this.#token)
    if (serviceToken.length === 0) {
      throw new AccountsError(
        'AUTHENTICATION_REQUIRED',
        401,
        'Service authorization is not configured.',
      )
    }
    return this.#authorizeMachineWithToken(requestedMachineId, serviceToken)
  }

  async authorizeCallerMachine(
    machineId: string,
    callerToken: string,
  ): Promise<AuthorizedMachineLink> {
    const token = nonEmpty(callerToken)
    if (token.length === 0) {
      throw new AccountsError('AUTHENTICATION_REQUIRED', 401)
    }
    const requestedMachineId = nonEmpty(machineId)
    if (requestedMachineId.length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, 'machineId is required.')
    }
    return this.#authorizeMachineWithToken(requestedMachineId, token)
  }

  async #authorizeMachineWithToken(
    requestedMachineId: string,
    token: string,
  ): Promise<AuthorizedMachineLink> {
    const authContext = await this.#authService.verifySession(token)
    const authorizedMachines = await this.#machineService.listAuthorizedMachines(
      token,
    )
    const machine = authorizedMachines.find(
      (candidate) => candidate.machineId === requestedMachineId,
    )
    if (!machine || machine.ownerAccountId !== authContext.accountId) {
      throw new AccountsError('MACHINE_NOT_FOUND', 404, 'Machine is not authorized.')
    }
    if (machine.status !== 'active') {
      throw new AccountsError('MACHINE_REVOKED', 403, 'Machine is revoked.')
    }

    const route = await this.#routes.get(requestedMachineId)
    if (!route || route.machineId !== requestedMachineId) {
      throw new AccountsError('MACHINE_NOT_FOUND', 404, 'Machine route is not authorized.')
    }
    if (!validCapabilities(route.capabilities) || !validTarget(route.target) || !isRecord(route.settings)) {
      throw new AccountsError(
        'INVALID_REQUEST',
        400,
        'Machine route configuration is invalid.',
      )
    }

    const routeDaemonHostId = nonEmpty(route.daemonHostId)
    const targetDaemonHostId = nonEmpty(route.target.daemonHostId)
    if (
      routeDaemonHostId.length === 0 ||
      targetDaemonHostId.length === 0 ||
      routeDaemonHostId !== targetDaemonHostId
    ) {
      throw new AccountsError(
        'MACHINE_IDENTITY_UNVERIFIED',
        403,
        'Machine identity proof is missing or inconsistent.',
        { proof: 'daemon-host-id', verified: false },
      )
    }

    return {
      machineId: machine.machineId,
      daemonHostId: routeDaemonHostId,
      accountId: authContext.accountId,
      authorizationId: `authz_${randomUUID()}`,
      capabilities: route.capabilities,
      target: route.target,
      settings: route.settings,
    }
  }
}

export function createAccountsAuthorizationPort(
  options: AccountsAuthorizationOptions,
): AccountsAuthorizationPort {
  return new AccountsAuthorizationAdapter(options)
}
