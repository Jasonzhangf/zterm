import type {
  AndroidConnectionServiceRoutePolicy,
  AndroidConnectionServiceTarget,
} from './android-connection-service-commands';

export type AndroidConnectionServiceState =
  | 'idle'
  | 'resolving-target'
  | 'connecting'
  | 'mux-ready'
  | 'channels-ready'
  | 'healthy'
  | 'backoff-reconnect'
  | 'authentication-error'
  | 'terminal-error';

export interface AndroidConnectionServiceChannelSnapshot {
  channelId: string;
  state: 'opening' | 'open' | 'closing' | 'closed';
}

export interface AndroidConnectionServiceError {
  code:
    | 'invalid-command'
    | 'transport'
    | 'heartbeat-timeout'
    | 'authentication'
    | 'terminal'
    | 'webrtc-not-supported';
  message: string;
}

export interface AndroidConnectionServiceSnapshot {
  state: AndroidConnectionServiceState;
  generation: string | null;
  target: AndroidConnectionServiceTarget | null;
  route: AndroidConnectionServiceRoutePolicy | null;
  channels: AndroidConnectionServiceChannelSnapshot[];
  lastHeartbeatAt: number | null;
  lastActivityAt: number | null;
  nextRetryAt: number | null;
  error: AndroidConnectionServiceError | null;
  muxReadyPayload: Record<string, unknown> | null;
}

export type AndroidConnectionServiceEvent =
  | { type: 'bind-target'; target: AndroidConnectionServiceTarget }
  | { type: 'set-route-policy'; policy: AndroidConnectionServiceRoutePolicy }
  | { type: 'release-target'; targetKey: string; reason: string }
  | { type: 'transport-opening'; generation: string }
  | { type: 'mux-ready'; generation: string; muxReadyPayload: Record<string, unknown> }
  | { type: 'channel-opened'; generation: string; channelId: string }
  | { type: 'channel-closed'; generation: string; channelId: string; reason: string }
  | { type: 'heartbeat-pong'; generation: string; at: number }
  | { type: 'server-activity'; generation: string; at: number }
  | { type: 'heartbeat-missed'; generation: string }
  | { type: 'transport-failure'; generation: string; message: string }
  | { type: 'authentication-failure'; generation: string; message: string }
  | { type: 'terminal-failure'; generation: string; message: string }
  | { type: 'webrtc-not-supported'; generation: string; message: string }
  | { type: 'reconnect-attempt'; generation: string; at: number };

export interface AndroidConnectionServiceStateMachineOptions {
  now?: () => number;
  heartbeatMissesBeforeReconnect?: number;
}

const EMPTY_SNAPSHOT: AndroidConnectionServiceSnapshot = {
  state: 'idle',
  generation: null,
  target: null,
  route: null,
  channels: [],
  lastHeartbeatAt: null,
  lastActivityAt: null,
  nextRetryAt: null,
  error: null,
  muxReadyPayload: null,
};

function readonlySnapshot(snapshot: AndroidConnectionServiceSnapshot): AndroidConnectionServiceSnapshot {
  return {
    ...snapshot,
    target: snapshot.target ? { ...snapshot.target } : null,
    route: snapshot.route ? { ...snapshot.route } : null,
    channels: snapshot.channels.map((channel) => ({ ...channel })),
    error: snapshot.error ? { ...snapshot.error } : null,
    muxReadyPayload: snapshot.muxReadyPayload ? { ...snapshot.muxReadyPayload } : null,
  };
}

function rejectGeneration(
  currentGeneration: string | null,
  event: Extract<AndroidConnectionServiceEvent, { generation: string }>,
) {
  return currentGeneration !== event.generation;
}

