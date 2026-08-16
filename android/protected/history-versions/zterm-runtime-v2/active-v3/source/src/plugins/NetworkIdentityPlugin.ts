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
  {
    web: () => ({
      snapshot: async () => ({ connected: false, connectionType: "unknown", interfaces: [] }),
    }),
  },
);

export function isNativeNetworkIdentitySupported() {
  return Capacitor.isNativePlatform();
}

export async function readNativeNetworkIdentitySnapshot(): Promise<NetworkInterfaceFingerprint[]> {
  if (!isNativeNetworkIdentitySupported()) {
    return [];
  }
  try {
    const snapshot = await NetworkIdentityNative.snapshot();
    return snapshot.interfaces || [];
  } catch (error) {
    console.warn("[NetworkIdentity] native snapshot failed:", error);
    return [];
  }
}

export const NetworkIdentityPlugin = NetworkIdentityNative;