import { Capacitor, registerPlugin } from "@capacitor/core";

import { NetworkIdentitySnapshotError } from "../lib/network-identity";
import type { NetworkInterfaceFingerprint } from "../lib/network-identity";

export interface NetworkIdentitySnapshot {
  connected: boolean;
  connectionType: string;
  interfaces: NetworkInterfaceFingerprint[];
}

export interface NetworkIdentityPluginShape {
  snapshot(): Promise<NetworkIdentitySnapshot>;
}

export function requireNativeNetworkInterfaces(
  snapshot: Pick<NetworkIdentitySnapshot, "interfaces">,
): NetworkInterfaceFingerprint[] {
  if (!Array.isArray(snapshot.interfaces)) {
    throw new NetworkIdentitySnapshotError(
      "NetworkIdentity native snapshot returned invalid interfaces",
    );
  }
  return snapshot.interfaces;
}

const NetworkIdentityNative = registerPlugin<NetworkIdentityPluginShape>(
  "NetworkIdentity",
);

export function isNativeNetworkIdentitySupported() {
  return Capacitor.isNativePlatform();
}

export async function readNativeNetworkIdentitySnapshot(): Promise<NetworkInterfaceFingerprint[]> {
  if (!isNativeNetworkIdentitySupported()) {
    throw new NetworkIdentitySnapshotError(
      'NetworkIdentity snapshot requires a native Android runtime',
    );
  }
  const snapshot = await NetworkIdentityNative.snapshot();
  return requireNativeNetworkInterfaces(snapshot);
}

export const NetworkIdentityPlugin = NetworkIdentityNative;
