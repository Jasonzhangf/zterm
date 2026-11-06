export interface RelayDirectoryDevice {
  deviceId: string
  deviceName: string
  platform: string
}

export interface RelayAccountDirectory {
  schemaVersion: 1
  user: {
    id: string
    username: string
  }
  devices: readonly RelayDirectoryDevice[]
  updatedAt: string
}

/**
 * Machine directory authority. The V1 relay already returns account-scoped
 * devices; this port only reads them (`GET /api/directory`). Cross-account
 * deviceId uniqueness is a server-side concern in the V1 gap list.
 */
export interface AccountDirectoryPort {
  getDirectory(accessToken: string): Promise<RelayAccountDirectory>
}
