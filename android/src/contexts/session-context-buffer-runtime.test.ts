// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session, SessionBufferState, TerminalBufferPayload } from '../lib/types';
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

function cellsToText(cells: Array<{ char?: number; width?: number }>) {
  return cells
    .filter((cell) => cell.width !== 0)
    .map((cell) => String.fromCodePoint(typeof cell.char === 'number' ? cell.char : 32))
    .join('');
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
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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

  it('applies many consecutive same-window body row updates and schedules a render commit', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: Array.from({ length: 100 }, (_, offset) => `old-${String(100 + offset).padStart(3, '0')}`),
      startIndex: 100,
      endIndex: 200,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 200,
      cols: 80,
      rows: 24,
      revision: 20,
      cacheLines: 1000,
    });
    const committedBuffers: SessionBufferState[] = [];
    const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 21,
        startIndex: 100,
        endIndex: 200,
        availableStartIndex: 100,
        availableEndIndex: 200,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: Array.from({ length: 96 }, (_, offset) => {
          const absoluteIndex = 104 + offset;
          return {
            ...makeLine(`new-${String(absoluteIndex).padStart(3, '0')}`),
            index: absoluteIndex,
          };
        }),
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([
            [sessionId, {
              revision: 21,
              latestEndIndex: 200,
              availableStartIndex: 100,
              availableEndIndex: 200,
              seenAt: 1,
            }],
          ]),
        },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: { current: new Map() },
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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
    const nextBuffer = committedBuffers[0]!;
    expect(nextBuffer.revision).toBe(21);
    expect(nextBuffer.startIndex).toBe(100);
    expect(nextBuffer.endIndex).toBe(200);
    expect(cellsToText(nextBuffer.lines[0])).toBe('old-100');
    expect(cellsToText(nextBuffer.lines[4])).toBe('new-104');
    expect(cellsToText(nextBuffer.lines[99])).toBe('new-199');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        reason: 'buffer-sync-revision-gap-sparse-payload',
      }),
    );
  });

  it('drops stale same-revision buffer-sync that would overwrite existing non-gap rows', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['new-100', 'new-101', 'new-102', 'new-103'],
      startIndex: 100,
      endIndex: 104,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 104,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);
    const runtimeDebug = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('old-100'), index: 100 },
          { ...makeLine('old-101'), index: 101 },
          { ...makeLine('old-102'), index: 102 },
          { ...makeLine('old-103'), index: 103 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastSyncRequestAtRef: {
          current: new Map([[`${sessionId}:tail-refresh`, {
            sentAt: 10,
            requestStartIndex: 102,
            requestEndIndex: 104,
            knownRevision: 10,
            localStartIndex: 100,
            localEndIndex: 104,
            targetHeadRevision: 10,
            repairSignature: '',
          }]]),
        },
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(requestSessionBufferSync).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.stale-same-revision-drop',
      expect.objectContaining({
        sessionId,
        localRevision: 10,
        incomingRevision: 10,
        conflictCount: 4,
      }),
    );
  });

  it('applies same-revision overwrite when it is the requested visible refresh after reconnect', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['old-top-100', 'old-top-101', 'live-bottom-102', 'live-bottom-103'],
      startIndex: 100,
      endIndex: 104,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 104,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    const committedBuffers: SessionBufferState[] = [];
    const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const lastSyncRequestAtRef = {
      current: new Map([[`${sessionId}:tail-refresh`, {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 100,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]]),
    };

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('fresh-top-100'), index: 100 },
          { ...makeLine('fresh-top-101'), index: 101 },
          { ...makeLine('live-bottom-102'), index: 102 },
          { ...makeLine('live-bottom-103'), index: 103 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([[sessionId, {
            revision: 10,
            latestEndIndex: 104,
            availableStartIndex: 100,
            availableEndIndex: 104,
            seenAt: 10,
          }]]),
        },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set([sessionId]) },
        lastSyncRequestAtRef,
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 100, endIndex: 104, viewportRows: 4 }]]),
        },
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
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledOnce();
    expect(cellsToText(committedBuffers[0]!.lines[0])).toBe('fresh-top-100');
    expect(cellsToText(committedBuffers[0]!.lines[1])).toBe('fresh-top-101');
    expect(cellsToText(committedBuffers[0]!.lines[2])).toBe('live-bottom-102');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(false);
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.same-revision-requested-overwrite-apply',
      expect.objectContaining({
        sessionId,
        localRevision: 10,
        incomingRevision: 10,
        conflictCount: 2,
      }),
    );
  });

  it('applies requested same-revision tail repaint when the daemon response is a larger stable superset', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['stable-096', 'stable-097', 'stable-098', 'stable-099', 'stale-input-100', 'stale-input-101', 'stable-tail-102', 'stable-tail-103'],
      startIndex: 96,
      endIndex: 104,
      bufferHeadStartIndex: 96,
      bufferTailEndIndex: 104,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    const committedBuffers: SessionBufferState[] = [];
    const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const lastSyncRequestAtRef = {
      current: new Map([[`${sessionId}:tail-refresh`, {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 96,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]]),
    };

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 96,
        endIndex: 104,
        availableStartIndex: 96,
        availableEndIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('stable-096'), index: 96 },
          { ...makeLine('stable-097'), index: 97 },
          { ...makeLine('stable-098'), index: 98 },
          { ...makeLine('stable-099'), index: 99 },
          { ...makeLine('fresh-input-100'), index: 100 },
          { ...makeLine('fresh-input-101'), index: 101 },
          { ...makeLine('stable-tail-102'), index: 102 },
          { ...makeLine('stable-tail-103'), index: 103 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([[sessionId, {
            revision: 10,
            latestEndIndex: 104,
            availableStartIndex: 96,
            availableEndIndex: 104,
            seenAt: 10,
          }]]),
        },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set([sessionId]) },
        lastSyncRequestAtRef,
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 96, endIndex: 104, viewportRows: 8 }]]),
        },
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
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledOnce();
    expect(cellsToText(committedBuffers[0]!.lines[4])).toBe('fresh-input-100');
    expect(cellsToText(committedBuffers[0]!.lines[5])).toBe('fresh-input-101');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(false);
  });

  it('keeps pending tail-refresh authority when buffer-head arrives before the same-revision body response', () => {
    const sessionId = 'session-1';
    const baseSession = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['stale-input-100', 'stale-input-101', 'stable-tail-102', 'stable-tail-103'],
      startIndex: 100,
      endIndex: 104,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 104,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    const session: Session = {
      ...baseSession,
      buffer: localBuffer,
      daemonHeadRevision: 10,
      daemonHeadEndIndex: 104,
    };
    const committedBuffers: SessionBufferState[] = [];
    const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const lastSyncRequestAtRef = {
      current: new Map([[`${sessionId}:tail-refresh`, {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 100,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]]),
    };
    const headRefs = makeHeadRuntimeRefs({
      sessions: [session],
      activeSessionId: sessionId,
      visibleRangeEntries: [[sessionId, { startIndex: 100, endIndex: 104, viewportRows: 4 }]],
      sessionBufferHeadsEntries: [[sessionId, {
        revision: 10,
        latestEndIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        seenAt: 10,
      }]],
    });
    headRefs.lastSyncRequestAtRef = lastSyncRequestAtRef;

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 10,
      latestEndIndex: 104,
      availableStartIndex: 100,
      availableEndIndex: 104,
      refs: headRefs,
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      readSessionBufferSnapshot: () => localBuffer,
      commitSessionBufferUpdate: vi.fn(() => false),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => false),
    });

    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(true);

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('fresh-input-100'), index: 100 },
          { ...makeLine('fresh-input-101'), index: 101 },
          { ...makeLine('stable-tail-102'), index: 102 },
          { ...makeLine('stable-tail-103'), index: 103 },
        ],
      },
      refs: {
        stateRef: headRefs.stateRef,
        sessionRevisionResetRef: headRefs.sessionRevisionResetRef,
        sessionBufferHeadsRef: headRefs.sessionBufferHeadsRef,
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set([sessionId]) },
        lastSyncRequestAtRef,
        sessionVisibleRangeRef: headRefs.sessionVisibleRangeRef,
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
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledOnce();
    expect(cellsToText(committedBuffers[0]!.lines[0])).toBe('fresh-input-100');
    expect(cellsToText(committedBuffers[0]!.lines[1])).toBe('fresh-input-101');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(false);
  });

  it('drops lower-revision buffer-sync instead of repainting older rows over newer rows', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['new-100', 'new-101', 'new-102', 'new-103'],
      startIndex: 100,
      endIndex: 104,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 104,
      cols: 80,
      rows: 24,
      revision: 12,
      cacheLines: 1000,
    });
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const requestSessionBufferSync = vi.fn(() => true);
    const runtimeDebug = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 11,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('old-100'), index: 100 },
          { ...makeLine('old-101'), index: 101 },
          { ...makeLine('old-102'), index: 102 },
          { ...makeLine('old-103'), index: 103 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: {
          current: new Map([
            [sessionId, {
              revision: 12,
              latestEndIndex: 104,
              availableStartIndex: 100,
              availableEndIndex: 104,
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
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(requestSessionBufferSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        reason: 'buffer-sync-stale-lower-revision-drop',
        purpose: 'tail-refresh',
        liveHead: expect.objectContaining({
          revision: 12,
          latestEndIndex: 104,
        }),
      }),
    );
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.stale-lower-revision-drop',
      expect.objectContaining({
        sessionId,
        localRevision: 12,
        incomingRevision: 11,
      }),
    );
  });

  it('still applies same-revision buffer-sync when it fills a local gap', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const baseBuffer = createSessionBufferState({
      lines: ['new-100', '', 'new-102'],
      startIndex: 100,
      endIndex: 103,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 103,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    const localBuffer: SessionBufferState = {
      ...baseBuffer,
      gapRanges: [{ startIndex: 101, endIndex: 102 }],
    };
    const committedBuffers: SessionBufferState[] = [];
    const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 101,
        endIndex: 102,
        availableStartIndex: 100,
        availableEndIndex: 103,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('new-101'), index: 101 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
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
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledOnce();
    expect(committedBuffers[0]?.gapRanges).toEqual([]);
    expect(cellsToText(committedBuffers[0]!.lines[1])).toBe('new-101');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
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

  it('stamps outgoing buffer-sync requests with client request time metadata', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(4444);
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      const ws = { readyState: WebSocket.OPEN } as any;
      const sendSocketPayload = vi.fn();
      const lastSyncRequestAtRef = { current: new Map() };

      const requested = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: {
          reason: 'test-requested-at',
          purpose: 'tail-refresh',
        },
        refs: {
          stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
          sessionVisibleRangeRef: {
            current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
          },
          sessionBufferHeadsRef: { current: new Map() },
          sessionPullStateRef: { current: new Map() },
          lastSyncRequestAtRef,
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
      const sent = JSON.parse(String(sendSocketPayload.mock.calls[0]?.[2]));
      expect(sent).toMatchObject({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestedAt: 4444,
        }),
      });
      expect(lastSyncRequestAtRef.current.get(`${sessionId}:tail-refresh`)).toMatchObject({
        sentAt: 4444,
      });
    } finally {
      nowSpy.mockRestore();
    }
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
          sessionVisibleRangeRef: {
            current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
          },
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


  it('does not reissue a body refresh without renderer visible range for non-head call sites', () => {
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

    expect(requested).toBe(false);
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('bootstraps active tail body sync when head arrives before renderer visible range', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    session.buffer = createSessionBufferState({
      lines: ['old-1', 'old-2'],
      startIndex: 10,
      endIndex: 12,
      bufferHeadStartIndex: 10,
      bufferTailEndIndex: 12,
      cols: 80,
      rows: 24,
      revision: 2,
      cacheLines: 1000,
    });
    const requestSessionBufferSync = vi.fn(() => true);

    handleBufferHeadRuntime({
      sessionId,
      latestRevision: 9,
      latestEndIndex: 240,
      availableStartIndex: 0,
      availableEndIndex: 240,
      refs: makeHeadRuntimeRefs({
        sessions: [session],
        activeSessionId: sessionId,
      }),
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN }) as any,
      readSessionBufferSnapshot: () => session.buffer,
      commitSessionBufferUpdate: vi.fn(() => false),
      scheduleSessionRenderCommit: vi.fn(),
      isSessionTransportActive: () => true,
      runtimeDebug: vi.fn(),
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        reason: 'buffer-head-no-visible-range-active-bootstrap',
        purpose: 'tail-refresh',
        requestWindowOverride: {
          requestStartIndex: 216,
          requestEndIndex: 240,
        },
      }),
    );
  });

  it('reissues a visible-window tail refresh when daemon head revision advanced beyond the in-flight pull target', () => {
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
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 96, endIndex: 120, viewportRows: 24 }]]),
        },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: {
          current: new Map([
            [sessionId, {
              'tail-refresh': {
                purpose: 'tail-refresh',
                startedAt: 1,
                targetHeadRevision: 6,
                targetStartIndex: 96,
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
        requestStartIndex: 96,
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
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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

  it('keeps same-end resume tail-refresh scoped to the visible tail window', () => {
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
        requestStartIndex: 56,
        requestEndIndex: 80,
      }),
    });
  });

  it('keeps input-driven same-end tail refresh scoped to the current visible tail screen instead of hidden cache rows', () => {
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
    expect(firstSendOptions.targetStartIndex).toBe(60);
    expect(firstSendOptions.targetEndIndex).toBe(61);

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
    const secondSendOptions = sendSocketPayload.mock.calls[1][3];
    expect(secondPayload.missingRanges).toEqual([{ startIndex: 70, endIndex: 71 }]);
    expect(secondSendOptions.targetStartIndex).toBe(70);
    expect(secondSendOptions.targetEndIndex).toBe(71);
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
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
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

  it('applies buffer-head cursor metadata without scheduling a body render commit', () => {
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

    const runtimeDebug = vi.fn();

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
      runtimeDebug,
      requestSessionBufferSync: vi.fn(() => false),
    });

    expect(commitSessionBufferUpdate).toHaveBeenCalledTimes(1);
    expect(setHead).toHaveBeenCalledTimes(1);
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.head.cursor-metadata-applied-no-body-render',
      expect.objectContaining({
        sessionId,
        latestRevision: 1,
      }),
    );
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
