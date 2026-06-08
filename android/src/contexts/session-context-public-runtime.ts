import { buildEmptyScheduleState } from '@zterm/shared';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  ClientMessage,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  TerminalVisibleRange,
} from '../lib/types';
import {
  normalizeSessionVisibleRangeState,
  type SessionVisibleRangeState,
  visibleRangeStatesEqual,
} from './session-visible-range-helpers';
import {
  shouldPullVisibleRangeBuffer,
  type SessionBufferHeadState,
} from './session-buffer-planner-helpers';

interface ScheduleStateSetter {
  (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ): void;
}

interface SendMessageRuntimeOptions {
  sessionId: string;
  msg: ClientMessage;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}

export function sendMessageRuntime(options: SendMessageRuntimeOptions) {
  const ws = options.readSessionTransportSocket(options.sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    options.sendSocketPayload(options.sessionId, ws, JSON.stringify(options.msg));
    return true;
  }
  return false;
}

export function sendMessageRawRuntime(options: {
  sessionId: string;
  msg: unknown;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const ws = options.readSessionTransportSocket(options.sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    options.sendSocketPayload(options.sessionId, ws, JSON.stringify(options.msg));
  }
}

export function requestScheduleListRuntime(options: {
  sessionId: string;
  sessions: Session[];
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => boolean;
}) {
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    options.setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: 'schedule session not found',
    }));
    return;
  }
  const sent = options.sendMessage(options.sessionId, {
    type: 'schedule-list',
    payload: { sessionName: session.sessionName },
  });
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    sessionName: session.sessionName,
    loading: sent,
    error: sent ? undefined : 'schedule transport not connected',
  }));
}

export function upsertScheduleJobRuntime(options: {
  sessionId: string;
  job: ScheduleJobDraft;
  sessions: Session[];
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => boolean;
}) {
  if (!options.sessions.some((item) => item.id === options.sessionId)) {
    options.setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: 'schedule session not found',
    }));
    return;
  }
  const sent = options.sendMessage(options.sessionId, { type: 'schedule-upsert', payload: { job: options.job } });
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: sent,
    error: sent ? undefined : 'schedule transport not connected',
  }));
}

export function deleteScheduleJobRuntime(options: {
  sessionId: string;
  jobId: string;
  sessions: Session[];
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => boolean;
}) {
  if (!options.sessions.some((item) => item.id === options.sessionId)) {
    options.setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: 'schedule session not found',
    }));
    return;
  }
  const sent = options.sendMessage(options.sessionId, { type: 'schedule-delete', payload: { jobId: options.jobId } });
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: sent,
    error: sent ? undefined : 'schedule transport not connected',
  }));
}

export function toggleScheduleJobRuntime(options: {
  sessionId: string;
  jobId: string;
  enabled: boolean;
  sessions: Session[];
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => boolean;
}) {
  if (!options.sessions.some((item) => item.id === options.sessionId)) {
    options.setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: 'schedule session not found',
    }));
    return;
  }
  const sent = options.sendMessage(options.sessionId, {
    type: 'schedule-toggle',
    payload: { jobId: options.jobId, enabled: options.enabled },
  });
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: sent,
    error: sent ? undefined : 'schedule transport not connected',
  }));
}

export function runScheduleJobNowRuntime(options: {
  sessionId: string;
  jobId: string;
  sessions: Session[];
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => boolean;
}) {
  if (!options.sessions.some((item) => item.id === options.sessionId)) {
    options.setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: 'schedule session not found',
    }));
    return;
  }
  const sent = options.sendMessage(options.sessionId, { type: 'schedule-run-now', payload: { jobId: options.jobId } });
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: sent,
    error: sent ? undefined : 'schedule transport not connected',
  }));
}

export function updateSessionViewportRuntime(options: {
  sessionId: string;
  visibleRange: TerminalVisibleRange;
  triggerRepair?: boolean;
  viewportMode?: 'follow' | 'reading';
  sessionVisibleRangeRef: { current: Map<string, SessionVisibleRangeState> };
  isSessionTransportActive: (sessionId: string) => boolean;
  sessions: Session[];
  sessionBufferHeadsRef: { current: Map<string, SessionBufferHeadState> };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      sessionOverride?: Session;
      reason?: string;
      force?: boolean;
      purpose?: 'tail-refresh' | 'reading-repair';
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
      requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
    },
  ) => boolean;
}) {
  const normalized = normalizeSessionVisibleRangeState(options.visibleRange);
  const previous = options.sessionVisibleRangeRef.current.get(options.sessionId);
  if (visibleRangeStatesEqual(previous, normalized)) {
    return;
  }
  options.sessionVisibleRangeRef.current.set(options.sessionId, normalized);
  if (!options.isSessionTransportActive(options.sessionId)) {
    return;
  }
  const followViewportExpandedUpward = (
    options.viewportMode === 'follow'
    && Boolean(previous)
    && normalized.endIndex >= previous!.endIndex
    && normalized.startIndex < previous!.startIndex
    && normalized.viewportRows > previous!.viewportRows
  );
  if (options.triggerRepair === false && !followViewportExpandedUpward) {
    return;
  }
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  const liveHead = options.sessionBufferHeadsRef.current.get(options.sessionId) || null;
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  if (!session) {
    return;
  }
  const expandedFollowRepairRange = followViewportExpandedUpward
    ? {
        startIndex: normalized.startIndex,
        endIndex: Math.min(normalized.endIndex, previous!.startIndex),
      }
    : null;
  const shouldRepairVisibleRange = shouldPullVisibleRangeBuffer(session, normalized, liveHead, localBuffer);
  if (
    (
      !shouldRepairVisibleRange
      && !expandedFollowRepairRange
    )
  ) {
    return;
  }
  options.requestSessionBufferSync(options.sessionId, {
    reason: 'viewport-visible-range-demand',
    purpose: 'reading-repair',
    sessionOverride: session,
    requestWindowOverride: expandedFollowRepairRange
      ? {
          requestStartIndex: normalized.startIndex,
          requestEndIndex: normalized.endIndex,
        }
      : null,
    requestMissingRangesOverride: expandedFollowRepairRange
      ? [expandedFollowRepairRange]
      : null,
  });
}

export function getActiveSessionRuntime(options: {
  sessions: Session[];
  activeSessionId: string | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
}): Session | null {
  const activeSession = options.sessions.find((session) => session.id === options.activeSessionId) || null;
  if (!activeSession) {
    return null;
  }
  return {
    ...activeSession,
    buffer: options.readSessionBufferSnapshot(activeSession.id),
  };
}

export function getSessionRuntime(options: {
  sessions: Session[];
  sessionId: string;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
}): Session | null {
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return null;
  }
  return {
    ...session,
    buffer: options.readSessionBufferSnapshot(session.id),
  };
}

export function getSessionScheduleStateRuntime(options: {
  sessionId: string;
  scheduleStates: Record<string, SessionScheduleState>;
  sessions: Session[];
}): SessionScheduleState {
  return options.scheduleStates[options.sessionId]
    || buildEmptyScheduleState(options.sessions.find((session) => session.id === options.sessionId)?.sessionName || '');
}

export function getSessionDebugMetricsRuntime(options: {
  sessionId: string;
  sessions: Session[];
  activeSessionId: string | null;
  readMetrics: (sessionId: string, sessionState: Session['state'] | null, active: boolean, now: number) => SessionDebugOverlayMetrics | null;
  now: number;
}): SessionDebugOverlayMetrics | null {
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  return options.readMetrics(
    options.sessionId,
    session?.state || null,
    options.activeSessionId === options.sessionId,
    options.now,
  );
}
