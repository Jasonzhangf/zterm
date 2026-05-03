import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  Host,
  HostConfigMessage,
  Session,
  SessionBufferState,
  SessionScheduleState,
  SessionState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
  TerminalGapRange,
  TerminalVisibleRange,
  TerminalWidthMode,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { resolveTerminalRequestWindowLines } from '../lib/mobile-config';
import { normalizeWireLines } from '../lib/terminal-buffer';

function resolveSessionBufferView(
  session: Session,
  bufferOverride?: SessionBufferState | null,
): SessionBufferState {
  return bufferOverride || session.buffer;
}

export interface SessionBufferHeadState {
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  seenAt: number;
}

export interface SessionReconnectDecisionOptions {
  hasSession: boolean;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
}

export type ActiveRefreshSource = 'active-resume' | 'active-reentry' | 'active-tick';

export interface ActiveSessionRefreshPlanOptions {
  hasSession: boolean;
  isActive: boolean;
  sessionState: string | null;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
  pendingTransportOpen: boolean;
  allowReconnectIfUnavailable?: boolean;
  transportStale: boolean;
  source: ActiveRefreshSource;
}

export type ActiveSessionRefreshPlan =
  | { action: 'skip'; reason: 'inactive-or-missing-session' | 'tick-blocked-by-reconnect' | 'transport-unavailable' | 'transport-open-pending' }
  | { action: 'probe-stale-transport'; probeReason: 'active-tick' | 'active-reentry' }
  | { action: 'request-head'; resetPullBookkeeping: boolean }
  | { action: 'reconnect' };

export type SessionPullPurpose = 'tail-refresh' | 'reading-repair';

export interface SessionPullState {
  purpose: SessionPullPurpose;
  startedAt: number;
  targetHeadRevision: number;
  targetStartIndex: number;
  targetEndIndex: number;
  requestKnownRevision: number;
  requestLocalStartIndex: number;
  requestLocalEndIndex: number;
}

export type SessionPullStates = Partial<Record<SessionPullPurpose, SessionPullState>>;

export type SessionVisibleRangeState = TerminalVisibleRange;

export type SessionTransportOpenDebugScope = 'connect' | 'reconnect';
export type SessionTransportOpenFailureStage = 'handshake' | 'live';

export interface TransportOpenConnectedEffectPlan {
  debugEvent: 'session.ws.connected' | 'session.ws.reconnect.connected';
  clearSupersededSockets: boolean;
  flushPendingInputQueue: boolean;
}

export interface TransportOpenLiveFailureEffectPlan {
  clearPendingIntent: boolean;
  clearTransportToken: boolean;
  clearScheduleErrorState: boolean;
  clearSupersededSockets: boolean;
  scheduleReconnect: boolean;
}

export type ReconnectHandshakeFailurePlan =
  | { action: 'terminal-error' }
  | { action: 'retry-reconnect'; nextAttempt: number };

export interface PendingSessionTransportOpenIntent {
  sessionId: string;
  host: Host;
  resolvedSessionName: string;
  debugScope: SessionTransportOpenDebugScope;
  activate?: boolean;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  finalizeFailure: (message: string, retryable: boolean) => void;
  onConnected: (ws: BridgeTransportSocket) => void;
}

