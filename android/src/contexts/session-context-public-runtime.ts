import { buildEmptyScheduleState } from '@zterm/shared';
import { buildTerminalWidthModePayload } from '../lib/terminal-width-mode-manager';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  ClientMessage,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  TerminalVisibleRange,
  TerminalWidthMode,
} from '../lib/types';
import {
  normalizeSessionVisibleRangeState,
  shouldPullVisibleRangeBuffer,
  visibleRangeStatesEqual,
  type SessionBufferHeadState,
  type SessionVisibleRangeState,
} from './session-sync-helpers';

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
  }
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
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  if (!session) {
    return;
  }
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    sessionName: session.sessionName,
    loading: true,
    error: undefined,
  }));
  options.sendMessage(options.sessionId, {
    type: 'schedule-list',
    payload: { sessionName: session.sessionName },
  });
}

export function upsertScheduleJobRuntime(options: {
  sessionId: string;
  job: ScheduleJobDraft;
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: true,
    error: undefined,
  }));
  options.sendMessage(options.sessionId, { type: 'schedule-upsert', payload: { job: options.job } });
}

export function deleteScheduleJobRuntime(options: {
  sessionId: string;
  jobId: string;
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: true,
    error: undefined,
  }));
  options.sendMessage(options.sessionId, { type: 'schedule-delete', payload: { jobId: options.jobId } });
}

export function toggleScheduleJobRuntime(options: {
  sessionId: string;
  jobId: string;
  enabled: boolean;
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: true,
    error: undefined,
  }));
  options.sendMessage(options.sessionId, {
    type: 'schedule-toggle',
    payload: { jobId: options.jobId, enabled: options.enabled },
  });
}

export function runScheduleJobNowRuntime(options: {
  sessionId: string;
  jobId: string;
  setScheduleStateForSession: ScheduleStateSetter;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: true,
    error: undefined,
  }));
  options.sendMessage(options.sessionId, { type: 'schedule-run-now', payload: { jobId: options.jobId } });
}

export function updateSessionViewportRuntime(options: {
  sessionId: string;
  visibleRange: TerminalVisibleRange;
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
  const session = options.sessions.find((item) => item.id === options.sessionId) || null;
  const liveHead = options.sessionBufferHeadsRef.current.get(options.sessionId) || null;
  const localBuffer = options.readSessionBufferSnapshot(options.sessionId);
  if (!session || !shouldPullVisibleRangeBuffer(session, normalized, liveHead, localBuffer)) {
    return;
  }
  options.requestSessionBufferSync(options.sessionId, {
    reason: 'viewport-visible-range-demand',
    purpose: 'reading-repair',
    sessionOverride: session,
  });
}

export function resizeTerminalRuntime(options: {
  sessionId: string;
  cols: number;
  rows: number;
  viewportSizeRef: { current: Map<string, { cols: number; rows: number }> };
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    return;
  }

  const previous = options.viewportSizeRef.current.get(targetSessionId);
  if (previous && previous.cols === options.cols && previous.rows === options.rows) {
    return;
  }
  options.viewportSizeRef.current.set(targetSessionId, { cols: options.cols, rows: options.rows });
  options.sendMessage(targetSessionId, { type: 'resize', payload: { cols: options.cols, rows: options.rows } });
}

export function setTerminalWidthModeRuntime(options: {
  sessionId: string;
  mode: TerminalWidthMode;
  cols?: number | null;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    return;
  }
  options.sendMessage(targetSessionId, {
    type: 'terminal-width-mode',
    payload: buildTerminalWidthModePayload(options.mode, options.cols),
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
