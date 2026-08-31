import type { Host } from './types';
import type { BridgeTransportSocket } from './traversal/types';
import {
  bindTerminalChannelSession,
  clearTerminalChannelSession,
  createTerminalChannelMuxStore,
  getSessionTerminalChannel,
  removeSessionTerminalChannel,
  type SessionTerminalChannelRuntime,
  type TerminalChannelMuxStore,
} from './terminal-channel-mux-runtime';

type TransportTargetKeyHost = Pick<Host, 'bridgeHost' | 'bridgePort' | 'authToken'> & Partial<Pick<
  Host,
  | 'daemonHostId'
  | 'relayHostId'
  | 'relayDeviceId'
  | 'tailscaleHost'
  | 'ipv6Host'
  | 'ipv4Host'
  | 'relayEndpointCandidates'
  | 'signalUrl'
  | 'transportMode'
>>;

export interface SessionTransportRuntime {
  sessionId: string;
  targetKey: string;
  host: Host;
  activeSocket: BridgeTransportSocket | null;
  supersededSockets: BridgeTransportSocket[];
  channelId: string | null;
  requestedTerminalGeometry: {
    cols?: number | null;
    rows?: number | null;
    widthMode?: 'adaptive-phone' | 'mirror-fixed';
  } | null;
}

export type SessionTransportSocketState = 'missing' | 'connecting' | 'open' | 'closing' | 'closed' | 'unknown';

export interface SessionTransportResource {
  sessionId: string;
  runtime: SessionTransportRuntime | null;
  targetRuntime: TargetTransportRuntime | null;
  targetKey: string | null;
  host: Host | null;
  socket: BridgeTransportSocket | null;
  socketReadyState: number | null;
  socketState: SessionTransportSocketState;
  controlSocket: BridgeTransportSocket | null;
  requestedTerminalGeometry: SessionTransportRuntime['requestedTerminalGeometry'] | null;
  terminalSocket: BridgeTransportSocket | null;
  channel: SessionTerminalChannelRuntime | null;
}

export interface TargetTransportRuntime {
  key: string;
  daemonTargetId: string;
  routeCandidateKey: string;
  routeGeneration: number;
  bridgeHost: string;
  bridgePort: number;
  authToken: string;
  controlTransport: BridgeTransportSocket | null;
  terminalTransport: BridgeTransportSocket | null;
  terminalMuxReady: boolean;
  sessionIds: string[];
}

export interface SessionTransportRuntimeStore {
  targets: Map<string, TargetTransportRuntime>;
  sessions: Map<string, SessionTransportRuntime>;
  terminalChannels: TerminalChannelMuxStore;
}

function maybeDeleteEmptyTargetRuntime(
  store: SessionTransportRuntimeStore,
  targetKey: string,
) {
  const targetRuntime = store.targets.get(targetKey) || null;
  if (!targetRuntime) {
    return;
  }
  if (
    targetRuntime.sessionIds.length > 0
    || targetRuntime.controlTransport
    || targetRuntime.terminalTransport
    || (store.terminalChannels.targets.get(targetKey)?.channels.size ?? 0) > 0
  ) {
    return;
  }
  store.targets.delete(targetKey);
  store.terminalChannels.targets.delete(targetKey);
}

function normalizeAuthToken(authToken: string | undefined) {
  return typeof authToken === 'string' ? authToken.trim() : '';
}

