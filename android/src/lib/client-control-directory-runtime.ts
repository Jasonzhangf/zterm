import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';
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
      authRequired: endpoint.authRequired,
      lastSeenAt: endpoint.lastSeenAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export class ClientControlDirectoryRuntime {
  private readonly entries = new Map<string, ClientControlDirectoryEntry>();

  public replaceFromDevices(devices: TraversalRelayDeviceSnapshot[]) {
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