export function createAndroidConnectionServiceStateMachine(options: AndroidConnectionServiceStateMachineOptions = {}) {
  const now = options.now ?? Date.now;
  const heartbeatMissesBeforeReconnect = options.heartbeatMissesBeforeReconnect ?? 3;
  let snapshot: AndroidConnectionServiceSnapshot = { ...EMPTY_SNAPSHOT };
  let retiredGenerations = new Set<string>();
  let projectionAttached = true;
  let consecutiveHeartbeatMisses = 0;

  const dispatch = (event: AndroidConnectionServiceEvent): boolean => {
    if (event.type === 'bind-target') {
      const identicalTarget = snapshot.target?.targetKey === event.target.targetKey;
      if (identicalTarget && snapshot.target && snapshot.state !== 'idle') {
        return true;
      }
      snapshot = {
        ...snapshot,
        state: 'resolving-target',
        generation: null,
        target: { ...event.target },
        channels: [],
        lastHeartbeatAt: null,
        lastActivityAt: null,
        nextRetryAt: null,
        error: null,
      };
      retiredGenerations = new Set();
      consecutiveHeartbeatMisses = 0;
      return true;
    }
    if (event.type === 'set-route-policy') {
      const identicalPolicy = JSON.stringify(snapshot.route) === JSON.stringify(event.policy);
      if (identicalPolicy) {
        return true;
      }
      snapshot = {
        ...snapshot,
        route: { ...event.policy },
      };
      if (snapshot.generation && snapshot.state !== 'idle') {
        retiredGenerations.add(snapshot.generation);
        snapshot = {
          ...snapshot,
          state: 'resolving-target',
          generation: null,
          channels: [],
          lastHeartbeatAt: null,
          lastActivityAt: null,
          nextRetryAt: null,
          error: null,
        };
        consecutiveHeartbeatMisses = 0;
      }
      if (snapshot.state !== 'idle') {
        snapshot = { ...snapshot };
      }
      // Route policy is a control fact. The native owner will perform the
      // physical replacement; this projection only exposes the new desired
      // policy and its resulting resolving state.
      return true;
    }
    if (event.type === 'release-target') {
      snapshot = {
        ...EMPTY_SNAPSHOT,
        target: null,
        generation: null,
        route: snapshot.route ? { ...snapshot.route } : null,
      };
      retiredGenerations = new Set();
      consecutiveHeartbeatMisses = 0;
      return true;
    }
    if (event.type === 'transport-opening') {
      if (retiredGenerations.has(event.generation)) {
        return false;
      }
    } else if ('generation' in event) {
      if (rejectGeneration(snapshot.generation, event) || retiredGenerations.has(event.generation)) {
        return false;
      }
    }

    switch (event.type) {
      case 'transport-opening':
        if (snapshot.state !== 'resolving-target' && snapshot.state !== 'backoff-reconnect') {
          return false;
        }
        snapshot = {
          ...snapshot,
          state: 'connecting',
          generation: event.generation,
          muxReadyPayload: null,
          error: null,
          nextRetryAt: null,
        };
        consecutiveHeartbeatMisses = 0;
        return true;
      case 'mux-ready':
        if (snapshot.state !== 'connecting' && snapshot.state !== 'mux-ready') {
          return false;
        }
        snapshot = {
          ...snapshot,
          state: 'mux-ready',
          error: null,
          muxReadyPayload: { ...event.muxReadyPayload },
        };
        consecutiveHeartbeatMisses = 0;
        return true;
      case 'channel-opened':
        if (snapshot.state !== 'mux-ready' && snapshot.state !== 'channels-ready') {
          return false;
        }
        if (!snapshot.channels.some((channel) => channel.channelId === event.channelId)) {
          snapshot.channels.push({ channelId: event.channelId, state: 'open' });
        }
        snapshot = {
          ...snapshot,
          state: 'channels-ready',
          channels: [...snapshot.channels],
          lastActivityAt: now(),
          error: null,
        };
        return true;
      case 'channel-closed':
        snapshot = {
          ...snapshot,
          channels: snapshot.channels.map((channel) => (
            channel.channelId === event.channelId ? { ...channel, state: 'closed' } : channel
          )),
          lastActivityAt: now(),
        };
        return true;
      case 'heartbeat-pong':
        if (snapshot.state !== 'channels-ready' && snapshot.state !== 'mux-ready' && snapshot.state !== 'healthy') {
          return false;
        }
        snapshot = {
          ...snapshot,
          state: 'healthy',
          lastHeartbeatAt: event.at,
          lastActivityAt: event.at,
          error: null,
        };
        consecutiveHeartbeatMisses = 0;
        return true;
      case 'server-activity':
        snapshot = {
          ...snapshot,
          lastActivityAt: event.at,
          error: null,
        };
        consecutiveHeartbeatMisses = 0;
        return true;
      case 'heartbeat-missed':
        if (snapshot.state !== 'channels-ready' && snapshot.state !== 'mux-ready' && snapshot.state !== 'healthy') {
          return false;
        }
        consecutiveHeartbeatMisses += 1;
        if (consecutiveHeartbeatMisses < heartbeatMissesBeforeReconnect) {
          return true;
        }
        consecutiveHeartbeatMisses = 0;
        retiredGenerations.add(event.generation);
        snapshot = {
          ...EMPTY_SNAPSHOT,
          target: snapshot.target ? { ...snapshot.target } : null,
          route: snapshot.route ? { ...snapshot.route } : null,
          state: 'backoff-reconnect',
          generation: null,
          nextRetryAt: now() + 1000,
          lastActivityAt: now(),
          error: { code: 'heartbeat-timeout', message: 'mux heartbeat budget exhausted' },
        };
        return true;
      case 'transport-failure':
        retiredGenerations.add(event.generation);
        consecutiveHeartbeatMisses = 0;
        snapshot = {
          ...EMPTY_SNAPSHOT,
          target: snapshot.target ? { ...snapshot.target } : null,
          route: snapshot.route ? { ...snapshot.route } : null,
          state: 'backoff-reconnect',
          generation: null,
          nextRetryAt: now() + 1000,
          lastActivityAt: now(),
          error: { code: 'transport', message: event.message },
        };
        return true;
      case 'authentication-failure':
        retiredGenerations.add(event.generation);
        snapshot = {
          ...snapshot,
          state: 'authentication-error',
          generation: null,
          nextRetryAt: null,
          error: { code: 'authentication', message: event.message },
        };
        return true;
      case 'terminal-failure':
        retiredGenerations.add(event.generation);
        snapshot = {
          ...snapshot,
          state: 'terminal-error',
          generation: null,
          nextRetryAt: null,
          error: { code: 'terminal', message: event.message },
        };
        return true;
      case 'webrtc-not-supported':
        retiredGenerations.add(event.generation);
        snapshot = {
          ...snapshot,
          state: 'terminal-error',
          generation: null,
          nextRetryAt: null,
          error: { code: 'webrtc-not-supported', message: event.message },
        };
        return true;
      case 'reconnect-attempt':
        if (snapshot.state !== 'backoff-reconnect') {
          return false;
        }
        snapshot = {
          ...snapshot,
          state: 'resolving-target',
          nextRetryAt: null,
          error: null,
        };
        return true;
      default:
        return false;
    }
  };

  return {
    dispatch,
    readSnapshot: () => readonlySnapshot(snapshot),
    detachProjection: () => {
      projectionAttached = false;
    },
    attachProjection: () => {
      projectionAttached = true;
      return readonlySnapshot(snapshot);
    },
    isProjectionAttached: () => projectionAttached,
  };
}