function normalizeKeyText(value: string | undefined | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function encodeKeyPart(value: string | undefined | null) {
  return encodeURIComponent(normalizeKeyText(value));
}

function normalizeEndpointCandidateForTargetKey(
  candidate: NonNullable<Host['relayEndpointCandidates']>[number],
) {
  const parts = [
    `kind=${encodeKeyPart(candidate.kind)}`,
  ];
  if ('host' in candidate) {
    parts.push(`host=${encodeKeyPart(candidate.host)}`);
  }
  if ('port' in candidate) {
    const port = Number.isFinite(candidate.port) ? Math.max(1, Math.floor(candidate.port || 0)) : 0;
    parts.push(`port=${port}`);
  }
  if ('wsUrl' in candidate) {
    parts.push(`ws=${encodeKeyPart(candidate.wsUrl)}`);
  }
  if ('relayHostId' in candidate) {
    parts.push(`relayHost=${encodeKeyPart(candidate.relayHostId)}`);
  }
  return parts.join(',');
}

function normalizeEndpointCandidatesForTargetKey(candidates: Host['relayEndpointCandidates'] | undefined) {
  return (candidates || [])
    .map(normalizeEndpointCandidateForTargetKey)
    .filter(Boolean)
    .sort()
    .join(';');
}

function normalizePort(port: number | undefined | null) {
  return Math.max(1, Math.floor(port || 3333));
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

export function buildTransportTargetKey(host: TransportTargetKeyHost) {
  const normalizedHost = host.bridgeHost.trim();
  const stableDaemonId = normalizeKeyText(host.daemonHostId || host.relayHostId);
  if (stableDaemonId) {
    const parts = [
      `daemon=${encodeKeyPart(stableDaemonId)}`,
    ];
    // A native Android service target cannot be reused by an explicit WebRTC
    // target. Keep auto/direct daemon identity stable, but isolate the
    // transport runtime when the caller has selected Relay/WebRTC.
    if (host.transportMode === 'webrtc') {
      parts.push('mode=webrtc');
    }
    return parts.join('|');
  }
  return [
    `host=${encodeKeyPart(normalizedHost)}`,
    `port=${normalizePort(host.bridgePort)}`,
  ].join('|');
}

export function buildTransportRouteCandidateKey(host: TransportTargetKeyHost) {
  return [
    `host=${encodeKeyPart(host.bridgeHost)}`,
    `port=${normalizePort(host.bridgePort)}`,
    `auth=${encodeKeyPart(normalizeAuthToken(host.authToken))}`,
    `mode=${encodeKeyPart(host.transportMode || 'auto')}`,
    `relayHost=${encodeKeyPart(host.relayHostId)}`,
    `relayDevice=${encodeKeyPart(host.relayDeviceId)}`,
    `tailscale=${encodeKeyPart(host.tailscaleHost)}`,
    `ipv6=${encodeKeyPart(host.ipv6Host)}`,
    `ipv4=${encodeKeyPart(host.ipv4Host)}`,
    `signal=${encodeKeyPart(host.signalUrl)}`,
    `routes=${encodeKeyPart(normalizeEndpointCandidatesForTargetKey(host.relayEndpointCandidates))}`,
  ].join('|');
}

export function createSessionTransportRuntimeStore(): SessionTransportRuntimeStore {
  return {
    targets: new Map(),
    sessions: new Map(),
    terminalChannels: createTerminalChannelMuxStore(),
  };
}

export function ensureTargetTransportRuntime(
  store: SessionTransportRuntimeStore,
  host: TransportTargetKeyHost,
) {
  const key = buildTransportTargetKey(host);
  const routeCandidateKey = buildTransportRouteCandidateKey(host);
  const existing = store.targets.get(key);
  if (existing) {
    if (existing.routeCandidateKey !== routeCandidateKey) {
      existing.routeCandidateKey = routeCandidateKey;
      existing.routeGeneration += 1;
    }
    existing.bridgeHost = host.bridgeHost.trim();
    existing.bridgePort = normalizePort(host.bridgePort);
    existing.authToken = normalizeAuthToken(host.authToken);
    return existing;
  }
  const created: TargetTransportRuntime = {
    key,
    daemonTargetId: key,
    routeCandidateKey,
    routeGeneration: 0,
    bridgeHost: host.bridgeHost.trim(),
    bridgePort: normalizePort(host.bridgePort),
    authToken: normalizeAuthToken(host.authToken),
    controlTransport: null,
    terminalTransport: null,
    terminalMuxReady: false,
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

export function listTargetTransportRuntimes(store: SessionTransportRuntimeStore) {
  return Array.from(store.targets.values());
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
  const targetChanged = Boolean(current && current.targetKey !== nextTarget.key);

  if (current && targetChanged) {
    const previousTarget = store.targets.get(current.targetKey) || null;
    removeSessionTerminalChannel(store.terminalChannels, sessionId);
    if (previousTarget) {
      previousTarget.sessionIds = previousTarget.sessionIds.filter((id) => id !== sessionId);
      maybeDeleteEmptyTargetRuntime(store, previousTarget.key);
    }
  }

  const nextRuntime: SessionTransportRuntime = {
    sessionId,
    targetKey: nextTarget.key,
    host: normalizedHost,
    activeSocket: targetChanged ? null : current?.activeSocket || null,
    supersededSockets: [
      ...(current?.supersededSockets ? [...current.supersededSockets] : []),
      ...(targetChanged && current?.activeSocket ? [current.activeSocket] : []),
    ],
    channelId: targetChanged ? null : current?.channelId || null,
    requestedTerminalGeometry: current?.requestedTerminalGeometry || null,
  };
  store.sessions.set(sessionId, nextRuntime);
  const channelBinding = bindTerminalChannelSession(
    store.terminalChannels,
    sessionId,
    nextTarget.key,
    normalizedHost.sessionName,
  );
  nextRuntime.channelId = channelBinding.channelId;
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

export function resolveTransportSocketState(
  socket: BridgeTransportSocket | null,
): SessionTransportSocketState {
  if (!socket) {
    return 'missing';
  }
  switch (socket.readyState) {
    case 0:
      return 'connecting';
    case 1:
      return 'open';
    case 2:
      return 'closing';
    case 3:
      return 'closed';
    default:
      return 'unknown';
  }
}

export function getSessionTransportResource(
  store: SessionTransportRuntimeStore,
  sessionId: string,
): SessionTransportResource {
  const runtime = getSessionTransportRuntime(store, sessionId);
  const targetRuntime = runtime ? getSessionTargetTransportRuntime(store, sessionId) : null;
  const channel = runtime ? getSessionTerminalChannel(store.terminalChannels, sessionId) : null;
  const terminalSocket = targetRuntime?.terminalTransport || null;
  const hasMuxChannel = Boolean(runtime?.channelId || channel);
  const socket = hasMuxChannel
    ? (channel && targetRuntime?.terminalMuxReady ? terminalSocket : null)
    : runtime?.activeSocket || null;
  return {
    sessionId,
    runtime,
    targetRuntime,
    targetKey: runtime?.targetKey || null,
    host: runtime?.host || null,
    socket,
    socketReadyState: socket?.readyState ?? null,
    socketState: resolveTransportSocketState(socket),
    controlSocket: targetRuntime?.controlTransport || null,
    terminalSocket,
    channel,
    requestedTerminalGeometry: runtime?.requestedTerminalGeometry || null,
  };
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

export function getTargetTerminalTransport(
  store: SessionTransportRuntimeStore,
  targetKey: string,
) {
  return store.targets.get(targetKey)?.terminalTransport || null;
}

export function getSessionTargetTerminalTransport(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return getSessionTargetTransportRuntime(store, sessionId)?.terminalTransport || null;
}

export function setTargetTerminalTransport(
  store: SessionTransportRuntimeStore,
  targetKey: string,
  socket: BridgeTransportSocket | null,
) {
  const targetRuntime = store.targets.get(targetKey) || null;
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.terminalTransport = socket;
  if (!socket) {
    targetRuntime.terminalMuxReady = false;
  }
  if (!socket) {
    maybeDeleteEmptyTargetRuntime(store, targetKey);
  }
  return targetRuntime;
}

export function setSessionTargetTerminalTransport(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  socket: BridgeTransportSocket | null,
) {
  const targetRuntime = getSessionTargetTransportRuntime(store, sessionId);
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.terminalTransport = socket;
  if (!socket) {
    targetRuntime.terminalMuxReady = false;
  }
  if (!socket) {
    maybeDeleteEmptyTargetRuntime(store, targetRuntime.key);
  }
  return targetRuntime;
}

export function getSessionTargetTerminalMuxReady(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return Boolean(getSessionTargetTransportRuntime(store, sessionId)?.terminalMuxReady);
}

export function setSessionTargetTerminalMuxReady(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  ready: boolean,
) {
  const targetRuntime = getSessionTargetTransportRuntime(store, sessionId);
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.terminalMuxReady = Boolean(ready);
  return targetRuntime;
}

export function setTargetTerminalMuxReady(
  store: SessionTransportRuntimeStore,
  targetKey: string,
  ready: boolean,
) {
  const targetRuntime = store.targets.get(targetKey) || null;
  if (!targetRuntime) {
    return null;
  }
  targetRuntime.terminalMuxReady = Boolean(ready);
  return targetRuntime;
}

export function getSessionRequestedTerminalGeometry(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  return store.sessions.get(sessionId)?.requestedTerminalGeometry || null;
}

export function setSessionRequestedTerminalGeometry(
  store: SessionTransportRuntimeStore,
  sessionId: string,
  geometry: {
    cols?: number | null;
    rows?: number | null;
    widthMode?: 'adaptive-phone' | 'mirror-fixed';
  } | null,
) {
  const runtime = store.sessions.get(sessionId);
  if (!runtime) {
    return null;
  }
  runtime.requestedTerminalGeometry = geometry
    ? {
        cols: Number.isFinite(geometry.cols) ? Math.max(1, Math.floor(geometry.cols || 0)) : undefined,
        rows: Number.isFinite(geometry.rows) ? Math.max(1, Math.floor(geometry.rows || 0)) : undefined,
        widthMode: geometry.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed',
      }
    : null;
  return runtime.requestedTerminalGeometry;
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
  removeSessionTerminalChannel(store.terminalChannels, sessionId);
  clearTerminalChannelSession(store.terminalChannels, sessionId);
  store.sessions.delete(sessionId);
  const target = store.targets.get(runtime.targetKey) || null;
  if (target) {
    target.sessionIds = target.sessionIds.filter((id) => id !== sessionId);
    maybeDeleteEmptyTargetRuntime(store, target.key);
  }
  return runtime;
}