export interface QueueSessionTransportOpenIntentOptions {
  sessionId: string;
  host: Host;
  resolvedSessionName: string;
  debugScope: SessionTransportOpenDebugScope;
  activate?: boolean;
  onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  onHandshakeConnected?: (ws: BridgeTransportSocket, sessionName: string) => void;
  onHandshakeFailure?: (message: string, retryable: boolean, stage: SessionTransportOpenFailureStage) => void;
  clearHandshakeTimeout: () => void;
  finalizeSocketFailureBaseline: (options: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => { shouldContinue: boolean; manualClosed: boolean } | null | undefined;
}

export function createPendingSessionTransportOpenIntent(
  options: QueueSessionTransportOpenIntentOptions,
): PendingSessionTransportOpenIntent {
  let handshakeSettled = false;
  let liveFailureHandled = false;

  const markHandshakeSettled = () => {
    if (handshakeSettled) {
      return false;
    }
    handshakeSettled = true;
    return true;
  };

  return {
    sessionId: options.sessionId,
    host: options.host,
    resolvedSessionName: options.resolvedSessionName,
    debugScope: options.debugScope,
    activate: options.activate,
    onBeforeConnectSend: options.onBeforeConnectSend,
    finalizeFailure: (message: string, retryable: boolean) => {
      if (!handshakeSettled) {
        options.clearHandshakeTimeout();
        const baseline = options.finalizeSocketFailureBaseline({
          sessionId: options.sessionId,
          message,
          markCompleted: markHandshakeSettled,
        });
        if (!baseline?.shouldContinue) {
          return;
        }
        options.onHandshakeFailure?.(message, retryable, 'handshake');
        return;
      }
      if (liveFailureHandled) {
        return;
      }
      liveFailureHandled = true;
      options.onHandshakeFailure?.(message, retryable, 'live');
    },
    onConnected: (ws: BridgeTransportSocket) => {
      if (!markHandshakeSettled()) {
        return;
      }
      options.clearHandshakeTimeout();
      options.onHandshakeConnected?.(ws, options.resolvedSessionName);
    },
  };
}

export function buildTransportOpenConnectedEffectPlan(
  debugScope: SessionTransportOpenDebugScope,
): TransportOpenConnectedEffectPlan {
  if (debugScope === 'reconnect') {
    return {
      debugEvent: 'session.ws.reconnect.connected',
      clearSupersededSockets: true,
      flushPendingInputQueue: true,
    };
  }
  return {
    debugEvent: 'session.ws.connected',
    clearSupersededSockets: false,
    flushPendingInputQueue: false,
  };
}

export function buildTransportOpenLiveFailureEffectPlan(
  debugScope: SessionTransportOpenDebugScope,
): TransportOpenLiveFailureEffectPlan {
  return {
    clearPendingIntent: true,
    clearTransportToken: true,
    clearScheduleErrorState: true,
    clearSupersededSockets: debugScope === 'reconnect',
    scheduleReconnect: true,
  };
}

export function buildReconnectHandshakeFailurePlan(options: {
  retryable: boolean;
  currentAttempt: number;
}): ReconnectHandshakeFailurePlan {
  if (!options.retryable) {
    return { action: 'terminal-error' };
  }
  return {
    action: 'retry-reconnect',
    nextAttempt: Math.min(options.currentAttempt + 1, 6),
  };
}

export type SessionConnectionFields = Pick<
  Session,
  'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand'
>;

export interface SessionTransportPrimeState {
  resolvedSessionName: string;
  transportHost: Host;
  sessionUpdates: Partial<Session>;
}

export function buildSessionConnectionFields(host: Host, resolvedSessionName: string): SessionConnectionFields {
  return {
    hostId: host.id,
    connectionName: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: resolvedSessionName,
    authToken: host.authToken,
    autoCommand: host.autoCommand,
  };
}

export function buildSessionConnectingUpdates(
  host: Host,
  resolvedSessionName: string,
): Partial<Session> {
  return {
    ...buildSessionConnectionFields(host, resolvedSessionName),
    state: 'connecting',
    reconnectAttempt: 0,
    lastError: undefined,
  };
}

export function buildSessionReconnectingUpdates(
  host: Host,
  resolvedSessionName: string,
): Partial<Session> {
  return {
    ...buildSessionConnectionFields(host, resolvedSessionName),
    state: 'reconnecting',
    reconnectAttempt: 0,
    lastError: undefined,
    ws: null,
  };
}

export function buildSessionTransportPrimeState(
  host: Host,
  mode: 'connect' | 'reconnect',
): SessionTransportPrimeState {
  const resolvedSessionName = host.sessionName.trim() || host.name.trim();
  return {
    resolvedSessionName,
    transportHost: {
      ...host,
      sessionName: resolvedSessionName,
    },
    sessionUpdates: mode === 'connect'
      ? buildSessionConnectingUpdates(host, resolvedSessionName)
      : buildSessionReconnectingUpdates(host, resolvedSessionName),
  };
}

export function buildSessionScheduleLoadingState(
  sessionName: string,
): Pick<SessionScheduleState, 'sessionName' | 'jobs' | 'loading'> {
  return {
    sessionName,
    jobs: [],
    loading: true,
  };
}

export function buildSessionScheduleErrorState(
  current: SessionScheduleState,
  message: string,
): SessionScheduleState {
  return {
    ...current,
    loading: false,
    error: message,
  };
}

export function buildSessionReconnectAttemptProgressUpdates(
  reconnectAttempt: number,
): Pick<Session, 'state' | 'reconnectAttempt'> {
  return {
    state: 'reconnecting',
    reconnectAttempt,
  };
}

export function buildSessionConnectingLabelUpdates(
  sessionName: string,
): Pick<Session, 'state' | 'sessionName'> {
  return {
    state: 'connecting',
    sessionName,
  };
}

export function buildSessionErrorUpdates(
  message: string,
  options?: { includeWsNull?: boolean },
): Partial<Session> {
  return {
    state: 'error',
    lastError: message,
    ...(options?.includeWsNull ? { ws: null } : {}),
  };
}

export function buildSessionIdleAfterReconnectBlockedUpdates(
  message: string,
): Pick<Session, 'state' | 'lastError' | 'reconnectAttempt' | 'ws'> {
  return {
    state: 'idle',
    lastError: message,
    reconnectAttempt: 0,
    ws: null,
  };
}

export function buildSessionReconnectingFailureUpdates(
  message: string,
  reconnectAttempt: number,
): Pick<Session, 'state' | 'lastError' | 'reconnectAttempt' | 'ws'> {
  return {
    state: 'reconnecting',
    lastError: message,
    reconnectAttempt,
    ws: null,
  };
}

export function hasSessionLocalWindow(
  session: Session | null | undefined,
  bufferOverride?: SessionBufferState | null,
) {
  if (!session) {
    return false;
  }
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return (
    Math.max(0, Math.floor(buffer.endIndex || 0))
      > Math.max(0, Math.floor(buffer.startIndex || 0))
    && Math.max(0, Math.floor(buffer.revision || 0)) > 0
  );
}

export function buildSessionConnectedUpdates(): Pick<Session, 'state' | 'reconnectAttempt' | 'lastError'> {
  return {
    state: 'connected',
    reconnectAttempt: 0,
    lastError: undefined,
  };
}

export function buildSessionScheduleListLoadingState(
  current: SessionScheduleState,
  sessionName: string,
): SessionScheduleState {
  return {
    ...current,
    sessionName,
    loading: true,
    error: undefined,
  };
}

export function buildConnectedHeadRefreshPlan(options: {
  shouldLiveRefresh: boolean;
  hadLocalWindowBeforeConnected: boolean;
}) {
  return {
    shouldRequestHead: options.shouldLiveRefresh,
    shouldMarkPendingConnectTailRefresh: (
      options.shouldLiveRefresh
      && options.hadLocalWindowBeforeConnected
    ),
  };
}

export function shouldReconnectActivatedSession(options: SessionReconnectDecisionOptions) {
  const transportClosed = (
    options.wsReadyState === null
    || options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  );
  return options.hasSession && transportClosed && !options.reconnectInFlight;
}

export function shouldReconnectQueuedActiveInput(options: {
  isActiveTarget: boolean;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
}) {
  const transportClosed = (
    options.wsReadyState === null
    || options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  );
  return options.isActiveTarget && transportClosed && !options.reconnectInFlight;
}

export function buildActiveSessionRefreshPlan(options: ActiveSessionRefreshPlanOptions): ActiveSessionRefreshPlan {
  if (!options.hasSession || !options.isActive) {
    return { action: 'skip', reason: 'inactive-or-missing-session' };
  }

  if (
    options.source === 'active-tick'
    && (
      options.sessionState === 'reconnecting'
      || options.reconnectInFlight
      || options.pendingTransportOpen
    )
  ) {
    return { action: 'skip', reason: 'tick-blocked-by-reconnect' };
  }

  const transportOpen = options.wsReadyState === WebSocket.OPEN;
  const unavailableState = options.sessionState === 'closed' || options.sessionState === 'error';

  if (transportOpen && !unavailableState) {
    if (options.transportStale && !options.reconnectInFlight) {
      return {
        action: 'probe-stale-transport',
        probeReason: options.source === 'active-tick' ? 'active-tick' : 'active-reentry',
      };
    }
    return {
      action: 'request-head',
      resetPullBookkeeping: options.source !== 'active-tick',
    };
  }

  if (!options.allowReconnectIfUnavailable) {
    return { action: 'skip', reason: 'transport-unavailable' };
  }

  if (options.pendingTransportOpen) {
    return { action: 'skip', reason: 'transport-open-pending' };
  }

  if (shouldReconnectActivatedSession({
    hasSession: true,
    wsReadyState: options.wsReadyState,
    reconnectInFlight: options.reconnectInFlight,
  })) {
    return { action: 'reconnect' };
  }

  return { action: 'skip', reason: 'transport-unavailable' };
}

function normalizeTerminalCellRow(input: unknown): TerminalCell[] {
  if (typeof input === 'string') {
    return Array.from(input).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }));
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((cell): cell is TerminalCell => Boolean(cell && typeof cell === 'object'))
    .map((cell) => ({
      char: typeof cell.char === 'number' ? cell.char : 32,
      fg: typeof cell.fg === 'number' ? cell.fg : 256,
      bg: typeof cell.bg === 'number' ? cell.bg : 256,
      flags: typeof cell.flags === 'number' ? cell.flags : 0,
      width: typeof cell.width === 'number' ? cell.width : 1,
    }));
}

