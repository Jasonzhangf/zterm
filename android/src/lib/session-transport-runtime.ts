import type { Host } from './types';
import type { BridgeTransportSocket } from './traversal/types';

export interface SessionTransportRuntime {
  sessionId: string;
  targetKey: string;
  host: Host;
  activeSocket: BridgeTransportSocket | null;
  supersededSockets: BridgeTransportSocket[];
}

export interface TargetTransportRuntime {
  key: string;
  bridgeHost: string;
  bridgePort: number;
  authToken: string;
  controlTransport: BridgeTransportSocket | null;
  sessionIds: string[];
}

export interface SessionTransportRuntimeStore {
  targets: Map<string, TargetTransportRuntime>;
  sessions: Map<string, SessionTransportRuntime>;
}

function maybeDeleteEmptyTargetRuntime(
  store: SessionTransportRuntimeStore,
  targetKey: string,
) {
  const targetRuntime = store.targets.get(targetKey) || null;
  if (!targetRuntime) {
    return;
  }
  if (targetRuntime.sessionIds.length > 0 || targetRuntime.controlTransport) {
    return;
  }
  store.targets.delete(targetKey);
}

function normalizeAuthToken(authToken: string | undefined) {
  return typeof authToken === 'string' ? authToken.trim() : '';
}

function normalizeHostForRuntime(host: Host): Host {
  return {
    ...host,
    bridgeHost: host.bridgeHost.trim(),
    bridgePort: Math.max(1, Math.floor(host.bridgePort || 3333)),
    authToken: normalizeAuthToken(host.authToken) || undefined,
    sessionName: host.sessionName.trim(),
  };
}

export function buildTransportTargetKey(host: Pick<Host, 'bridgeHost' | 'bridgePort' | 'authToken'>) {
  const normalizedHost = host.bridgeHost.trim();
  const normalizedPort = Math.max(1, Math.floor(host.bridgePort || 3333));
  const normalizedAuthToken = normalizeAuthToken(host.authToken);
  return `${normalizedHost}:${normalizedPort}:${normalizedAuthToken}`;
}

export function createSessionTransportRuntimeStore(): SessionTransportRuntimeStore {
  return {
    targets: new Map(),
    sessions: new Map(),
  };
}

export function ensureTargetTransportRuntime(
  store: SessionTransportRuntimeStore,
  host: Pick<Host, 'bridgeHost' | 'bridgePort' | 'authToken'>,
) {
  const key = buildTransportTargetKey(host);
  const existing = store.targets.get(key);
  if (existing) {
    return existing;
  }
  const created: TargetTransportRuntime = {
    key,
    bridgeHost: host.bridgeHost.trim(),
    bridgePort: Math.max(1, Math.floor(host.bridgePort || 3333)),
    authToken: normalizeAuthToken(host.authToken),
    controlTransport: null,
    sessionIds: [],
  };
  store.targets.set(key, created);
  return created;
}

export function getTargetTransportRuntime(
  store: SessionTransportRuntimeStore,
  targetKey: string,
) {
  return store.targets.get(targetKey) || null;
}

export function getSessionTargetTransportRuntime(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  const sessionRuntime = store.sessions.get(sessionId) || null;
  if (!sessionRuntime) {
    return null;
  }
  return store.targets.get(sessionRuntime.targetKey) || null;
}

export function getSessionTransportTargetKey(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return store.sessions.get(sessionId)?.targetKey || null;
}

export function upsertSessionTransportRuntime(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  host: Host,
) {
  const normalizedHost = normalizeHostForRuntime(host);
  const nextTarget = ensureTargetTransportRuntime(store, normalizedHost);
  const current = store.sessions.get(sessionId) || null;

  if (current && current.targetKey !== nextTarget.key) {
    const previousTarget = store.targets.get(current.targetKey) || null;
    if (previousTarget) {
      previousTarget.sessionIds = previousTarget.sessionIds.filter((id) => id !== sessionId);
      maybeDeleteEmptyTargetRuntime(store, previousTarget.key);
    }
  }

  const nextRuntime: SessionTransportRuntime = {
    sessionId,
    targetKey: nextTarget.key,
    host: normalizedHost,
    activeSocket: current?.activeSocket || null,
    supersededSockets: current?.supersededSockets ? [...current.supersededSockets] : [],
  };
  store.sessions.set(sessionId, nextRuntime);
  if (!nextTarget.sessionIds.includes(sessionId)) {
    nextTarget.sessionIds = [...nextTarget.sessionIds, sessionId];
  }
  return nextRuntime;
}

export function getSessionTransportRuntime(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return store.sessions.get(sessionId) || null;
}

export function getSessionTransportHost(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return store.sessions.get(sessionId)?.host || null;
}

export function getSessionTransportSocket(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return store.sessions.get(sessionId)?.activeSocket || null;
}

export function setSessionTransportSocket(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  socket: BridgeTransportSocket | null,
) {
  const runtime = store.sessions.get(sessionId);
  if (!runtime) {
    return null;
  }
  runtime.activeSocket = socket;
  return runtime;
}

export function getTargetControlTransport(
  store: SessionTransportRuntimeStore,
  targetKey: string,
) {
  return store.targets.get(targetKey)?.controlTransport || null;
}

export function getSessionTargetControlTransport(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return getSessionTargetTransportRuntime(store, sessionId)?.controlTransport || null;
}

export function setTargetControlTransport(
  store: SessionTransportRuntimeStore,
  targetKey: string,
  socket: BridgeTransportSocket | null,
) {
  const targetRuntime = store.targets.get(targetKey) || null;
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.controlTransport = socket;
  if (!socket) {
    maybeDeleteEmptyTargetRuntime(store, targetKey);
  }
  return targetRuntime;
}

export function setSessionTargetControlTransport(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  socket: BridgeTransportSocket | null,
) {
  const targetRuntime = getSessionTargetTransportRuntime(store, sessionId);
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.controlTransport = socket;
  return targetRuntime;
}

export function moveSessionTransportSocketToSuperseded(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  const runtime = store.sessions.get(sessionId);
  if (!runtime || !runtime.activeSocket) {
    return null;
  }
  const activeSocket = runtime.activeSocket;
  runtime.supersededSockets = [...runtime.supersededSockets, activeSocket];
  runtime.activeSocket = null;
  return activeSocket;
}

export function clearSessionSupersededSockets(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  const runtime = store.sessions.get(sessionId);
  if (!runtime) {
    return [];
  }
  const superseded = runtime.supersededSockets;
  runtime.supersededSockets = [];
  return superseded;
}

export function removeSessionTransportRuntime(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  const runtime = store.sessions.get(sessionId) || null;
  if (!runtime) {
    return null;
  }
  store.sessions.delete(sessionId);
  const target = store.targets.get(runtime.targetKey) || null;
  if (target) {
    target.sessionIds = target.sessionIds.filter((id) => id !== sessionId);
    maybeDeleteEmptyTargetRuntime(store, target.key);
  }
  return runtime;
}
