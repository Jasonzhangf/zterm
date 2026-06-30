import type { TraversalRelayDeviceSnapshot } from './types';
import { readTraversalRelayAccountState } from './traversal-relay-client';
import { projectRelayDirectoryDeviceSnapshots } from './relay-account-directory';

export function countConnectedTraversalRelayDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected || device.client.connected).length;
}

export function listOnlineTraversalRelayDaemonDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected && device.daemon.hostId.trim().length > 0);
}

export function readOnlineTraversalRelayDaemonDevices() {
  const account = readTraversalRelayAccountState();
  const directoryDevices = projectRelayDirectoryDeviceSnapshots(account?.directory);
  return listOnlineTraversalRelayDaemonDevices(
    directoryDevices.length > 0
      ? directoryDevices
      : account?.devices || [],
  );
}
