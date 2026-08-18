/**
 * Client-owned network identity truth: a monotonically increasing generation
 * that changes whenever the phone's active network fingerprint changes
 * (connection type, or the set of local WiFi/cellular/VPN interfaces and
 * their addresses).
 *
 * Ownership: `client.daemon_connection` -> `resource.platform_network_signal`.
 * This module is client-only truth. The daemon must never receive WiFi,
 * cellular, Tailscale, or interface/IP state; it only consumes the bounded
 * probe/reconnect consequences of a generation change.
 */

export interface NetworkInterfaceFingerprint {
  /** Stable interface name, e.g. `wlan0`, `rmnet_data0`, `tun0`. */
  name: string;
  /** Hash of the interface's IPv4+IPv6 address set (empty when unavailable). */
  addressesSignature: string;
  /** True when the interface is a VPN/Tailscale tunnel. */
  vpn: boolean;
}

export interface NetworkFingerprint {
  connected: boolean;
  /** `wifi` | `cellular` | `ethernet` | `none` | `unknown` (Capacitor). */
  connectionType: string;
  /** Local interface snapshot. Web/unit environments degrade to `[]`. */
  interfaces: NetworkInterfaceFingerprint[];
}

export interface NetworkIdentitySample {
  fingerprint: NetworkFingerprint;
  generation: number;
  fingerprintChanged: boolean;
}

export interface NetworkIdentityRuntime {
  readGeneration(): number;
  readFingerprint(): NetworkFingerprint | null;
  /** Sync path for Capacitor/window network events; interfaces are reused. */
  ingestNetworkStatus(input: { connected: boolean; connectionType: string }): NetworkIdentitySample;
  /** Async path for foreground resume: re-collects local interfaces. */
  resample(): Promise<NetworkIdentitySample>;
  /**
   * Foreground-resume path: re-reads the platform status AND re-collects local
   * interfaces, comparing both against the previous fingerprint in one step.
   * Backgrounded network changes that were dropped while hidden are recovered
   * here.
   */
  resampleWithStatus(input: { connected: boolean; connectionType: string }): Promise<NetworkIdentitySample>;
}

export interface NetworkIdentityRuntimeOptions {
  sampleInterfaces?: () => Promise<NetworkInterfaceFingerprint[]> | NetworkInterfaceFingerprint[];
}

/**
 * Explicit control-plane failure for the ephemeral platform network signal.
 * Native snapshot absence, malformed snapshots, and sample-interfaces failures
 * must reach the client.daemon_connection error chain instead of being
 * replaced with an empty or stale network fingerprint.
 */
export class NetworkIdentitySnapshotError extends Error {
  readonly kind: 'TargetNetworkProbeError04NativeSnapshot';

  constructor(message: string) {
    super(message);
    this.name = 'NetworkIdentitySnapshotError';
    this.kind = 'TargetNetworkProbeError04NativeSnapshot';
  }
}

export function projectNetworkIdentitySnapshotError(error: unknown): NetworkIdentitySnapshotError {
  if (error instanceof NetworkIdentitySnapshotError) {
    return error;
  }
  return new NetworkIdentitySnapshotError(
    error instanceof Error ? error.message : String(error),
  );
}