export function normalizeIncomingBufferPayload(input: TerminalBufferPayload): TerminalBufferPayload {
  const startIndex =
    typeof input.startIndex === 'number' && Number.isFinite(input.startIndex)
      ? Math.max(0, Math.floor(input.startIndex))
      : 0;
  const endIndex =
    typeof input.endIndex === 'number' && Number.isFinite(input.endIndex)
      ? Math.max(startIndex, Math.floor(input.endIndex))
      : startIndex;
  const rows =
    typeof input.rows === 'number' && Number.isFinite(input.rows)
      ? Math.max(1, Math.floor(input.rows))
      : 24;
  const cols =
    typeof input.cols === 'number' && Number.isFinite(input.cols)
      ? Math.max(1, Math.floor(input.cols))
      : 80;

  return {
    revision:
      typeof input.revision === 'number' && Number.isFinite(input.revision)
        ? input.revision
        : 0,
    startIndex,
    endIndex,
    availableStartIndex:
      typeof input.availableStartIndex === 'number' && Number.isFinite(input.availableStartIndex)
        ? Math.max(0, Math.floor(input.availableStartIndex))
        : undefined,
    availableEndIndex:
      typeof input.availableEndIndex === 'number' && Number.isFinite(input.availableEndIndex)
        ? Math.max(startIndex, Math.floor(input.availableEndIndex))
        : undefined,
    cols,
    rows,
    cursorKeysApp: Boolean(input.cursorKeysApp),
    cursor: normalizeTerminalCursorState(input.cursor),
    lines: Array.isArray(input.lines)
      ? normalizeWireLines(input.lines, cols).map((line) => ({
          index: line.index,
          cells: normalizeTerminalCellRow(line.cells),
        }))
      : [],
  };
}

