import type { TraversalRelayDeviceSnapshot } from './types';
import { readTraversalRelayAccountState } from './traversal-relay-client';

export function countConnectedTraversalRelayDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected || device.client.connected).length;
}

export function listOnlineTraversalRelayDaemonDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected && device.daemon.hostId.trim().length > 0);
}

export function readOnlineTraversalRelayDaemonDevices() {
  return listOnlineTraversalRelayDaemonDevices(readTraversalRelayAccountState()?.devices || []);
}
