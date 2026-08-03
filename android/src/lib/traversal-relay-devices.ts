import type { TraversalRelayDeviceSnapshot } from './types';
import { readTraversalRelayAccountState, type TraversalRelayAccountState } from './traversal-relay-client';
import { projectRelayDirectoryDeviceSnapshots } from './relay-account-directory';

export function countConnectedTraversalRelayDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected || device.client.connected).length;
}

export function isOnlineTraversalRelayDaemonDevice(device: TraversalRelayDeviceSnapshot) {
  return device.daemon.connected && device.daemon.hostId.trim().length > 0;
}

export function listOnlineTraversalRelayDaemonDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter(isOnlineTraversalRelayDaemonDevice);
}

export function projectOnlineTraversalRelayDaemonDevicesFromAccount(
  account: TraversalRelayAccountState | null | undefined,
) {
  if (!account) {
    return [];
  }
  const directoryDevices = projectRelayDirectoryDeviceSnapshots(account.directory);
  const accountDevices = account.devices || [];
  if (directoryDevices.length === 0) {
    return listOnlineTraversalRelayDaemonDevices(accountDevices);
  }

  // `/api/auth/me` and the live directory stream carry the same control-plane
  // resource, but older clients can persist a partial directory containing
  // client-only rows. Preserve an online daemon row from the account snapshot
  // only when the directory has no daemon identity for that device. A directory
  // row that explicitly identifies a daemon remains authoritative, including
  // its disconnected state.
  const directoryByDeviceId = new Map(directoryDevices.map((device) => [device.deviceId, device]));
  const merged = [...directoryDevices];
  for (const accountDevice of accountDevices) {
    if (!isOnlineTraversalRelayDaemonDevice(accountDevice)) {
      continue;
    }
    const directoryDevice = directoryByDeviceId.get(accountDevice.deviceId);
    if (directoryDevice?.daemon.hostId.trim()) {
      continue;
    }
    if (!directoryDevice) {
      merged.push(accountDevice);
      continue;
    }
    const index = merged.indexOf(directoryDevice);
    if (index >= 0) {
      merged[index] = accountDevice;
    }
  }
  return listOnlineTraversalRelayDaemonDevices(merged);
}

export function readOnlineTraversalRelayDaemonDevices() {
  const account = readTraversalRelayAccountState();
  return projectOnlineTraversalRelayDaemonDevicesFromAccount(account);
}
