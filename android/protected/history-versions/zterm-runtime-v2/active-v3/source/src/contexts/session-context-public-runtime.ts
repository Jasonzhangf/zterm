import { buildEmptyScheduleState } from '@zterm/shared';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
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
  daemonConnection: ClientDaemonConnection;
}

export function sendMessageRuntime(options: SendMessageRuntimeOptions) {
  return options.daemonConnection.sendSessionMessage(options.sessionId, options.msg);
}

export function sendMessageRawRuntime(options: {
  sessionId: string;
  msg: unknown;
  daemonConnection: ClientDaemonConnection;
}) {
  options.daemonConnection.sendSessionRaw(options.sessionId, options.msg);
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
  sessionHeadStoreRef: { current: { getLiveHead: (sessionId: string) => SessionBufferHeadState | null } };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      headOverride?: { daemonHeadRevision: number; daemonHeadEndIndex: number } | null;
      reason?: string;
      force?: boolean;
      purpose?: 'tail-refresh' | 'reading-repair';
      requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
      requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
    },
  ) => boolean;
  requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
}) {
  const normalized = normalizeSessionVisibleRangeState(options.visibleRange);
  const previous = options.sessionVisibleRangeRef.current.get(options.sessionId);
  const declaredMissingRanges = (options.requestMissingRangesOverride || [])
    .map((range) => ({
      startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
      endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
    }))
    .filter((range) => range.endIndex > range.startIndex);
  if (visibleRangeStatesEqual(previous, normalized) && declaredMissingRanges.length === 0) {
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
  const liveHead = options.sessionHeadStoreRef.current.getLiveHead(options.sessionId);
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
  const headView = liveHead
    ? { daemonHeadRevision: liveHead.revision, daemonHeadEndIndex: liveHead.latestEndIndex }
    : { daemonHeadRevision: 0, daemonHeadEndIndex: 0 };
  const shouldRepairVisibleRange = shouldPullVisibleRangeBuffer(headView, normalized, liveHead, localBuffer);
  if (
    (
      !shouldRepairVisibleRange
      && !expandedFollowRepairRange
      && declaredMissingRanges.length === 0
    )
  ) {
    return;
  }
  options.requestSessionBufferSync(options.sessionId, {
    reason: 'viewport-visible-range-demand',
    purpose: 'reading-repair',
    headOverride: headView,
    requestWindowOverride: expandedFollowRepairRange
      ? {
          requestStartIndex: normalized.startIndex,
          requestEndIndex: normalized.endIndex,
        }
      : declaredMissingRanges.length > 0
        ? {
            requestStartIndex: normalized.startIndex,
            requestEndIndex: normalized.endIndex,
          }
      : null,
    requestMissingRangesOverride: expandedFollowRepairRange
      ? [expandedFollowRepairRange]
      : declaredMissingRanges.length > 0
        ? declaredMissingRanges
      : null,
  });
}

export function getActiveSessionRuntime(options: {
  sessions: Session[];
  activeSessionId: string | null;
}): Session | null {
  return options.sessions.find((session) => session.id === options.activeSessionId) || null;
}

export function getSessionRuntime(options: {
  sessions: Session[];
  sessionId: string;
}): Session | null {
  return options.sessions.find((item) => item.id === options.sessionId) || null;
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