function buildBaseBufferSyncRequestPayload(
  session: Session,
  bufferOverride?: SessionBufferState | null,
): Pick<BufferSyncRequestPayload, 'knownRevision' | 'localStartIndex' | 'localEndIndex'> {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const cacheLines = resolveTerminalRequestWindowLines(safeViewportRows);
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - cacheLines);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function resolveVisibleViewportWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - safeViewportRows);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function resolveVisibleRangeViewportRows(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (typeof visibleRange?.viewportRows === 'number' && Number.isFinite(visibleRange.viewportRows) && visibleRange.viewportRows > 0) {
    return Math.max(1, Math.floor(visibleRange.viewportRows));
  }
  if (typeof buffer.rows === 'number' && Number.isFinite(buffer.rows) && buffer.rows > 0) {
    return Math.max(1, Math.floor(buffer.rows));
  }
  throw new Error(`Session ${session.id} is missing viewportRows truth for buffer request`);
}

function resolveVisibleRangeEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (typeof visibleRange?.endIndex === 'number' && Number.isFinite(visibleRange.endIndex)) {
    return Math.max(0, Math.floor(visibleRange.endIndex));
  }
  return Math.max(0, Math.floor(
    session.daemonHeadEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
}

function resolveAuthoritativeAvailableEndIndex(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  if (typeof liveHead?.availableEndIndex === 'number' && Number.isFinite(liveHead.availableEndIndex)) {
    return Math.max(0, Math.floor(liveHead.availableEndIndex));
  }
  if (typeof liveHead?.latestEndIndex === 'number' && Number.isFinite(liveHead.latestEndIndex)) {
    return Math.max(0, Math.floor(liveHead.latestEndIndex));
  }
  if (
    Math.max(0, Math.floor(session.daemonHeadRevision || 0)) > 0
    || Math.max(0, Math.floor(session.daemonHeadEndIndex || 0)) > 0
  ) {
    return Math.max(0, Math.floor(session.daemonHeadEndIndex || 0));
  }
  if (Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0)) > 0) {
    return Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0));
  }
  if (Math.max(0, Math.floor(buffer.endIndex || 0)) > 0) {
    return Math.max(0, Math.floor(buffer.endIndex || 0));
  }
  return null;
}

