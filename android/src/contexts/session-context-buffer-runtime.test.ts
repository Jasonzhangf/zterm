// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session, TerminalBufferPayload } from '../lib/types';
import {
  applyIncomingBufferSyncRuntime,
  handleBufferHeadRuntime,
  requestSessionBufferHeadRuntime,
  requestSessionBufferSyncRuntime,
} from './session-context-buffer-runtime';
import { buildDefaultSessionVisibleRange } from './session-visible-range-helpers';

function makeSession(sessionId: string): Session {
  return {
    id: sessionId,
    hostId: `host-${sessionId}`,
    connectionName: `conn-${sessionId}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `tmux-${sessionId}`,
    title: sessionId,
    ws: null,
    state: 'connected',
    hasUnread: false,
    buffer: createSessionBufferState({
      lines: ['alpha'],
      startIndex: 0,
      endIndex: 1,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 1,
      cols: 80,
      rows: 24,
      revision: 1,
      cacheLines: 1000,
    }),
    createdAt: 1,
  };
}

function makePayload(revision: number): TerminalBufferPayload {
  return {
    revision,
    startIndex: 0,
    endIndex: 2,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: [
      {
        index: 0,
        cells: Array.from('alpha').map((char) => ({
          char: char.codePointAt(0) || 32,
          fg: 256,
          bg: 256,
          flags: 0,
          width: 1,
        })),
      },
      {
        index: 1,
        cells: Array.from('beta').map((char) => ({
          char: char.codePointAt(0) || 32,
          fg: 256,
          bg: 256,
          flags: 0,
          width: 1,
        })),
      },
    ],
  };
}

function makeLine(text: string) {
  return {
    index: 0,
    cells: Array.from(text).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    })),
  };
}

function makeHeadRuntimeRefs(options: {
  sessions: Session[];
  activeSessionId: string;
  setHead?: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
  visibleRangeEntries?: Array<[string, ReturnType<typeof buildDefaultSessionVisibleRange>]>;
  sessionBufferHeadsEntries?: Array<[string, any]>;
}) {
  return {
    stateRef: { current: { sessions: options.sessions, activeSessionId: options.activeSessionId } },
    sessionBufferHeadsRef: { current: new Map<string, any>(options.sessionBufferHeadsEntries || []) },
    lastHeadRequestAtRef: { current: new Map<string, number>() },
    lastSyncRequestAtRef: { current: new Map<string, any>() },
    sessionRevisionResetRef: { current: new Map() },
    sessionVisibleRangeRef: { current: new Map(options.visibleRangeEntries || []) },
    sessionBufferStoreRef: { current: { commitBuffer: vi.fn(() => false) } },
    sessionHeadStoreRef: { current: { setHead: options.setHead || vi.fn(() => true) } },
  };
}

describe('session-context-buffer-runtime inactive gating', () => {
  it('drops inactive buffer-head before buffer/head/render apply', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => true);
    const runtimeDebug = vi.fn();
    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: 'other-session',
      setHead,
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 5,
      latestEndIndex: 20,
      availableStartIndex: 0,
      availableEndIndex: 20,
      cursor: {
        rowIndex: 10,
        col: 3,
        visible: true,
      },
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => false,
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(refs.sessionBufferHeadsRef.current.get(sessionId)).toMatchObject({
      revision: 5,
      latestEndIndex: 20,
      availableStartIndex: 0,
      availableEndIndex: 20,
    });
    expect(refs.lastHeadRequestAtRef.current.has(sessionId)).toBe(true);
    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(setHead).not.toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.head.inactive-drop',
      expect.objectContaining({
        sessionId,
        activeSessionId: 'other-session',
        latestRevision: 5,
        latestEndIndex: 20,
      }),
    );
  });

  it('drops inactive buffer-sync before local buffer/render apply', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const pendingInputTailRefreshRef = {
      current: new Map<string, { requestedAt: number; localRevision: number }>([
        [sessionId, { requestedAt: 1, localRevision: 1 }],
      ]),
    };
    const pendingConnectTailRefreshRef = { current: new Set<string>([sessionId]) };
    const pendingResumeTailRefreshRef = { current: new Set<string>([sessionId]) };

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: makePayload(2),
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: 'other-session' } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef,
        sessionVisibleRangeRef: { current: new Map() },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({
        revision: payload.revision,
        startIndex: payload.startIndex,
        endIndex: payload.endIndex,
      }),
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => false,
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(pendingInputTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(pendingConnectTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(pendingResumeTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.inactive-drop',
      expect.objectContaining({
        sessionId,
        activeSessionId: 'other-session',
        localRevision: 1,
        localStartIndex: 0,
        localEndIndex: 1,
      }),
    );
  });

  it('does not apply sparse buffer-sync after a revision gap and requests an authoritative tail window', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['old-100', 'old-101', 'old-102', 'old-103', 'old-104'],
      startIndex: 100,
      endIndex: 105,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 105,
      cols: 80,
      rows: 24,
      revision: 5,
      cacheLines: 1000,
    });
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);
    const runtimeDebug = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 8,
        startIndex: 103,
        endIndex: 110,
        availableStartIndex: 100,
        availableEndIndex: 110,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('new-103'), index: 103 },
          { ...makeLine('new-109'), index: 109 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([
            [sessionId, {
              revision: 8,
              latestEndIndex: 110,
              availableStartIndex: 100,
              availableEndIndex: 110,
              seenAt: 1,
            }],
          ]),
        },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
      },
      readSessionBufferSnapshot: () => localBuffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({
        revision: payload.revision,
        startIndex: payload.startIndex,
        endIndex: payload.endIndex,
        lineCount: payload.lines.length,
      }),
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(requestSessionBufferSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        reason: 'buffer-sync-revision-gap-sparse-payload',
        purpose: 'tail-refresh',
        liveHead: expect.objectContaining({
          revision: 8,
          latestEndIndex: 110,
        }),
      }),
    );
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.revision-gap-sparse-payload',
      expect.objectContaining({
        sessionId,
        incomingRevision: 8,
        localRevision: 5,
        incomingLineCount: 2,
        incomingWindowSize: 7,
      }),
    );
  });

  it('still applies consecutive sparse buffer-sync without forcing a tail refresh', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['old-100', 'old-101', 'old-102', 'old-103', 'old-104'],
      startIndex: 100,
      endIndex: 105,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 105,
      cols: 80,
      rows: 24,
      revision: 7,
      cacheLines: 1000,
    });
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 8,
        startIndex: 103,
        endIndex: 110,
        availableStartIndex: 100,
        availableEndIndex: 110,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('new-103'), index: 103 },
          { ...makeLine('new-109'), index: 109 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([
            [sessionId, {
              revision: 8,
              latestEndIndex: 110,
              availableStartIndex: 100,
              availableEndIndex: 110,
              seenAt: 1,
            }],
          ]),
        },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
      },
      readSessionBufferSnapshot: () => localBuffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({
        revision: payload.revision,
        startIndex: payload.startIndex,
        endIndex: payload.endIndex,
        lineCount: payload.lines.length,
      }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledOnce();
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        reason: 'buffer-sync-revision-gap-sparse-payload',
      }),
    );
  });

  it('accepts buffer-head for visible non-active pane when shouldAcceptSessionLiveBuffer returns true', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => true);
    const runtimeDebug = vi.fn();

    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: 'other-session',
      setHead,
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 5,
      latestEndIndex: 20,
      availableStartIndex: 0,
      availableEndIndex: 20,
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => false,
      shouldAcceptSessionLiveBuffer: () => true,
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(setHead).toHaveBeenCalledWith(sessionId, {
      daemonHeadRevision: 5,
      daemonHeadEndIndex: 20,
    });
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.buffer.head.inactive-drop',
      expect.anything(),
    );
  });

  it('requests tail refresh after head arrives when an active tab has no local window yet', () => {
    const sessionId = 'session-2';
    const baseSession = makeSession(sessionId);
    const session: Session = {
      ...baseSession,
      buffer: createSessionBufferState({
        lines: [],
        startIndex: 0,
        endIndex: 0,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 0,
        cols: 80,
        rows: 24,
        revision: 0,
        cacheLines: 1000,
      }),
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
    };
    const requestSessionBufferSync = vi.fn(() => true);
    const setHead = vi.fn(() => true);

    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: sessionId,
      setHead,
      visibleRangeEntries: [[sessionId, buildDefaultSessionVisibleRange(session, undefined, session.buffer)]],
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 6,
      latestEndIndex: 3,
      availableStartIndex: 0,
      availableEndIndex: 3,
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate: vi.fn(() => false),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      runtimeDebug: vi.fn(),
      requestSessionBufferSync,
    });

    expect(setHead).toHaveBeenCalledWith(sessionId, {
      daemonHeadRevision: 6,
      daemonHeadEndIndex: 3,
    });
    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      reason: 'buffer-head-update',
      purpose: 'tail-refresh',
    }));
  });

  it('accepts buffer-sync for visible non-active pane when shouldAcceptSessionLiveBuffer returns true', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: makePayload(2),
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: 'other-session' } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        sessionVisibleRangeRef: { current: new Map() },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({
        revision: payload.revision,
        startIndex: payload.startIndex,
        endIndex: payload.endIndex,
      }),
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => false,
      shouldAcceptSessionLiveBuffer: () => true,
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.buffer.sync.inactive-drop',
      expect.anything(),
    );
  });

  it('does not publish an empty reset frame over an existing render buffer while waiting for fresh sync payload', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);
    const lastSyncRequestAtRef = {
      current: new Map<string, any>([
        [`${sessionId}:tail-refresh`, {
          sentAt: 10,
          requestStartIndex: 0,
          requestEndIndex: 30,
          knownRevision: 1,
          localStartIndex: 0,
          localEndIndex: 1,
          targetHeadRevision: 3,
          repairSignature: '',
        }],
      ]),
    };
    const sessionRevisionResetRef = {
      current: new Map([[sessionId, { revision: 3, latestEndIndex: 30, seenAt: 1 }]]),
    };
    const sessionBufferHeadsRef = {
      current: new Map([[sessionId, { revision: 3, latestEndIndex: 30, seenAt: 1 }]]),
    };

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 1,
        startIndex: 0,
        endIndex: 0,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef,
        sessionBufferHeadsRef,
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef,
        sessionVisibleRangeRef: { current: new Map() },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({
        revision: payload.revision,
        startIndex: payload.startIndex,
        endIndex: payload.endIndex,
        lineCount: payload.lines.length,
      }),
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(sessionRevisionResetRef.current.has(sessionId)).toBe(true);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(false);
    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, {
      reason: 'revision-reset-empty-payload-retry',
      purpose: 'tail-refresh',
      sessionOverride: expect.objectContaining({
        daemonHeadRevision: 3,
        daemonHeadEndIndex: 30,
      }),
      liveHead: expect.objectContaining({
        revision: 3,
        latestEndIndex: 30,
      }),
    });
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.revision-reset.wait-for-nonempty-payload',
      expect.objectContaining({
        sessionId,
        localRevision: 1,
        incomingRevision: 1,
        localLineCount: 1,
      }),
    );
  });

  it('rejects buffer-head request when caller passes a stale superseded socket override', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const activeWs = { readyState: WebSocket.OPEN } as any;
    const staleWs = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    const requested = requestSessionBufferHeadRuntime({
      sessionId,
      ws: staleWs,
      refs: {
        stateRef: { current: { sessions: [session] } },
        lastHeadRequestAtRef: { current: new Map() },
        sessionDebugMetricsStoreRef: { current: { recordRefreshRequest: vi.fn() } },
      },
      readSessionTransportSocket: () => activeWs,
      sendSocketPayload,
      resolveTerminalRefreshCadence: () => ({ headTickMs: 33 }),
    });

    expect(requested).toBe(false);
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('rejects buffer-sync request when caller passes a stale superseded socket override', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const activeWs = { readyState: WebSocket.OPEN } as any;
    const staleWs = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    const requested = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        ws: staleWs,
        reason: 'test-stale-ws',
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
      },
      readSessionTransportSocket: () => activeWs,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState: vi.fn(),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(requested).toBe(false);
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('expires stale in-flight tail refresh bookkeeping before re-requesting sync', () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      const ws = { readyState: WebSocket.OPEN } as any;
      const sendSocketPayload = vi.fn();
      const clearSessionPullState = vi.fn();
      const runtimeDebug = vi.fn();

      vi.setSystemTime(new Date('2026-05-06T12:00:00.000Z'));

      const requested = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'active-tick-refresh',
          purpose: 'tail-refresh',
        },
        refs: {
          stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
          sessionVisibleRangeRef: { current: new Map() },
          sessionBufferHeadsRef: { current: new Map() },
          sessionPullStateRef: {
            current: new Map([
              [sessionId, {
                'tail-refresh': {
                  purpose: 'tail-refresh',
                  startedAt: Date.now() - 4000,
                  targetHeadRevision: 1,
                  targetStartIndex: 0,
                  targetEndIndex: 72,
                  requestKnownRevision: 1,
                  requestLocalStartIndex: 0,
                  requestLocalEndIndex: 1,
                },
              }],
            ]),
          },
          lastSyncRequestAtRef: { current: new Map() },
          pendingInputTailRefreshRef: { current: new Map() },
          pendingConnectTailRefreshRef: { current: new Set() },
          pendingResumeTailRefreshRef: { current: new Set() },
        },
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState,
        sendSocketPayload,
        runtimeDebug,
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });

      expect(requested).toBe(true);
      expect(clearSessionPullState).toHaveBeenCalledWith(sessionId, 'tail-refresh');
      expect(runtimeDebug).toHaveBeenCalledWith(
        'session.buffer.pull.stale-expire',
        expect.objectContaining({
          sessionId,
          purpose: 'tail-refresh',
          thresholdMs: 1500,
        }),
      );
      expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });


  it('reissues a same-window tail refresh when daemon head revision advanced beyond the in-flight pull target', () => {
    const sessionId = 'session-1';
    const session = {
      ...makeSession(sessionId),
      daemonHeadRevision: 7,
      daemonHeadEndIndex: 120,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 120 }, (_, index) => `row-${index}`),
        startIndex: 0,
        endIndex: 120,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 120,
        cols: 80,
        rows: 24,
        revision: 5,
        cacheLines: 1000,
      }),
    };
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    const requested = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'buffer-head-update',
        purpose: 'tail-refresh',
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: {
          current: new Map([
            [sessionId, {
              'tail-refresh': {
                purpose: 'tail-refresh',
                startedAt: 1,
                targetHeadRevision: 6,
                targetStartIndex: 48,
                targetEndIndex: 120,
                requestKnownRevision: 5,
                requestLocalStartIndex: 0,
                requestLocalEndIndex: 120,
              },
            }],
          ]),
        },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
      },
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState: vi.fn(),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(requested).toBe(true);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'buffer-sync-request',
      payload: expect.objectContaining({
        knownRevision: 5,
        localStartIndex: 0,
        localEndIndex: 120,
        requestStartIndex: 48,
        requestEndIndex: 120,
      }),
    });
  });

  it('debounces duplicate tail-refresh sync requests within 33ms for the same semantic payload', () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      const ws = { readyState: WebSocket.OPEN } as any;
      const sendSocketPayload = vi.fn();
      const refs = {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set<string>() },
        pendingResumeTailRefreshRef: { current: new Set<string>() },
      };

      const first = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'active-tick',
          purpose: 'tail-refresh',
        },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug: vi.fn(),
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });
      const second = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'active-tick-duplicate',
          purpose: 'tail-refresh',
        },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug: vi.fn(),
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('widens same-end tail-refresh to the full local tail window when resume tail refresh is pending', () => {
    const sessionId = 'session-1';
    const session: Session = {
      ...makeSession(sessionId),
      daemonHeadRevision: 6,
      daemonHeadEndIndex: 80,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 72 }, (_, offset) => `row-${String(8 + offset).padStart(3, '0')}`),
        startIndex: 8,
        endIndex: 80,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 80,
        cols: 80,
        rows: 24,
        revision: 5,
        cacheLines: 1000,
      }),
    };
    session.buffer.gapRanges = [{ startIndex: 68, endIndex: 69 }];
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    const requested = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'explicit-resume',
        purpose: 'tail-refresh',
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map([[sessionId, { startIndex: 56, endIndex: 80, viewportRows: 24 }]]) },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set<string>() },
        pendingResumeTailRefreshRef: { current: new Set<string>([sessionId]) },
      },
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState: vi.fn(),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(requested).toBe(true);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'buffer-sync-request',
      payload: expect.objectContaining({
        knownRevision: 5,
        localStartIndex: 8,
        localEndIndex: 80,
        requestStartIndex: 8,
        requestEndIndex: 80,
      }),
    });
  });

  it('keeps input-driven same-end tail refresh scoped to the current visible tail screen instead of widening to the full cache window', () => {
    const sessionId = 'session-1';
    const session: Session = {
      ...makeSession(sessionId),
      daemonHeadRevision: 6,
      daemonHeadEndIndex: 80,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 72 }, (_, offset) => `row-${String(8 + offset).padStart(3, '0')}`),
        startIndex: 8,
        endIndex: 80,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 80,
        cols: 80,
        rows: 24,
        revision: 5,
        cacheLines: 1000,
      }),
    };
    session.buffer.gapRanges = [{ startIndex: 68, endIndex: 69 }];
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    const requested = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'input',
        purpose: 'tail-refresh',
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map([[sessionId, { startIndex: 56, endIndex: 80, viewportRows: 24 }]]) },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map([[sessionId, { requestedAt: 1, localRevision: 5 }]]) },
        pendingConnectTailRefreshRef: { current: new Set<string>() },
        pendingResumeTailRefreshRef: { current: new Set<string>() },
      },
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState: vi.fn(),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(requested).toBe(true);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'buffer-sync-request',
      payload: expect.objectContaining({
        knownRevision: 5,
        localStartIndex: 8,
        localEndIndex: 80,
        requestStartIndex: 56,
        requestEndIndex: 80,
      }),
    });
  });

  it('does not suppress reading-repair when missingRanges changed inside the same visible window', () => {
    const sessionId = 'session-1';
    const lines = Array.from({ length: 120 }, (_, index) => `row-${String(index + 1).padStart(3, '0')}`);
    const buffer = createSessionBufferState({
      lines,
      startIndex: 0,
      endIndex: 120,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
      cols: 80,
      rows: 24,
      revision: 5,
      cacheLines: 1000,
    });
    buffer.gapRanges = [{ startIndex: 60, endIndex: 61 }];

    const session: Session = {
      ...makeSession(sessionId),
      buffer,
      daemonHeadRevision: 5,
      daemonHeadEndIndex: 120,
    };

    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const clearSessionPullState = vi.fn();
    const refs = {
      stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
      sessionVisibleRangeRef: { current: new Map([[sessionId, { startIndex: 56, endIndex: 80, viewportRows: 24 }]]) },
      sessionBufferHeadsRef: { current: new Map() },
      sessionPullStateRef: { current: new Map() },
      lastSyncRequestAtRef: { current: new Map() },
      pendingInputTailRefreshRef: { current: new Map() },
      pendingConnectTailRefreshRef: { current: new Set<string>() },
      pendingResumeTailRefreshRef: { current: new Set<string>() },
    };

    const first = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'reading-gap-1',
        purpose: 'reading-repair',
      },
      refs,
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState,
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(first).toBe(true);
    const firstPayload = JSON.parse(sendSocketPayload.mock.calls[0][2]).payload;
    const firstSendOptions = sendSocketPayload.mock.calls[0][3];
    expect(firstPayload.missingRanges).toEqual([{ startIndex: 60, endIndex: 61 }]);

    refs.sessionPullStateRef.current.set(sessionId, {
      'reading-repair': {
        purpose: 'reading-repair',
        startedAt: Date.now(),
        targetHeadRevision: firstSendOptions.targetHeadRevision,
        targetStartIndex: firstSendOptions.targetStartIndex,
        targetEndIndex: firstSendOptions.targetEndIndex,
        requestKnownRevision: firstSendOptions.requestKnownRevision,
        requestLocalStartIndex: firstSendOptions.requestLocalStartIndex,
        requestLocalEndIndex: firstSendOptions.requestLocalEndIndex,
      },
    });

    session.buffer = {
      ...session.buffer,
      gapRanges: [{ startIndex: 70, endIndex: 71 }],
    };

    const second = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'reading-gap-2',
        purpose: 'reading-repair',
      },
      refs,
      readSessionTransportSocket: () => ws,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState,
      sendSocketPayload,
      runtimeDebug: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
    });

    expect(second).toBe(true);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const secondPayload = JSON.parse(sendSocketPayload.mock.calls[1][2]).payload;
    expect(secondPayload.missingRanges).toEqual([{ startIndex: 70, endIndex: 71 }]);
  });

  it('allows reading-repair sync re-request after the 33ms debounce window expires', () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      const ws = { readyState: WebSocket.OPEN } as any;
      const sendSocketPayload = vi.fn();
      const refs = {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        lastSyncRequestAtRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set<string>() },
        pendingResumeTailRefreshRef: { current: new Set<string>() },
      };

      const runtimeDebug = vi.fn();
      const first = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'reading-1',
          purpose: 'reading-repair',
        },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug,
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });
      vi.advanceTimersByTime(34);
      const second = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'reading-2',
          purpose: 'reading-repair',
        },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug,
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule a render commit when buffer-head repeats the same head and cursor truth', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => false);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => false);
    const runtimeDebug = vi.fn();

    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: sessionId,
      setHead,
      sessionBufferHeadsEntries: [[sessionId, {
        revision: 0,
        latestEndIndex: 0,
        availableStartIndex: 0,
        availableEndIndex: 0,
        seenAt: 1,
      }]],
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 0,
      latestEndIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
      cursor: null,
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => false),
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(setHead).toHaveBeenCalledTimes(1);
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
  });

  it('does not schedule a render commit when buffer-head only advances daemon head metadata', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => false);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => true);

    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: sessionId,
      setHead,
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 2,
      latestEndIndex: 32,
      availableStartIndex: 0,
      availableEndIndex: 32,
      cursor: session.buffer.cursor,
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      runtimeDebug: vi.fn(),
      requestSessionBufferSync: vi.fn(() => false),
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(setHead).toHaveBeenCalledTimes(1);
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
  });

  it('schedules a render commit when buffer-head updates cursor metadata', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => false);

    const refs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: sessionId,
      setHead,
    });

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 1,
      latestEndIndex: 1,
      availableStartIndex: 0,
      availableEndIndex: 1,
      cursor: {
        rowIndex: 0,
        col: 4,
        visible: true,
      },
      refs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      runtimeDebug: vi.fn(),
      requestSessionBufferSync: vi.fn(() => false),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledTimes(1);
    expect(setHead).toHaveBeenCalledTimes(1);
    expect(scheduleSessionRenderCommit).toHaveBeenCalledTimes(1);
  });

});

describe('P5 post-apply catchup trimming', () => {
  it('does not request tail-refresh catchup when liveHead revision did not advance and local tail already caught up', () => {
    const sessionId = 'session-p5-1';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: ['alpha', 'beta'],
      startIndex: 0,
      endIndex: 2,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 2,
      cols: 80,
      rows: 24,
      revision: 2,
      cacheLines: 1000,
    });
    session.daemonHeadRevision = 2;
    session.daemonHeadEndIndex = 2;

    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 2,
        startIndex: 0,
        endIndex: 2,
        lines: [['alpha'], ['beta']] as any,
        cols: 80,
        rows: 24,
        cursor: null,
        cursorKeysApp: false,
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map([[sessionId, {
          revision: 2,
          latestEndIndex: 2,
          availableStartIndex: 0,
          availableEndIndex: 2,
          seenAt: 100,
        }]]) },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map([[sessionId, buildDefaultSessionVisibleRange(session)]]) },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({ revision: payload.revision, startIndex: payload.startIndex, endIndex: payload.endIndex }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-catchup', purpose: 'tail-refresh' }),
    );
  });

  it('does not request visible-range repair when current payload already covers visible range', () => {
    const sessionId = 'session-p5-2';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: ['alpha', 'beta', 'gamma'],
      startIndex: 0,
      endIndex: 3,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 3,
      cols: 80,
      rows: 24,
      revision: 3,
      cacheLines: 1000,
    });

    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 3,
        startIndex: 0,
        endIndex: 3,
        lines: [['alpha'], ['beta'], ['gamma']] as any,
        cols: 80,
        rows: 24,
        cursor: null,
        cursorKeysApp: false,
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map([[sessionId, {
          revision: 3,
          latestEndIndex: 3,
          availableStartIndex: 0,
          availableEndIndex: 3,
          seenAt: 100,
        }]]) },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map([[sessionId, {
          startIndex: 0,
          endIndex: 3,
          stickToBottom: true,
          measuredRows: 3,
          measuredCols: 80,
          scrollOffset: 0,
          pinnedBottomRows: 3,
        } as any]]) },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({ revision: payload.revision, startIndex: payload.startIndex, endIndex: payload.endIndex }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate: vi.fn(() => true),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-visible-range-repair-catchup', purpose: 'reading-repair' }),
    );
  });

  it('requests visible tail repair when a sparse tail payload jumps beyond the previous follow viewport', () => {
    const sessionId = 'session-p5-tail-gap';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: Array.from({ length: 120 }, (_, index) => `old-${String(index + 1).padStart(3, '0')}`),
      startIndex: 0,
      endIndex: 120,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
      cols: 80,
      rows: 24,
      revision: 5,
      cacheLines: 1000,
    });
    session.daemonHeadRevision = 6;
    session.daemonHeadEndIndex = 240;

    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 6,
        startIndex: 168,
        endIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
        lines: [{
          index: 239,
          cells: Array.from('new-tail').map((char) => ({
            char: char.codePointAt(0) || 32,
            fg: 256,
            bg: 256,
            flags: 0,
            width: 1,
          })),
        }],
        cols: 80,
        rows: 24,
        cursor: null,
        cursorKeysApp: false,
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map([[sessionId, {
          revision: 6,
          latestEndIndex: 240,
          availableStartIndex: 0,
          availableEndIndex: 240,
          seenAt: 100,
        }]]) },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map([[sessionId, {
          startIndex: 96,
          endIndex: 120,
          viewportRows: 24,
        }]]) },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({ revision: payload.revision, startIndex: payload.startIndex, endIndex: payload.endIndex }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate: vi.fn(() => true),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-visible-range-repair-catchup', purpose: 'reading-repair' }),
    );
  });

  it('does not reinterpret a reading visible range as tail after a sparse tail jump', () => {
    const sessionId = 'session-p5-reading-gap';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: Array.from({ length: 120 }, (_, index) => `old-${String(index + 1).padStart(3, '0')}`),
      startIndex: 0,
      endIndex: 120,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
      cols: 80,
      rows: 24,
      revision: 5,
      cacheLines: 1000,
    });
    session.daemonHeadRevision = 6;
    session.daemonHeadEndIndex = 240;

    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 6,
        startIndex: 168,
        endIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
        lines: [{
          index: 239,
          cells: Array.from('new-tail').map((char) => ({
            char: char.codePointAt(0) || 32,
            fg: 256,
            bg: 256,
            flags: 0,
            width: 1,
          })),
        }],
        cols: 80,
        rows: 24,
        cursor: null,
        cursorKeysApp: false,
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map([[sessionId, {
          revision: 6,
          latestEndIndex: 240,
          availableStartIndex: 0,
          availableEndIndex: 240,
          seenAt: 100,
        }]]) },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map([[sessionId, {
          startIndex: 40,
          endIndex: 64,
          viewportRows: 24,
        }]]) },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({ revision: payload.revision, startIndex: payload.startIndex, endIndex: payload.endIndex }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate: vi.fn(() => true),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-visible-range-repair-catchup', purpose: 'reading-repair' }),
    );
  });

  it('still requests tail-refresh catchup when liveHead revision is ahead of local buffer', () => {
    const sessionId = 'session-p5-3';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: ['alpha', 'beta'],
      startIndex: 0,
      endIndex: 2,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 2,
      cols: 80,
      rows: 24,
      revision: 2,
      cacheLines: 1000,
    });
    session.daemonHeadRevision = 5;
    session.daemonHeadEndIndex = 5;

    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 2,
        startIndex: 0,
        endIndex: 2,
        lines: [['alpha'], ['beta']] as any,
        cols: 80,
        rows: 24,
        cursor: null,
        cursorKeysApp: false,
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map([[sessionId, {
          revision: 5,
          latestEndIndex: 5,
          availableStartIndex: 0,
          availableEndIndex: 5,
          seenAt: 100,
        }]]) },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map([[sessionId, buildDefaultSessionVisibleRange(session)]]) },
      },
      readSessionBufferSnapshot: () => session.buffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (payload) => ({ revision: payload.revision, startIndex: payload.startIndex, endIndex: payload.endIndex }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate: vi.fn(() => true),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-catchup', purpose: 'tail-refresh' }),
    );
  });
});
