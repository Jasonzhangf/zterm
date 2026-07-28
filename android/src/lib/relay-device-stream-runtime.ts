import type { TraversalRelayClientSettings } from './bridge-settings';
import type { TraversalRelayDeviceSnapshot } from './types';
import { listOnlineTraversalRelayDaemonDevices } from './traversal-relay-devices';

export const RELAY_DEVICE_STREAM_RECONNECT_BASE_DELAY_MS = 300;
export const RELAY_DEVICE_STREAM_RECONNECT_MAX_DELAY_MS = 5000;

const TRAVERSAL_RELAY_SETTING_COMPARE_KEYS = [
  'relayBaseUrl',
  'accessToken',
  'userId',
  'username',
  'deviceId',
  'deviceName',
  'platform',
  'wsDevicesUrl',
  'wsHostUrl',
  'wsClientUrl',
  'turnUrl',
  'turnUsername',
  'turnCredential',
] as const satisfies readonly (keyof TraversalRelayClientSettings)[];

export function computeRelayDeviceStreamReconnectDelay(attempt: number) {
  return Math.min(
    RELAY_DEVICE_STREAM_RECONNECT_MAX_DELAY_MS,
    RELAY_DEVICE_STREAM_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
}

export function areTraversalRelaySettingsEqual(
  current: TraversalRelayClientSettings | undefined,
  next: TraversalRelayClientSettings | undefined,
) {
  if (!current || !next) {
    return current === next;
  }
  return TRAVERSAL_RELAY_SETTING_COMPARE_KEYS.every((key) => current[key] === next[key]);
}

export function hasRelayDirectoryTruth(device: TraversalRelayDeviceSnapshot) {
  return (device.daemon.endpoints?.length || 0) > 0
    || (device.daemon.sessions?.length || 0) > 0;
}

export function listRelayDirectoryTruthDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter(hasRelayDirectoryTruth);
}

export function mergeRelayPresenceWithDirectoryTruth(
  devices: TraversalRelayDeviceSnapshot[],
  directoryTruthDevices: TraversalRelayDeviceSnapshot[],
) {
  const directoryByDeviceId = new Map(
    directoryTruthDevices.map((device) => [device.deviceId, device]),
  );
  const directoryByHostId = new Map(
    directoryTruthDevices
      .filter((device) => device.daemon.hostId.trim())
      .map((device) => [device.daemon.hostId, device]),
  );

  return listOnlineTraversalRelayDaemonDevices(devices).map((device) => {
    const directoryDevice = directoryByDeviceId.get(device.deviceId)
      || directoryByHostId.get(device.daemon.hostId);
    if (!directoryDevice) {
      return device;
    }
    return {
      ...directoryDevice,
      ...device,
      daemon: {
        ...directoryDevice.daemon,
        ...device.daemon,
        endpoints: device.daemon.endpoints?.length
          ? device.daemon.endpoints
          : directoryDevice.daemon.endpoints,
        sessions: device.daemon.sessions?.length
          ? device.daemon.sessions
          : directoryDevice.daemon.sessions,
      },
    };
  });
}

export interface RelayDeviceStreamRuntimeDeps {
  readEnabledAccount: () => unknown | null;
  refreshAccount: (account: unknown) => Promise<{
    account: unknown;
    relaySettings?: TraversalRelayClientSettings | null;
  }>;
  projectDevicesFromAccount: (account: unknown | null | undefined) => TraversalRelayDeviceSnapshot[];
  connectDevicesStream: (options: {
    account: unknown;
    onOpen?: () => void;
    onDevices?: (devices: TraversalRelayDeviceSnapshot[]) => void;
    onDirectory?: (directory: unknown) => void;
    onError?: (message: string) => void;
    onClose?: (event: CloseEvent) => void;
    onDebugRequest?: (payload: {
      requestId?: string;
      reason?: string;
      includeSnapshot?: boolean;
      includeLogs?: boolean;
      logLimit?: number;
    }, socket: WebSocket) => void;
  }) => WebSocket;
  projectDirectoryDevices: (directory: unknown) => TraversalRelayDeviceSnapshot[];
  setDevices: (
    next:
      | TraversalRelayDeviceSnapshot[]
      | ((current: TraversalRelayDeviceSnapshot[]) => TraversalRelayDeviceSnapshot[]),
  ) => void;
  publishDirectoryTruth?: (devices: TraversalRelayDeviceSnapshot[]) => void;
  applyRelaySettings?: (settings: TraversalRelayClientSettings) => void;
  runtimeDebug?: (event: string, payload?: Record<string, unknown>) => void;
  onDebugRequest?: (payload: {
    requestId?: string;
    reason?: string;
    includeSnapshot?: boolean;
    includeLogs?: boolean;
    logLimit?: number;
  }, socket: WebSocket, account: unknown) => void;
  setTimeoutFn?: (handler: () => void, delayMs: number) => number;
  clearTimeoutFn?: (timerId: number) => void;
}

