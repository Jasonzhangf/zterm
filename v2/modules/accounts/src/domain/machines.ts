export interface MachineRecord {
  machineId: string
  ownerAccountId: string
  displayName: string
  status: 'active' | 'revoked'
  createdAt: string
}

export interface MachineRef {
  machineId: string
  ownerAccountId: string
  displayName: string
  status: 'active' | 'revoked'
  createdAt: string
  legacyDeviceId?: string
}

/**
 * Structural shape accepted by {@link toMachineRef}; a canonical relay machine
 * is the production source, and a directory device can remain an explicit
 * account-scoped compatibility reference.
 */
export interface MachineRefSource {
  machineId: string
  deviceName?: string
  platform?: string
  legacyDeviceId?: string
}

export function toMachineRef(
  source: MachineRefSource,
  ownerAccountId: string,
  createdAt: string,
  status: MachineRef['status'] = 'active',
): MachineRef {
  const displayName =
    typeof source.deviceName === 'string' && source.deviceName.trim().length > 0
      ? source.deviceName
      : source.machineId
  return {
    machineId: source.machineId,
    ownerAccountId,
    displayName,
    status,
    createdAt,
    ...(source.legacyDeviceId ? { legacyDeviceId: source.legacyDeviceId } : {}),
  }
}
