import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';
import type { TraversalRelayClientSettings } from './bridge-settings';
import type { Host, TraversalRelayDeviceSnapshot } from './types';

export interface ClientControlDirectoryEntry {
  daemonHostId: string;
  generation: number;
  endpoints: RelayEndpointCandidate[];
  updatedAt: string;
}

function cloneEndpoints(endpoints: RelayEndpointCandidate[]) {
  return endpoints.map((endpoint) => ({ ...endpoint }));
}

function endpointTruthKey(endpoints: RelayEndpointCandidate[]) {
  return JSON.stringify([...endpoints]
    .map((endpoint) => ({
      id: endpoint.id,
      kind: endpoint.kind,
      host: endpoint.host || '',
      port: endpoint.port || 0,
      wsUrl: endpoint.wsUrl || '',
      relayHostId: endpoint.relayHostId || '',
      authToken: endpoint.authToken || '',
      authRequired: endpoint.authRequired,
      lastSeenAt: endpoint.lastSeenAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export class ClientControlDirectoryRuntime {
  private readonly entries = new Map<string, ClientControlDirectoryEntry>();

  private readonly listeners = new Set<() => void>();

  private confirmed = false;

  private confirmationGeneration = 0;

  private relaySettings: TraversalRelayClientSettings | null = null;

  public replaceFromDevices(
    devices: TraversalRelayDeviceSnapshot[],
    relaySettings?: TraversalRelayClientSettings,
  ) {
    const nextHostIds = new Set<string>();
    for (const device of devices) {
      const daemonHostId = device.daemon.hostId.trim();
      const endpoints = device.daemon.endpoints || [];
      if (!device.daemon.connected || !daemonHostId || endpoints.length === 0) {
        continue;
      }
      nextHostIds.add(daemonHostId);
      const existing = this.entries.get(daemonHostId) || null;
      const endpointsChanged = !existing
        || endpointTruthKey(existing.endpoints) !== endpointTruthKey(endpoints);
      this.entries.set(daemonHostId, {
        daemonHostId,
        generation: existing
          ? existing.generation + (endpointsChanged ? 1 : 0)
          : 1,
        endpoints: cloneEndpoints(endpoints),
        updatedAt: device.daemon.lastSeenAt,
      });
    }
    for (const daemonHostId of this.entries.keys()) {
      if (!nextHostIds.has(daemonHostId)) {
        this.entries.delete(daemonHostId);
      }
    }
    this.confirmed = true;
    this.confirmationGeneration += 1;
    if (relaySettings) {
      this.relaySettings = { ...relaySettings };
    }
    this.notify();
  }

  public markUnconfirmed() {
    this.confirmed = false;
    this.entries.clear();
    this.confirmationGeneration += 1;
    this.notify();
  }

  public isConfirmed() {
    return this.confirmed;
  }

  public readRelaySettings() {
    return this.relaySettings ? { ...this.relaySettings } : null;
  }

  public readStatus(daemonHostId?: string | null) {
    const normalizedDaemonHostId = daemonHostId?.trim() || '';
    return {
      confirmed: this.confirmed,
      generation: this.confirmationGeneration,
      daemonHostId: normalizedDaemonHostId || null,
      targetPresent: normalizedDaemonHostId
        ? this.entries.has(normalizedDaemonHostId)
        : null,
      knownDaemonHostIds: [...this.entries.keys()].sort(),
    };
  }

  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public read(daemonHostId: string) {
    const entry = this.entries.get(daemonHostId.trim()) || null;
    return entry
      ? {
          ...entry,
          endpoints: cloneEndpoints(entry.endpoints),
        }
      : null;
  }

  public clear() {
    this.entries.clear();
    this.confirmed = false;
    this.relaySettings = null;
    this.confirmationGeneration += 1;
    this.notify();
  }
}

export function mergeHostWithClientControlDirectory(
  host: Host,
  runtime: Pick<ClientControlDirectoryRuntime, 'read'>,
): Host {
  const daemonHostId = host.daemonHostId?.trim() || host.relayHostId?.trim() || '';
  if (!daemonHostId) {
    return host;
  }
  const entry = runtime.read(daemonHostId);
  if (!entry) {
    return host;
  }
  return {
    ...host,
    relayEndpointCandidates: entry.endpoints,
  };
}

export const defaultClientControlDirectoryRuntime = new ClientControlDirectoryRuntime();
