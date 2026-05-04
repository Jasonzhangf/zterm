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

describe('session-context-buffer-runtime inactive gating', () => {
  it('drops inactive buffer-head before buffer/head/render apply', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => true);
    const runtimeDebug = vi.fn();
    const lastHeadRequestAtRef = { current: new Map<string, number>() };
    const sessionBufferHeadsRef = { current: new Map<string, any>() };

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
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: 'other-session' } },
        sessionBufferHeadsRef,
        lastHeadRequestAtRef,
        sessionRevisionResetRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferStoreRef: { current: { setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead } },
      },
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => false,
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(sessionBufferHeadsRef.current.get(sessionId)).toMatchObject({
      revision: 5,
      latestEndIndex: 20,
      availableStartIndex: 0,
      availableEndIndex: 20,
    });
    expect(lastHeadRequestAtRef.current.has(sessionId)).toBe(true);
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
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
      },
      readSessionTransportSocket: () => activeWs,
      readSessionBufferSnapshot: () => session.buffer,
      clearSessionPullState: vi.fn(),
      sendSocketPayload,
      runtimeDebug: vi.fn(),
    });

    expect(requested).toBe(false);
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('does not schedule a render commit when buffer-head repeats the same head and cursor truth', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const commitSessionBufferUpdate = vi.fn(() => false);
    const scheduleSessionRenderCommit = vi.fn();
    const setHead = vi.fn(() => false);
    const runtimeDebug = vi.fn();

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 0,
      latestEndIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
      cursor: null,
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionBufferHeadsRef: {
          current: new Map([
            [sessionId, {
              revision: 0,
              latestEndIndex: 0,
              availableStartIndex: 0,
              availableEndIndex: 0,
              seenAt: 1,
            }],
          ]),
        },
        lastHeadRequestAtRef: { current: new Map() },
        sessionRevisionResetRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferStoreRef: { current: { setBuffer: vi.fn() } },
        sessionHeadStoreRef: { current: { setHead } },
      },
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
});