export function createRelayDeviceStreamRuntime(deps: RelayDeviceStreamRuntimeDeps) {
  let disposed = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let socket: WebSocket | null = null;
  let directoryTruthDevices: TraversalRelayDeviceSnapshot[] = [];

  const setTimeoutFn = deps.setTimeoutFn || ((handler, delayMs) => globalThis.setTimeout(handler, delayMs) as unknown as number);
  const clearTimeoutFn = deps.clearTimeoutFn || ((timerId) => {
    globalThis.clearTimeout(timerId as unknown as ReturnType<typeof globalThis.setTimeout>);
  });

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) {
      return;
    }
    clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  };

  const replaceDirectoryTruth = (devices: TraversalRelayDeviceSnapshot[]) => {
    directoryTruthDevices = listRelayDirectoryTruthDevices(devices);
    deps.publishDirectoryTruth?.(directoryTruthDevices);
  };

  const scheduleReconnect = (reason: string) => {
    if (disposed || reconnectTimer !== null) {
      return;
    }
    const delayMs = computeRelayDeviceStreamReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    deps.runtimeDebug?.('relay.device-stream.reconnect.scheduled', {
      reason,
      delayMs,
      attempt: reconnectAttempt,
    });
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      openDeviceStream();
    }, delayMs);
  };

  const openDeviceStream = () => {
    if (disposed) {
      return;
    }
    const openGeneration = generation;
    void deps.refreshAccount(deps.readEnabledAccount()).then((refreshed) => {
      if (disposed || generation !== openGeneration) {
        return;
      }
      const nextRelay = refreshed.relaySettings
        || (refreshed.account as { relaySettings?: TraversalRelayClientSettings | null } | null | undefined)?.relaySettings
        || null;
      if (!nextRelay) {
        throw new Error('relay control payload missing ws/control settings');
      }
      const refreshedDevices = deps.projectDevicesFromAccount(refreshed.account);
      replaceDirectoryTruth(refreshedDevices);
      deps.setDevices(refreshedDevices);
      deps.applyRelaySettings?.(nextRelay);

      const nextSocket = deps.connectDevicesStream({
        account: refreshed.account,
        onOpen: () => {
          reconnectAttempt = 0;
          const deviceId = (refreshed.account as { deviceId?: string } | null | undefined)?.deviceId;
          deps.runtimeDebug?.('relay.device-stream.open', { deviceId: deviceId || null });
        },
        onDevices: (devices) => {
          deps.setDevices((current) => {
            const currentDirectoryTruth = directoryTruthDevices.length > 0
              ? directoryTruthDevices
              : listRelayDirectoryTruthDevices(current);
            const merged = mergeRelayPresenceWithDirectoryTruth(devices, currentDirectoryTruth);
            const nextDirectoryTruth = listRelayDirectoryTruthDevices(merged);
            if (nextDirectoryTruth.length > 0) {
              directoryTruthDevices = nextDirectoryTruth;
            }
            return merged;
          });
        },
        onDirectory: (directory) => {
          const directoryDevices = deps.projectDirectoryDevices(directory);
          if (directoryDevices.length > 0) {
            const onlineDirectoryDevices = listOnlineTraversalRelayDaemonDevices(directoryDevices);
            replaceDirectoryTruth(onlineDirectoryDevices);
            deps.setDevices(onlineDirectoryDevices);
          }
        },
        onError: (message) => {
          deps.runtimeDebug?.('relay.device-stream.error', { message });
        },
        onClose: (event) => {
          if (socket === nextSocket) {
            socket = null;
          }
          const reason = event.reason || `relay device stream closed: ${event.code}`;
          deps.runtimeDebug?.('relay.device-stream.close', { code: event.code, reason });
          scheduleReconnect(reason);
        },
        onDebugRequest: (payload, liveSocket) => {
          deps.runtimeDebug?.('relay.device-stream.debug-request', {
            requestId: payload.requestId || null,
            reason: payload.reason || null,
            includeSnapshot: payload.includeSnapshot !== false,
            includeLogs: payload.includeLogs !== false,
            logLimit: payload.logLimit || null,
          });
          deps.onDebugRequest?.(payload, liveSocket, refreshed.account);
        },
      });
      socket = nextSocket;
    }).catch((error) => {
      if (disposed || generation !== openGeneration) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      deps.runtimeDebug?.('relay.device-stream.account-refresh.error', { message });
      scheduleReconnect(message);
    });
  };

  return {
    start() {
      disposed = false;
      generation += 1;
      reconnectAttempt = 0;
      clearReconnectTimer();
      if (socket) {
        try {
          socket.close(1000, 'relay device stream restart');
        } catch {
          // ignore close races while restarting
        }
        socket = null;
      }

      const account = deps.readEnabledAccount();
      if (!account) {
        replaceDirectoryTruth([]);
        deps.setDevices([]);
        return;
      }

      const initialDevices = deps.projectDevicesFromAccount(account);
      replaceDirectoryTruth(initialDevices);
      deps.setDevices(initialDevices);
      openDeviceStream();
    },

    stop(reason = 'relay device stream disposed') {
      disposed = true;
      generation += 1;
      clearReconnectTimer();
      if (!socket) {
        return;
      }
      try {
        socket.close(1000, reason);
      } catch {
        // ignore dispose close races
      }
      socket = null;
    },

    getSocket() {
      return socket;
    },

    getDirectoryTruthDevices() {
      return directoryTruthDevices;
    },

    replaceDirectoryTruthFromDevices(devices: TraversalRelayDeviceSnapshot[]) {
      replaceDirectoryTruth(devices);
    },
  };
}
