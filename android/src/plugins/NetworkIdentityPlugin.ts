import { Capacitor, registerPlugin } from "@capacitor/core";

import type { NetworkInterfaceFingerprint } from "../lib/network-identity";

export interface NetworkIdentitySnapshot {
  connected: boolean;
  connectionType: string;
  interfaces: NetworkInterfaceFingerprint[];
}

export interface NetworkIdentityPluginShape {
  snapshot(): Promise<NetworkIdentitySnapshot>;
}

const NetworkIdentityNative = registerPlugin<NetworkIdentityPluginShape>(
  "NetworkIdentity",
);

export function isNativeNetworkIdentitySupported() {
  return Capacitor.isNativePlatform();
}

export async function readNativeNetworkIdentitySnapshot(): Promise<NetworkInterfaceFingerprint[]> {
  if (!isNativeNetworkIdentitySupported()) {
    throw new Error('NetworkIdentity snapshot requires a native Android runtime');
  }
  const snapshot = await NetworkIdentityNative.snapshot();
  return snapshot.interfaces || [];
}

export const NetworkIdentityPlugin = NetworkIdentityNative;
