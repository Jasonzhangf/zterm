import type { RuntimeDebugLogEntry } from '../lib/types';

export interface TraversalRelayClientDebugSnapshotRecord {
  deviceId: string;
  receivedAt: string;
  requestId?: string;
  reason?: string;
  snapshot: unknown;
}

export interface TraversalRelayClientDebugLogRecord extends RuntimeDebugLogEntry {
  deviceId: string;
  ingestedAt: string;
}

interface DeviceDebugState {
  logs: TraversalRelayClientDebugLogRecord[];
  latestSnapshot: TraversalRelayClientDebugSnapshotRecord | null;
}

interface ListDebugLogsOptions {
  deviceId: string;
  limit?: number;
  scopeIncludes?: string;
}

const MAX_LOGS_PER_DEVICE = 500;
const MAX_LOG_QUERY_LIMIT = 500;

export class TraversalRelayClientDebugStore {
  private readonly userDevices = new Map<string, Map<string, DeviceDebugState>>();

  private getDeviceState(userId: string, deviceId: string) {
    let devices = this.userDevices.get(userId);
    if (!devices) {
      devices = new Map();
      this.userDevices.set(userId, devices);
    }
    let state = devices.get(deviceId);
    if (!state) {
      state = { logs: [], latestSnapshot: null };
      devices.set(deviceId, state);
    }
    return state;
  }

  appendLogs(userId: string, deviceId: string, entries: RuntimeDebugLogEntry[]) {
    const normalizedDeviceId = deviceId.trim();
    if (!userId.trim() || !normalizedDeviceId) {
      return;
    }
    const state = this.getDeviceState(userId, normalizedDeviceId);
    const ingestedAt = new Date().toISOString();
    for (const entry of entries) {
      if (!entry || typeof entry.scope !== 'string') {
        continue;
      }
      state.logs.push({
        deviceId: normalizedDeviceId,
        ingestedAt,
        seq: typeof entry.seq === 'number' ? entry.seq : 0,
        ts: typeof entry.ts === 'string' ? entry.ts : ingestedAt,
        scope: entry.scope,
        payload: typeof entry.payload === 'string' ? entry.payload : undefined,
      });
    }
    const overflow = state.logs.length - MAX_LOGS_PER_DEVICE;
    if (overflow > 0) {
      state.logs.splice(0, overflow);
    }
  }

  setSnapshot(userId: string, deviceId: string, snapshot: {
    requestId?: string;
    reason?: string;
    snapshot: unknown;
  }) {
    const normalizedDeviceId = deviceId.trim();
    if (!userId.trim() || !normalizedDeviceId) {
      return;
    }
    const state = this.getDeviceState(userId, normalizedDeviceId);
    state.latestSnapshot = {
      deviceId: normalizedDeviceId,
      receivedAt: new Date().toISOString(),
      requestId: snapshot.requestId?.trim() || undefined,
      reason: snapshot.reason?.trim() || undefined,
      snapshot: snapshot.snapshot,
    };
  }

  getSnapshot(userId: string, deviceId: string) {
    return this.userDevices.get(userId)?.get(deviceId)?.latestSnapshot || null;
  }

  listLogs(userId: string, options: ListDebugLogsOptions) {
    const normalizedDeviceId = options.deviceId.trim();
    const state = this.userDevices.get(userId)?.get(normalizedDeviceId);
    if (!state) {
      return [];
    }
    const scopeIncludes = options.scopeIncludes?.trim().toLowerCase() || '';
    const filtered = scopeIncludes
      ? state.logs.filter((entry) => entry.scope.toLowerCase().includes(scopeIncludes))
      : state.logs;
    const limit = Math.max(1, Math.min(MAX_LOG_QUERY_LIMIT, Math.floor(options.limit || 200)));
    return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
  }

  listDeviceSummaries(userId: string) {
    const devices = this.userDevices.get(userId);
    if (!devices) {
      return [];
    }
    return Array.from(devices.entries()).map(([deviceId, state]) => {
      const latestLog = state.logs[state.logs.length - 1] || null;
      return {
        deviceId,
        logCount: state.logs.length,
        latestLogScope: latestLog?.scope || null,
        latestLogTs: latestLog?.ts || null,
        latestSnapshotAt: state.latestSnapshot?.receivedAt || null,
        latestSnapshotRequestId: state.latestSnapshot?.requestId || null,
      };
    }).sort((a, b) => {
      const aKey = a.latestSnapshotAt || a.latestLogTs || '';
      const bKey = b.latestSnapshotAt || b.latestLogTs || '';
      return bKey.localeCompare(aKey);
    });
  }
}