function resolveTailTargetEndIndex(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  if (typeof session.daemonHeadEndIndex === 'number' && Number.isFinite(session.daemonHeadEndIndex)) {
    return Math.max(0, Math.floor(session.daemonHeadEndIndex));
  }
  return resolveVisibleRangeEndIndex(session, visibleRange, bufferOverride);
}

function mergeGapRanges(ranges: TerminalGapRange[]) {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges]
    .map((range) => ({
      startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
      endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
    }))
    .filter((range) => range.endIndex > range.startIndex)
    .sort((left, right) => left.startIndex - right.startIndex);
  const merged: TerminalGapRange[] = [];
  for (const range of sorted) {
    const current = merged[merged.length - 1];
    if (!current || range.startIndex > current.endIndex) {
      merged.push({ ...range });
      continue;
    }
    current.endIndex = Math.max(current.endIndex, range.endIndex);
  }
  return merged;
}

function collectIntersectingGapRanges(
  gapRanges: TerminalGapRange[],
  startIndex: number,
  endIndex: number,
) {
  if (endIndex <= startIndex) {
    return [] as TerminalGapRange[];
  }
  return gapRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, range.startIndex),
      endIndex: Math.min(endIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

function collectVisibleRangeRepairRanges(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  if (!visibleRange) {
    return [] as TerminalGapRange[];
  }
  const buffer = resolveSessionBufferView(session, bufferOverride);

  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const authoritativeAvailableEndIndex = resolveAuthoritativeAvailableEndIndex(session, liveHead, buffer);
  const requestWindow = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  const visibleStartIndex = requestWindow.requestStartIndex;
  const visibleEndIndex = Math.max(
    visibleStartIndex,
    authoritativeAvailableEndIndex === null
      ? requestWindow.requestEndIndex
      : Math.min(authoritativeAvailableEndIndex, requestWindow.requestEndIndex),
  );
  if (visibleEndIndex <= visibleStartIndex) {
    return [] as TerminalGapRange[];
  }
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const missingRanges: TerminalGapRange[] = [];

  if (localStartIndex > visibleStartIndex) {
    missingRanges.push({
      startIndex: visibleStartIndex,
      endIndex: Math.min(localStartIndex, visibleEndIndex),
    });
  }

  missingRanges.push(...collectIntersectingGapRanges(
    buffer.gapRanges,
    visibleStartIndex,
    visibleEndIndex,
  ));

  if (localEndIndex < visibleEndIndex) {
    missingRanges.push({
      startIndex: Math.max(localEndIndex, visibleStartIndex),
      endIndex: visibleEndIndex,
    });
  }

  return mergeGapRanges(missingRanges);
}

function buildTailRefreshBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    forceSameEndRefresh?: boolean;
    invalidLocalWindow?: boolean;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const buffer = resolveSessionBufferView(session, options?.bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveTailTargetEndIndex(session, visibleRange, buffer);
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, options?.liveHead, buffer);
  const authoritativeHeadStartIndex = availableStartIndex;
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const distanceToHead = Math.max(0, viewportEndIndex - localEndIndex);
  const invalidLocalWindow = Boolean(options?.invalidLocalWindow);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );
  let window: { requestStartIndex: number; requestEndIndex: number };

  if (!localHasWindow || invalidLocalWindow || distanceToHead > cacheLines) {
    window = resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else if (localEndIndex < viewportEndIndex) {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  } else if (sameEndRevisionAdvanced) {
    window = resolveVisibleViewportWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  }
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
  };
}

function buildReadingBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
): BufferSyncRequestPayload {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const viewportEndIndex = resolveVisibleRangeEndIndex(session, visibleRange, buffer);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const window = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  return {
    ...buildBaseBufferSyncRequestPayload(session, buffer),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
    missingRanges: collectVisibleRangeRepairRanges(session, visibleRange, liveHead, buffer),
  };
}

export function buildSessionBufferSyncRequestPayload(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    purpose?: SessionPullPurpose;
    forceSameEndRefresh?: boolean;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
    bufferOverride?: SessionBufferState | null;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || 'tail-refresh';
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(session, visibleRange, options?.liveHead, options?.bufferOverride)
    : buildTailRefreshBufferSyncRequestPayload(session, visibleRange, options);
}

export function buildHostConfigMessage(
  host: Host,
  sessionName: string,
  clientSessionId: string,
  terminalWidthMode: TerminalWidthMode,
  sessionTransportToken?: string | null,
): HostConfigMessage {
  // Compatibility freeze:
  // - clientSessionId remains a client-owned stable session identity
  // - sessionTransportToken remains attach-only wire material
  // Neither field is allowed to become daemon-side long-lived business truth.
  return {
    clientSessionId,
    sessionTransportToken: sessionTransportToken?.trim() || undefined,
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName,
    terminalWidthMode,
    authToken: host.authToken,
    autoCommand: host.autoCommand,
    authType: host.authType,
    password: host.password,
    privateKey: host.privateKey,
  };
}

export function buildDefaultSessionVisibleRange(
  session: Session,
  previousVisibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
): SessionVisibleRangeState {
  const viewportRows =
    typeof previousVisibleRange?.viewportRows === 'number' && Number.isFinite(previousVisibleRange.viewportRows) && previousVisibleRange.viewportRows > 0
      ? Math.max(1, Math.floor(previousVisibleRange.viewportRows))
      : resolveVisibleRangeViewportRows(session, undefined, bufferOverride);
  const endIndex = resolveVisibleRangeEndIndex(session, undefined, bufferOverride);
  return {
    startIndex: Math.max(0, endIndex - viewportRows),
    endIndex,
    viewportRows,
  };
}

export function normalizeSessionVisibleRangeState(visibleRange: SessionVisibleRangeState): SessionVisibleRangeState {
  const viewportRows = Math.max(1, Math.floor(visibleRange.viewportRows || 1));
  const endIndex = Math.max(0, Math.floor(visibleRange.endIndex || 0));
  return {
    startIndex: Math.max(0, Math.min(endIndex, Math.floor(visibleRange.startIndex || 0))),
    endIndex,
    viewportRows,
  };
}

export function visibleRangeStatesEqual(left?: SessionVisibleRangeState, right?: SessionVisibleRangeState) {
  if (!left || !right) {
    return false;
  }
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.viewportRows !== right.viewportRows
  ) {
    return false;
  }
  return true;
}

