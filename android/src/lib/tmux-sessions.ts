import type { BridgeSettings } from './bridge-settings';
import type { TraversalTargetSource } from './traversal/types';
import type { BridgeTarget } from './session-picker';
import { createClientDaemonTraversalSocket } from './client-daemon-connection';
import { createSessionActivityNotifier } from './session-activity-notify';
import type {
  SessionActivity,
  TerminalSessionCatalog,
  TerminalSessionCatalogEntry,
} from '@zterm/shared/protocol';
import {
  buildTerminalMuxHello,
  buildTerminalMuxTargetMessage,
  isTerminalMuxServerFrame,
  type TerminalMuxTargetClientMessage,
} from '@zterm/shared/protocol';

export type { BridgeTarget } from './session-picker';

const TRANSPORT_CONNECTING = 0;
const TRANSPORT_OPEN = 1;
const TMUX_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

type TmuxSessionTraversalSettings = Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>;

interface PendingTmuxRequest {
  message: TerminalMuxTargetClientMessage;
  requestId: string;
  resolve: (sessions: string[], sessionCatalog?: TerminalSessionCatalogEntry[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TmuxControlTransportEntry {
  key: string;
  ws: ReturnType<typeof createClientDaemonTraversalSocket>;
  active: PendingTmuxRequest | null;
  queue: PendingTmuxRequest[];
  negotiated: boolean;
  negotiationTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const tmuxControlTransportPool = new Map<string, TmuxControlTransportEntry>();
// Short-TTL cache for list-sessions results. Opening the session drawer
// triggers audit + refresh list requests on the same targets; without this
// cache every open re-issues a network round trip per target (and each target
// with no reusable session transport pays a fresh traversal connect). The TTL
// is short so create/rename/kill operations become visible quickly; mutations
// also invalidate the cache entry explicitly.
const TMUX_SESSION_LIST_CACHE_TTL_MS = 3000;
const tmuxSessionListCache = new Map<string, {
  sessionNames: string[];
  sessionCatalog?: TerminalSessionCatalogEntry[];
  at: number;
}>();
let tmuxControlIdentitySequence = 0;
// Shared session-activity notifier for the tmux control channel (legacy,
// non-mux wire messages also carry daemon-published session-activity facts).
const sessionActivityNotifier = createSessionActivityNotifier();

function createTmuxControlIdentity(prefix: 'client' | 'request') {
  tmuxControlIdentitySequence += 1;
  return `tmux-control-${prefix}-${Date.now()}-${tmuxControlIdentitySequence}`;
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePort(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeRelayEndpointCandidates(candidates: BridgeTarget['relayEndpointCandidates']) {
  return (candidates || []).map((candidate) => ({
    id: normalizeString(candidate.id),
    kind: candidate.kind,
    host: normalizeString(candidate.host),
    port: normalizePort(candidate.port),
    wsUrl: normalizeString(candidate.wsUrl),
    relayHostId: normalizeString(candidate.relayHostId),
    authToken: normalizeString(candidate.authToken),
    authRequired: Boolean(candidate.authRequired),
  }));
}

function buildTmuxControlTransportKey(
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  overrideUrl?: string,
) {
  const relay = traversalSettings.traversalRelay;
  return JSON.stringify({
    target: {
      bridgeHost: normalizeString(target.bridgeHost),
      bridgePort: normalizePort(target.bridgePort),
      authToken: normalizeString(target.authToken),
      daemonHostId: normalizeString(target.daemonHostId),
      relayHostId: normalizeString(target.relayHostId),
      relayDeviceId: normalizeString(target.relayDeviceId),
      signalUrl: normalizeString(target.signalUrl),
      transportMode: target.transportMode || 'auto',
      relayEndpointCandidates: normalizeRelayEndpointCandidates(target.relayEndpointCandidates),
    },
    traversalSettings: {
      signalUrl: normalizeString(traversalSettings.signalUrl),
      turnServerUrl: normalizeString(traversalSettings.turnServerUrl),
      turnUsername: normalizeString(traversalSettings.turnUsername),
      turnCredential: normalizeString(traversalSettings.turnCredential),
      transportMode: traversalSettings.transportMode || 'auto',
      traversalRelay: relay ? {
        relayBaseUrl: normalizeString(relay.relayBaseUrl),
        accessToken: normalizeString(relay.accessToken),
        userId: normalizeString(relay.userId),
        username: normalizeString(relay.username),
        deviceId: normalizeString(relay.deviceId),
        wsClientUrl: normalizeString(relay.wsClientUrl),
        turnUrl: normalizeString(relay.turnUrl),
        turnUsername: normalizeString(relay.turnUsername),
        turnCredential: normalizeString(relay.turnCredential),
      } : null,
    },
    overrideUrl: normalizeString(overrideUrl),
  });
}

function buildTmuxSessionListCacheKey(
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  overrideUrl?: string,
) {
  return JSON.stringify({
    transport: buildTmuxControlTransportKey(target, traversalSettings, overrideUrl),
  });
}

function isUsableTmuxControlTransport(ws: ReturnType<typeof createClientDaemonTraversalSocket>) {
  return ws.readyState === TRANSPORT_OPEN || ws.readyState === TRANSPORT_CONNECTING;
}

function clearRequestTimer(request: PendingTmuxRequest) {
  if (request.timer) {
    clearTimeout(request.timer);
    request.timer = null;
  }
}

function detachTmuxControlTransport(entry: TmuxControlTransportEntry) {
  entry.ws.onopen = null;
  entry.ws.onmessage = null;
  entry.ws.onerror = null;
  entry.ws.onclose = null;
}

function rejectRequest(request: PendingTmuxRequest, error: Error) {
  clearRequestTimer(request);
  request.reject(error);
}

function failTmuxControlTransport(entry: TmuxControlTransportEntry, error: Error, closeTransport: boolean) {
  if (entry.closed) {
    return;
  }
  entry.closed = true;
  if (entry.negotiationTimer) {
    clearTimeout(entry.negotiationTimer);
    entry.negotiationTimer = null;
  }
  tmuxControlTransportPool.delete(entry.key);
  const active = entry.active;
  const queued = entry.queue.splice(0);
  entry.active = null;
  detachTmuxControlTransport(entry);
  if (closeTransport && isUsableTmuxControlTransport(entry.ws)) {
    entry.ws.close();
  }
  if (active) {
    rejectRequest(active, error);
  }
  for (const request of queued) {
    rejectRequest(request, error);
  }
}

function finishActiveTmuxControlRequest(entry: TmuxControlTransportEntry, handler: (request: PendingTmuxRequest) => void) {
  const active = entry.active;
  if (!active) {
    failTmuxControlTransport(entry, new Error('Unexpected tmux control response without an active request'), true);
    return;
  }
  entry.active = null;
  clearRequestTimer(active);
  handler(active);
  drainTmuxControlTransport(entry);
}

function handleTmuxControlMessage(entry: TmuxControlTransportEntry, data: unknown) {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data)) as unknown;
  } catch (error) {
    failTmuxControlTransport(entry, error instanceof Error ? error : new Error('Failed to parse tmux control response'), true);
    return;
  }

  if (!isTerminalMuxServerFrame(frame)) {
    failTmuxControlTransport(entry, new Error('Invalid tmux mux server frame'), true);
    return;
  }

  if (frame.type === 'mux-ready') {
    if (entry.negotiated) {
      failTmuxControlTransport(entry, new Error('Unexpected duplicate tmux mux-ready'), true);
      return;
    }
    entry.negotiated = true;
    if (entry.negotiationTimer) {
      clearTimeout(entry.negotiationTimer);
      entry.negotiationTimer = null;
    }
    entry.ws.confirmTransportReady?.();
    drainTmuxControlTransport(entry);
    return;
  }

  if (!entry.negotiated || frame.type !== 'mux-target-message') {
    failTmuxControlTransport(entry, new Error('Unexpected tmux mux server frame type'), true);
    return;
  }

  const response = frame.payload.message;
  if (response.type === 'session-activity') {
    // Daemon-published tmux session liveness facts (idle/stopped detection).
    const activities = (response as { payload: { activities: SessionActivity[] } }).payload?.activities || [];
    for (const activity of activities) {
      sessionActivityNotifier.handleActivity(activity);
    }
    return;
  }

  const active = entry.active;
  if (!active) {
    failTmuxControlTransport(entry, new Error('Unexpected tmux control response without an active request'), true);
    return;
  }
  if (frame.payload.requestId !== active.requestId) {
    failTmuxControlTransport(entry, new Error('Mismatched tmux control request id'), true);
    return;
  }

  if (response.type === 'sessions') {
    finishActiveTmuxControlRequest(entry, (request) => {
      request.resolve(response.payload.sessions || [], response.payload.sessionCatalog);
    });
    return;
  }

  if (response.type === 'error') {
    finishActiveTmuxControlRequest(entry, (request) => {
      request.reject(new Error(response.payload.message || 'Failed to manage tmux sessions'));
    });
    return;
  }

  failTmuxControlTransport(entry, new Error('Unexpected tmux target response type'), true);
}

function drainTmuxControlTransport(entry: TmuxControlTransportEntry) {
  if (entry.closed || !entry.negotiated || entry.active || entry.ws.readyState !== TRANSPORT_OPEN) {
    return;
  }
  const request = entry.queue.shift();
  if (!request) {
    return;
  }
  entry.active = request;
  request.timer = setTimeout(() => {
    if (entry.active === request) {
      failTmuxControlTransport(entry, new Error('Timed out while managing tmux sessions'), true);
    }
  }, TMUX_CONTROL_REQUEST_TIMEOUT_MS);

  try {
    entry.ws.send(JSON.stringify(buildTerminalMuxTargetMessage(request.message, request.requestId)));
  } catch (error) {
    failTmuxControlTransport(entry, error instanceof Error ? error : new Error('Failed to send tmux control request'), true);
  }
}

function createTmuxControlTransportEntry(
  key: string,
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  overrideUrl?: string,
) {
  const ws = createClientDaemonTraversalSocket(
    target satisfies TraversalTargetSource,
    traversalSettings,
    { overrideUrl, requireMuxReadyConfirmation: true },
  );
  const entry: TmuxControlTransportEntry = {
    key,
    ws,
    active: null,
    queue: [],
    negotiated: false,
    negotiationTimer: null,
    closed: false,
  };

  ws.onopen = () => {
    try {
      const deviceId = traversalSettings.traversalRelay?.deviceId?.trim() || undefined;
      ws.send(JSON.stringify(buildTerminalMuxHello(createTmuxControlIdentity('client'), deviceId)));
      entry.negotiationTimer = setTimeout(() => {
        failTmuxControlTransport(entry, new Error('Timed out while negotiating tmux mux transport'), true);
      }, TMUX_CONTROL_REQUEST_TIMEOUT_MS);
    } catch (error) {
      failTmuxControlTransport(entry, error instanceof Error ? error : new Error('Failed to negotiate tmux mux transport'), true);
    }
  };
  ws.onmessage = (event) => {
    handleTmuxControlMessage(entry, event.data);
  };
  ws.onerror = () => {
    const diagnostics = ws.getDiagnostics();
    failTmuxControlTransport(entry, new Error(diagnostics.reason || 'Transport error while managing tmux sessions'), false);
  };
  ws.onclose = (event) => {
    const diagnostics = ws.getDiagnostics();
    failTmuxControlTransport(
      entry,
      new Error(diagnostics.reason || event?.reason || 'Transport closed while managing tmux sessions'),
      false,
    );
  };

  tmuxControlTransportPool.set(key, entry);
  return entry;
}

function getTmuxControlTransportEntry(
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  overrideUrl?: string,
) {
  const key = buildTmuxControlTransportKey(target, traversalSettings, overrideUrl);
  const existing = tmuxControlTransportPool.get(key);
  if (existing && !existing.closed && isUsableTmuxControlTransport(existing.ws)) {
    return existing;
  }
  if (existing) {
    failTmuxControlTransport(existing, new Error('Stale tmux control transport replaced'), false);
  }
  return createTmuxControlTransportEntry(key, target, traversalSettings, overrideUrl);
}

function sendTmuxRequest(
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  message: TerminalMuxTargetClientMessage,
  overrideUrl?: string,
) {
  return new Promise<string[]>((resolve, reject) => {
    const entry = getTmuxControlTransportEntry(target, traversalSettings, overrideUrl);
    entry.queue.push({
      message,
      requestId: createTmuxControlIdentity('request'),
      resolve,
      reject,
      timer: null,
    });
    drainTmuxControlTransport(entry);
  });
}

function sendTmuxCatalogRequest(
  target: BridgeTarget,
  traversalSettings: TmuxSessionTraversalSettings,
  message: TerminalMuxTargetClientMessage,
  overrideUrl?: string,
) {
  return new Promise<TerminalSessionCatalog>((resolve, reject) => {
    const entry = getTmuxControlTransportEntry(target, traversalSettings, overrideUrl);
    entry.queue.push({
      message,
      requestId: createTmuxControlIdentity('request'),
      resolve: (sessions, sessionCatalog) => {
        resolve({
          sessionNames: sessions,
          sessionCatalog: sessionCatalog || [],
        });
      },
      reject,
      timer: null,
    });
    drainTmuxControlTransport(entry);
  });
}

export function fetchTmuxSessions(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  overrideUrl?: string,
) {
  return fetchTmuxSessionCatalog(target, traversalSettings, overrideUrl).then((catalog) => catalog.sessionNames);
}

export function fetchTmuxSessionCatalog(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  overrideUrl?: string,
) {
  const cacheKey = buildTmuxSessionListCacheKey(target, traversalSettings, overrideUrl);
  const cached = tmuxSessionListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TMUX_SESSION_LIST_CACHE_TTL_MS) {
    return Promise.resolve({
      sessionNames: [...cached.sessionNames],
      sessionCatalog: [...(cached.sessionCatalog || [])],
    });
  }
  const message: TerminalMuxTargetClientMessage = { type: 'list-sessions' };
  return sendTmuxCatalogRequest(target, traversalSettings, message, overrideUrl).then((catalog) => {
    tmuxSessionListCache.set(cacheKey, {
      sessionNames: catalog.sessionNames,
      sessionCatalog: catalog.sessionCatalog,
      at: Date.now(),
    });
    return catalog;
  });
}

function invalidateTmuxSessionListCache(target: BridgeTarget, traversalSettings: TmuxSessionTraversalSettings, overrideUrl?: string) {
  tmuxSessionListCache.delete(buildTmuxSessionListCacheKey(target, traversalSettings, overrideUrl));
}

export function createTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  options?: string | { cwd?: string; overrideUrl?: string },
) {
  const overrideUrl = typeof options === 'string' ? options : options?.overrideUrl;
  const cwd = typeof options === 'string' ? undefined : options?.cwd?.trim();
  const payload: { sessionName: string; cwd?: string; terminalBackend?: 'tmux' | 'herdr' } = {
    sessionName,
  };
  if (cwd) payload.cwd = cwd;
  if (target.terminalBackend === 'herdr') payload.terminalBackend = 'herdr';
  const result = sendTmuxRequest(
    target,
    traversalSettings,
    { type: 'tmux-create-session', payload },
    overrideUrl,
  );
  invalidateTmuxSessionListCache(target, traversalSettings, overrideUrl);
  return result;
}

export function renameTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  nextSessionName: string,
  overrideUrl?: string,
) {
  const payload: { sessionName: string; nextSessionName: string } = {
    sessionName,
    nextSessionName,
  };
  const result = sendTmuxRequest(
    target,
    traversalSettings,
    { type: 'tmux-rename-session', payload },
    overrideUrl,
  );
  invalidateTmuxSessionListCache(target, traversalSettings, overrideUrl);
  return result;
}

export function killTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  overrideUrl?: string,
) {
  const payload: { sessionName: string } = { sessionName };
  const result = sendTmuxRequest(target, traversalSettings, {
    type: 'tmux-kill-session',
    payload,
  }, overrideUrl);
  invalidateTmuxSessionListCache(target, traversalSettings, overrideUrl);
  return result;
}

export function resetTmuxSessionTransportPoolForTests() {
  for (const entry of tmuxControlTransportPool.values()) {
    failTmuxControlTransport(entry, new Error('Reset tmux control transport pool'), true);
  }
  tmuxControlTransportPool.clear();
  tmuxSessionListCache.clear();
}
