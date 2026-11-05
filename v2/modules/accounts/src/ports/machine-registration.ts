export interface MachineProof {
  deviceId: string
  deviceToken: string
}

export interface MachineIdentity {
  machineId: string
  ownerAccountId: string
}

export interface MachineSummary {
  machineId: string
  ownerAccountId: string
  legacyDeviceId: string
  displayName: string
  status: 'active' | 'revoked'
  createdAt: string
}

export interface MachineRevocation {
  machineId: string
  status: 'revoked'
}

/**
 * Machine authority boundary implemented over the V1 relay public endpoints:
 * `GET /api/machines`,
 * `POST /api/machines/enroll/challenge|verify`,
 * `POST /api/machines/possession/challenge|verify`, and
 * `POST /api/machines/:machineId/revoke`.
 *
 * Each call forwards the caller's bearer access token so the relay keeps the
 * single account/session/machine authority. Canonical machine status and the
 * account-scoped legacy device reference come from the relay response.
 */
export interface MachineRegistrationPort {
  listMachines(accessToken: string): Promise<MachineSummary[]>
  enroll(accessToken: string, proof: MachineProof, displayName?: string): Promise<MachineIdentity>
  verifyPossession(accessToken: string, machineId: string, deviceToken: string): Promise<MachineIdentity>
  revokeMachine(accessToken: string, machineId: string): Promise<MachineRevocation>
}