export function shouldPullFollowBuffer(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(session, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  if (!localHasWindow) {
    return true;
  }
  if (distanceToHead > cacheLines) {
    return true;
  }
  if (localEndIndex < desiredEndIndex) {
    return true;
  }
  if (sameEndRevisionAdvanced) {
    return true;
  }
  return false;
}

export function shouldCatchUpFollowTailAfterBufferApply(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  options?: {
    forceSameEndRefresh?: boolean;
    bufferOverride?: SessionBufferState | null;
  },
) {
  const buffer = resolveSessionBufferView(session, options?.bufferOverride);
  const viewportRows = resolveVisibleRangeViewportRows(session, visibleRange, buffer);
  const desiredEndIndex = resolveTailTargetEndIndex(session, visibleRange, buffer);
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  return (
    !localHasWindow
    || distanceToHead > cacheLines
    || localEndIndex < desiredEndIndex
    || sameEndRevisionAdvanced
    || (Boolean(options?.forceSameEndRefresh) && daemonRevision > localRevision)
  );
}

export function shouldPullVisibleRangeBuffer(
  session: Session,
  visibleRange?: SessionVisibleRangeState,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  return collectVisibleRangeRepairRanges(session, visibleRange, liveHead, bufferOverride).length > 0;
}

export function orderSessionsForReconnect(sessions: Session[], activeSessionId: string | null) {
  if (!activeSessionId) {
    return sessions;
  }
  return [...sessions].sort((left, right) => {
    if (left.id === activeSessionId) {
      return -1;
    }
    if (right.id === activeSessionId) {
      return 1;
    }
    return 0;
  });
}

export function buildManagedSessionReuseKey(input: {
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
}) {
  return [
    input.bridgeHost.trim(),
    String(input.bridgePort),
    input.sessionName.trim(),
    input.authToken?.trim() || '',
  ].join('::');
}

export function scoreReusableManagedSession(session: Session, activeSessionId: string | null) {
  return (
    (session.id === activeSessionId ? 1000 : 0)
    + (session.state === 'connected' ? 100 : session.state === 'connecting' || session.state === 'reconnecting' ? 50 : 0)
    + session.createdAt
  );
}

export function findReusableManagedSession(options: {
  sessions: Session[];
  host: Host;
  resolvedSessionName: string;
  activeSessionId: string | null;
}) {
  const reuseKey = buildManagedSessionReuseKey({
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: options.resolvedSessionName,
    authToken: options.host.authToken,
  });
  return options.sessions
    .filter((session) => buildManagedSessionReuseKey({
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
      sessionName: session.sessionName,
      authToken: session.authToken,
    }) === reuseKey)
    .sort((left, right) => (
      scoreReusableManagedSession(right, options.activeSessionId)
      - scoreReusableManagedSession(left, options.activeSessionId)
    ))[0] || null;
}

export function shouldOpenManagedSessionTransport(options: {
  readyState: number | null;
  hasPendingOpenIntent: boolean;
  sessionState: SessionState;
}) {
  const hasUsableTransport = (
    options.readyState === WebSocket.OPEN
    || options.readyState === WebSocket.CONNECTING
  );
  const isAlreadyOpening = (
    options.sessionState === 'connecting'
    || options.sessionState === 'reconnecting'
  );
  return (
    !hasUsableTransport
    && !options.hasPendingOpenIntent
    && !isAlreadyOpening
    && options.sessionState !== 'connected'
  );
}

export function resolveHeadAvailableBounds(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const availableEndIndex = Math.max(0, Math.floor(
    resolveAuthoritativeAvailableEndIndex(session, liveHead, buffer)
    ?? 0,
  ));
  const authoritativeAvailableStartIndex = (
    typeof liveHead?.availableStartIndex === 'number' && Number.isFinite(liveHead.availableStartIndex)
      ? Math.floor(liveHead.availableStartIndex)
      : 0
  );
  const availableStartIndex = Math.max(0, Math.min(
    availableEndIndex,
    authoritativeAvailableStartIndex,
  ));
  return {
    availableStartIndex,
    availableEndIndex,
  };
}

export function hasImpossibleLocalWindow(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
  bufferOverride?: SessionBufferState | null,
) {
  const buffer = resolveSessionBufferView(session, bufferOverride);
  const { availableEndIndex } = resolveHeadAvailableBounds(session, liveHead, buffer);
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(0, Math.floor(buffer.endIndex || 0));
  const localHeadStartIndex = Math.max(0, Math.floor(buffer.bufferHeadStartIndex || 0));
  const localTailEndIndex = Math.max(0, Math.floor(buffer.bufferTailEndIndex || 0));

  return (
    localStartIndex > availableEndIndex
    || localEndIndex > availableEndIndex
    || localHeadStartIndex > availableEndIndex
    || localTailEndIndex > availableEndIndex
  );
}

function doesBufferSyncSatisfyPullState(
  pullState: SessionPullState,
  payload: TerminalBufferPayload,
) {
  const payloadRevision = Math.max(0, Math.floor(payload.revision || 0));
  const payloadStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const payloadEndIndex = Math.max(payloadStartIndex, Math.floor(payload.endIndex || 0));
  if (pullState.purpose === 'reading-repair') {
    return (
      payloadRevision >= pullState.requestKnownRevision
      && payloadStartIndex <= pullState.targetStartIndex
      && payloadEndIndex >= pullState.targetEndIndex
    );
  }
  return (
    payloadRevision >= pullState.targetHeadRevision
    && payloadStartIndex <= pullState.targetStartIndex
    && payloadEndIndex >= pullState.targetEndIndex
  );
}

export function hasActiveSessionPullState(pullStates?: SessionPullStates | null) {
  return Boolean(pullStates?.['tail-refresh'] || pullStates?.['reading-repair']);
}

export function getPrimarySessionPullState(pullStates?: SessionPullStates | null) {
  return pullStates?.['reading-repair'] || pullStates?.['tail-refresh'] || null;
}

export function settleSessionPullStatesWithBufferSync(
  pullStates: SessionPullStates | null | undefined,
  payload: TerminalBufferPayload,
) {
  if (!pullStates || !hasActiveSessionPullState(pullStates)) {
    return null;
  }

  const activePulls = Object.values(pullStates)
    .filter((item): item is SessionPullState => Boolean(item))
    .sort((left, right) => left.startedAt - right.startedAt);

  if (activePulls.length === 0) {
    return null;
  }

  if ((payload.lines?.length || 0) === 0) {
    return clearSessionPullStateEntry(pullStates, activePulls[0]!.purpose);
  }

  let next: SessionPullStates | null = pullStates;
  for (const pullState of activePulls) {
    if (!doesBufferSyncSatisfyPullState(pullState, payload)) {
      continue;
    }
    next = clearSessionPullStateEntry(next, pullState.purpose);
  }
  return next;
}

export function doesSessionPullStateCoverRequest(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
) {
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(payload.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(payload.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(payload.localEndIndex || 0))
    && (
    pullState.targetStartIndex <= Math.max(0, Math.floor(payload.requestStartIndex || 0))
    && pullState.targetEndIndex >= Math.max(0, Math.floor(payload.requestEndIndex || 0))
    )
  );
}

export function doesSessionPullStateMatchExactLocalSnapshot(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
) {
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(payload.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(payload.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(payload.localEndIndex || 0))
    && pullState.targetStartIndex === Math.max(0, Math.floor(payload.requestStartIndex || 0))
    && pullState.targetEndIndex === Math.max(0, Math.floor(payload.requestEndIndex || 0))
  );
}


export function normalizeTerminalCursorState(
  input: TerminalBufferPayload['cursor'] | BufferHeadPayload['cursor'],
): TerminalCursorState | null {
  return input && typeof input === 'object'
    ? {
        rowIndex: typeof input.rowIndex === 'number' && Number.isFinite(input.rowIndex)
          ? Math.max(0, Math.floor(input.rowIndex))
          : 0,
        col: typeof input.col === 'number' && Number.isFinite(input.col)
          ? Math.max(0, Math.floor(input.col))
          : 0,
        visible: Boolean(input.visible),
      }
    : null;
}

export function clearSessionPullStateEntry(
  pullStates: SessionPullStates | null | undefined,
  purpose: SessionPullPurpose,
) {
  if (!pullStates || !pullStates[purpose]) {
    return pullStates || null;
  }
  const next = { ...pullStates };
  delete next[purpose];
  return hasActiveSessionPullState(next) ? next : null;
}

export function shouldAutoReconnectSession(options: {
  sessionId: string;
  activeSessionId: string | null;
  force?: boolean;
}) {
  if (options.force) {
    return true;
  }
  return options.sessionId === options.activeSessionId;
}
