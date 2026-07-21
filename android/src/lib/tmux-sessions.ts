import type { BridgeSettings } from './bridge-settings';
import type { ClientMessage } from './types';
import { TraversalSocket } from './traversal/socket';
import type { TraversalTargetSource } from './traversal/types';
import type { BridgeTarget } from './session-picker';

export type { BridgeTarget } from './session-picker';

const TRANSPORT_CONNECTING = 0;
const TRANSPORT_OPEN = 1;
const TMUX_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

type TmuxSessionTraversalSettings = Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>;

type TmuxControlResponse =
  | { type: 'sessions'; payload: { sessions?: string[] } }
  | { type: 'error'; payload: { message?: string } };

interface PendingTmuxRequest {
  message: ClientMessage;
  resolve: (sessions: string[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TmuxControlTransportEntry {
  key: string;
  ws: TraversalSocket;
  active: PendingTmuxRequest | null;
  queue: PendingTmuxRequest[];
  closed: boolean;
}

const tmuxControlTransportPool = new Map<string, TmuxControlTransportEntry>();

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

function isUsableTmuxControlTransport(ws: TraversalSocket) {
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
  let response: TmuxControlResponse;
  try {
    response = JSON.parse(String(data)) as TmuxControlResponse;
  } catch (error) {
    failTmuxControlTransport(entry, error instanceof Error ? error : new Error('Failed to parse tmux control response'), true);
    return;
  }

  if (response.type === 'sessions') {
    finishActiveTmuxControlRequest(entry, (request) => {
      request.resolve(response.payload.sessions || []);
    });
    return;
  }

  if (response.type === 'error') {
    finishActiveTmuxControlRequest(entry, (request) => {
      request.reject(new Error(response.payload.message || 'Failed to manage tmux sessions'));
    });
    return;
  }

  failTmuxControlTransport(entry, new Error('Unexpected tmux control response type'), true);
}

function drainTmuxControlTransport(entry: TmuxControlTransportEntry) {
  if (entry.closed || entry.active || entry.ws.readyState !== TRANSPORT_OPEN) {
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
    entry.ws.send(JSON.stringify(request.message));
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
  const ws = new TraversalSocket(target satisfies TraversalTargetSource, traversalSettings, { overrideUrl });
  const entry: TmuxControlTransportEntry = {
    key,
    ws,
    active: null,
    queue: [],
    closed: false,
  };

  ws.onopen = () => {
    drainTmuxControlTransport(entry);
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
  message: ClientMessage,
  overrideUrl?: string,
) {
  return new Promise<string[]>((resolve, reject) => {
    const entry = getTmuxControlTransportEntry(target, traversalSettings, overrideUrl);
    entry.queue.push({
      message,
      resolve,
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
  return sendTmuxRequest(target, traversalSettings, { type: 'list-sessions' }, overrideUrl);
}

export function createTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  options?: string | { cwd?: string; overrideUrl?: string },
) {
  const overrideUrl = typeof options === 'string' ? options : options?.overrideUrl;
  const cwd = typeof options === 'string' ? undefined : options?.cwd?.trim();
  const payload: { sessionName: string; cwd?: string } = { sessionName };
  if (cwd) payload.cwd = cwd;
  return sendTmuxRequest(target, traversalSettings, { type: 'tmux-create-session', payload }, overrideUrl);
}

export function renameTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  nextSessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(
    target,
    traversalSettings,
    { type: 'tmux-rename-session', payload: { sessionName, nextSessionName } },
    overrideUrl,
  );
}

export function killTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(target, traversalSettings, { type: 'tmux-kill-session', payload: { sessionName } }, overrideUrl);
}

export function resetTmuxSessionTransportPoolForTests() {
  for (const entry of tmuxControlTransportPool.values()) {
    failTmuxControlTransport(entry, new Error('Reset tmux control transport pool'), true);
  }
  tmuxControlTransportPool.clear();
}
