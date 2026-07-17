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
  return listOnlineTraversalRelayDaemonDevices(
    directoryDevices.length > 0
      ? directoryDevices
      : account.devices || [],
  );
}

export function readOnlineTraversalRelayDaemonDevices() {
  const account = readTraversalRelayAccountState();
  return projectOnlineTraversalRelayDaemonDevicesFromAccount(account);
}