function fingerprintEquals(left: NetworkFingerprint, right: NetworkFingerprint) {
  if (left.connected !== right.connected || left.connectionType !== right.connectionType) {
    return false;
  }
  if (left.interfaces.length !== right.interfaces.length) {
    return false;
  }
  const leftKeys = left.interfaces
    .map((entry) => `${entry.name}|${entry.vpn ? 'vpn' : 'net'}|${entry.addressesSignature}`)
    .sort();
  const rightKeys = right.interfaces
    .map((entry) => `${entry.name}|${entry.vpn ? 'vpn' : 'net'}|${entry.addressesSignature}`)
    .sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function sanitizeConnectionType(connectionType: string | undefined | null) {
  const trimmed = (connectionType || '').trim().toLowerCase();
  return trimmed || 'unknown';
}

function isKnownConnectionType(connectionType: string) {
  return connectionType !== 'unknown';
}

export function createNetworkIdentityRuntime(options: NetworkIdentityRuntimeOptions = {}): NetworkIdentityRuntime {
  let generation = 0;
  let fingerprint: NetworkFingerprint | null = null;

  const sampleInterfaces = options.sampleInterfaces;

  const compareAndAdvance = (next: NetworkFingerprint): NetworkIdentitySample => {
    const fingerprintChanged = !fingerprint || !fingerprintEquals(fingerprint, next);
    if (fingerprintChanged) {
      generation += 1;
      fingerprint = next;
    }
    return {
      fingerprint: next,
      generation,
      fingerprintChanged,
    };
  };

  const completeProvisionalStatus = (
    next: NetworkFingerprint,
  ): NetworkIdentitySample | null => {
    // App startup samples interfaces before Capacitor reports the concrete
    // transport. Completing that provisional status is not a new network.
    if (
      !fingerprint
      || fingerprint.connectionType !== 'unknown'
      || !isKnownConnectionType(next.connectionType)
      || fingerprint.connected !== next.connected
      || !fingerprintEquals(fingerprint, { ...next, connectionType: 'unknown' })
    ) {
      return null;
    }
    fingerprint = next;
    return {
      fingerprint: next,
      generation,
      fingerprintChanged: false,
    };
  };

  const completeProvisionalInterfaces = (
    next: NetworkFingerprint,
  ): NetworkIdentitySample | null => {
    // Interface enumeration may lag the status callback. Enrich the same
    // confirmed generation without treating the newly observed addresses as
    // a route change.
    if (
      !fingerprint
      || fingerprint.connectionType === 'unknown'
      || fingerprint.connected !== next.connected
      || fingerprint.interfaces.length !== 0
      || next.interfaces.length === 0
      || fingerprint.connectionType !== next.connectionType
    ) {
      return null;
    }
    fingerprint = next;
    return {
      fingerprint: next,
      generation,
      fingerprintChanged: false,
    };
  };

  const resolveStatusForExistingFingerprint = (
    input: { connected: boolean; connectionType: string },
  ) => {
    const connectionType = sanitizeConnectionType(input.connectionType);
    if (
      connectionType === 'unknown'
      && fingerprint?.connectionType
      && fingerprint.connectionType !== 'unknown'
    ) {
      return fingerprint.connectionType;
    }
    return connectionType;
  };

  const requireNativeSampler = () => {
    if (!sampleInterfaces) {
      throw new NetworkIdentitySnapshotError(
        'NetworkIdentity native snapshot capability is not active',
      );
    }
    return sampleInterfaces;
  };

  return {
    readGeneration: () => generation,
    readFingerprint: () => fingerprint,
    ingestNetworkStatus: (input) => {
      const next: NetworkFingerprint = {
        connected: Boolean(input.connected),
        connectionType: resolveStatusForExistingFingerprint(input),
        interfaces: fingerprint?.interfaces || [],
      };
      return completeProvisionalStatus(next) || compareAndAdvance(next);
    },
    resample: async () => {
      const sampler = requireNativeSampler();
      const interfaces = Array.isArray(sampler) ? sampler : await sampler();
      const next: NetworkFingerprint = {
        connected: fingerprint?.connected ?? true,
        connectionType: fingerprint?.connectionType || 'unknown',
        interfaces,
      };
      return completeProvisionalInterfaces(next) || compareAndAdvance(next);
    },
    resampleWithStatus: async (input) => {
      const sampler = requireNativeSampler();
      const interfaces = Array.isArray(sampler) ? sampler : await sampler();
      const next: NetworkFingerprint = {
        connected: Boolean(input.connected),
        connectionType: resolveStatusForExistingFingerprint(input),
        interfaces,
      };
      return completeProvisionalStatus(next) || compareAndAdvance(next);
    },
  };
}
