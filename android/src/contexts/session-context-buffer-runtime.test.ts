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
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';

function makeTailRefreshStoreRef(seed?: {
  input?: Array<[string, { requestedAt: number; localRevision: number }]>;
  connect?: string[];
  resume?: string[];
  syncRequests?: Array<[string, 'tail-refresh' | 'reading-repair', any]>;
}) {
  const store = createSessionTailRefreshStore();
  for (const [sid, state] of seed?.input || []) {
    store.markPendingInputTailRefresh(sid, state.localRevision, state.requestedAt);
  }
  for (const sid of seed?.connect || []) {
    store.markPendingConnectTailRefresh(sid);
  }
  for (const sid of seed?.resume || []) {
    store.markPendingResumeTailRefresh(sid);
  }
  for (const [sid, purpose, state] of seed?.syncRequests || []) {
    store.recordSyncRequest(sid, purpose, state);
  }
  return { current: store };
}

type TestSession = Session & {
  buffer: SessionBufferState;
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
};

function makeSession(sessionId: string): TestSession {
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
    daemonHeadRevision: 0,
    daemonHeadEndIndex: 0,
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

function makeLiveHeadStoreRef(entries?: Array<[string, any]>) {
  const liveHeads = new Map<string, any>(entries || []);
  return {
    current: {
      getLiveHead: (sessionId: string) => liveHeads.get(sessionId) || null,
      clearLiveHead: (sessionId: string) => {
        liveHeads.delete(sessionId);
      },
      setLiveHead: (sessionId: string, head: any) => {
        liveHeads.set(sessionId, head);
        return true;
      },
    },
  };
}

function makeHeadRuntimeRefs(options: {
  sessions: Session[];
  activeSessionId: string;
  setHead?: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
  visibleRangeEntries?: Array<[string, ReturnType<typeof buildDefaultSessionVisibleRange>]>;
  sessionBufferHeadsEntries?: Array<[string, any]>;
}) {
  const liveHeads = new Map<string, any>(options.sessionBufferHeadsEntries || []);
  const setHead = options.setHead || vi.fn(() => true);
  return {
    stateRef: { current: { sessions: options.sessions, activeSessionId: options.activeSessionId } },
    lastHeadRequestAtRef: { current: new Map<string, number>() },
    tailRefreshStoreRef: makeTailRefreshStoreRef(),
    sessionRevisionResetRef: { current: new Map() },
    sessionVisibleRangeRef: { current: new Map(options.visibleRangeEntries || []) },
    sessionBufferStoreRef: { current: { commitBuffer: vi.fn(() => false) } },
    sessionHeadStoreRef: {
      current: {
        setLiveHead: (
          sessionId: string,
          head: any,
          setOptions?: { publishRenderer?: boolean },
        ) => {
          liveHeads.set(sessionId, head);
          if (setOptions?.publishRenderer === false) {
            return false;
          }
          return setHead(sessionId, {
            daemonHeadRevision: head.revision,
            daemonHeadEndIndex: head.latestEndIndex,
          });
        },
        getLiveHead: (sessionId: string) => liveHeads.get(sessionId) || null,
      },
    },
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

    expect(refs.sessionHeadStoreRef.current.getLiveHead(sessionId)).toMatchObject({
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
    const tailRefreshStoreRef = makeTailRefreshStoreRef({
      input: [[sessionId, { requestedAt: 1, localRevision: 1 }]],
      connect: [sessionId],
      resume: [sessionId],
    });

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: makePayload(2),
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: 'other-session' } },
        sessionRevisionResetRef: { current: new Map() },
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        tailRefreshStoreRef,
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
    expect(tailRefreshStoreRef.current.hasPendingInputTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStoreRef.current.hasPendingConnectTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStoreRef.current.hasPendingResumeTailRefresh(sessionId)).toBe(false);
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([
            [sessionId, {
              revision: 8,
              latestEndIndex: 110,
              availableStartIndex: 100,
              availableEndIndex: 110,
              seenAt: 1,
            }],
          ]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([
            [sessionId, {
              revision: 8,
              latestEndIndex: 110,
              availableStartIndex: 100,
              availableEndIndex: 110,
              seenAt: 1,
            }],
          ]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([
            [sessionId, {
              revision: 21,
              latestEndIndex: 200,
              availableStartIndex: 100,
              availableEndIndex: 200,
              seenAt: 1,
            }],
          ]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        tailRefreshStoreRef: makeTailRefreshStoreRef({
          syncRequests: [[sessionId, 'tail-refresh', {
            sentAt: 10,
            requestStartIndex: 102,
            requestEndIndex: 104,
            knownRevision: 10,
            localStartIndex: 100,
            localEndIndex: 104,
            targetHeadRevision: 10,
            repairSignature: '',
          }]],
        }),
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
    const tailRefreshStoreRef = makeTailRefreshStoreRef({
      syncRequests: [[sessionId, 'tail-refresh', {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 100,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]],
    });

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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
            revision: 10,
            latestEndIndex: 104,
            availableStartIndex: 100,
            availableEndIndex: 104,
            seenAt: 10,
          }]]),
        tailRefreshStoreRef,
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
    expect(tailRefreshStoreRef.current.hasSyncRequest(sessionId, 'tail-refresh')).toBe(false);
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
    const tailRefreshStoreRef = makeTailRefreshStoreRef({
      syncRequests: [[sessionId, 'tail-refresh', {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 96,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]],
    });

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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
            revision: 10,
            latestEndIndex: 104,
            availableStartIndex: 96,
            availableEndIndex: 104,
            seenAt: 10,
          }]]),
        tailRefreshStoreRef,
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
    expect(tailRefreshStoreRef.current.hasSyncRequest(sessionId, 'tail-refresh')).toBe(false);
  });

  it('requests an authoritative visible repaint when a sparse revision advance could mask stale non-gap rows', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['stable-100', 'stable-101', 'stale-input-102', 'stale-input-103', 'old-status-104'],
      startIndex: 100,
      endIndex: 105,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 105,
      cols: 80,
      rows: 24,
      revision: 10,
      cacheLines: 1000,
    });
    session.buffer = localBuffer;
    session.daemonHeadRevision = 11;
    session.daemonHeadEndIndex = 105;
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
        revision: 11,
        startIndex: 104,
        endIndex: 105,
        availableStartIndex: 100,
        availableEndIndex: 105,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('new-status-104'), index: 104 },
        ],
      },
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
            revision: 11,
            latestEndIndex: 105,
            availableStartIndex: 100,
            availableEndIndex: 105,
            seenAt: 10,
          }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 100, endIndex: 105, viewportRows: 5 }]]),
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
    expect(cellsToText(committedBuffers[0]!.lines[2])).toBe('stale-input-102');
    expect(cellsToText(committedBuffers[0]!.lines[4])).toBe('new-status-104');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledWith(sessionId);
    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      reason: 'buffer-sync-visible-stale-non-gap-repair',
      purpose: 'reading-repair',
      requestWindowOverride: { requestStartIndex: 100, requestEndIndex: 105 },
      requestMissingRangesOverride: [{ startIndex: 100, endIndex: 105 }],
    }));
  });

  it('does not amplify repeated same-tail sparse updates into visible repair requests every frame', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = 10_000;
    nowSpy.mockImplementation(() => now);
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      let localBuffer = createSessionBufferState({
        lines: ['stable-100', 'stable-101', 'stale-input-102', 'stale-input-103', 'old-status-104'],
        startIndex: 100,
        endIndex: 105,
        bufferHeadStartIndex: 100,
        bufferTailEndIndex: 105,
        cols: 80,
        rows: 24,
        revision: 10,
        cacheLines: 1000,
      });
      session.buffer = localBuffer;
      session.daemonHeadRevision = 11;
      session.daemonHeadEndIndex = 105;
      const commitSessionBufferUpdate = vi.fn((_sessionId: string, nextBuffer: SessionBufferState) => {
        localBuffer = nextBuffer;
        session.buffer = nextBuffer;
        return true;
      });
      const scheduleSessionRenderCommit = vi.fn();
      const requestSessionBufferSync = vi.fn((_sessionId: string, requestOptions?: any) => {
        const requestWindow = requestOptions?.requestWindowOverride || { requestStartIndex: 100, requestEndIndex: 105 };
        refs.tailRefreshStoreRef.current.recordSyncRequest(sessionId, 'reading-repair', {
          sentAt: now,
          requestStartIndex: requestWindow.requestStartIndex,
          requestEndIndex: requestWindow.requestEndIndex,
          knownRevision: localBuffer.revision,
          localStartIndex: localBuffer.startIndex,
          localEndIndex: localBuffer.endIndex,
          targetHeadRevision: Math.max(0, Math.floor(requestOptions?.headOverride?.daemonHeadRevision || 0)),
          repairSignature: '',
        });
        return true;
      });
      const runtimeDebug = vi.fn();
      const refs = {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 11,
          latestEndIndex: 105,
          availableStartIndex: 100,
          availableEndIndex: 105,
          seenAt: now,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 100, endIndex: 105, viewportRows: 5 }]]),
        },
      };

      const applySparseStatus = (revision: number, text: string) => {
        refs.sessionHeadStoreRef.current.setLiveHead(sessionId, {
          revision,
          latestEndIndex: 105,
          availableStartIndex: 100,
          availableEndIndex: 105,
          seenAt: now,
        });
        applyIncomingBufferSyncRuntime({
          sessionId,
          payload: {
            revision,
            startIndex: 104,
            endIndex: 105,
            availableStartIndex: 100,
            availableEndIndex: 105,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            lines: [
              { ...makeLine(text), index: 104 },
            ],
          },
          refs,
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
      };

      applySparseStatus(11, 'new-status-104-a');
      now += 200;
      applySparseStatus(12, 'new-status-104-b');
      now += 200;
      applySparseStatus(13, 'new-status-104-c');

      expect(commitSessionBufferUpdate).toHaveBeenCalledTimes(3);
      expect(scheduleSessionRenderCommit).toHaveBeenCalledTimes(3);
      expect(requestSessionBufferSync).toHaveBeenCalledTimes(1);
      expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        headOverride: { daemonHeadRevision: 11, daemonHeadEndIndex: 105 },
      }));
      expect(cellsToText(localBuffer.lines[4]!)).toBe('new-status-104-c');
      expect(runtimeDebug).toHaveBeenCalledWith(
        'session.buffer.sync.visible-stale-non-gap-repair-suppressed',
        expect.objectContaining({
          sessionId,
          requestStartIndex: 100,
          requestEndIndex: 105,
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('applies later chunks from the same authoritative revision frame instead of treating them as stale', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    let localBuffer = createSessionBufferState({
      lines: ['old-100', 'old-101', 'old-102', 'old-103'],
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
      localBuffer = nextBuffer;
      committedBuffers.push(nextBuffer);
      return true;
    });
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();
    const refs = {
      stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
      sessionRevisionResetRef: { current: new Map() },
      sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 11,
          latestEndIndex: 104,
          availableStartIndex: 100,
          availableEndIndex: 104,
          seenAt: 10,
        }]]),
      tailRefreshStoreRef: makeTailRefreshStoreRef(),
      sameRevisionChunkFrameRef: { current: new Map<string, any>() },
      sessionVisibleRangeRef: {
        current: new Map([[sessionId, { startIndex: 100, endIndex: 104, viewportRows: 4 }]]),
      },
    };
    const apply = (payload: TerminalBufferPayload) => applyIncomingBufferSyncRuntime({
      sessionId,
      payload,
      refs,
      readSessionBufferSnapshot: () => localBuffer,
      resolveSessionCacheLines: () => 1000,
      summarizeBufferPayload: (item) => ({
        revision: item.revision,
        startIndex: item.startIndex,
        endIndex: item.endIndex,
        lineCount: item.lines.length,
      }),
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit,
      isSessionTransportActive: () => true,
      requestSessionBufferSync: vi.fn(() => true),
    });

    apply({
      revision: 11,
      startIndex: 100,
      endIndex: 102,
      availableStartIndex: 100,
      availableEndIndex: 104,
      frameStartIndex: 100,
      frameEndIndex: 104,
      frameChunkIndex: 0,
      frameChunkCount: 2,
      generatedAt: 1234,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      lines: [
        { ...makeLine('new-100'), index: 100 },
        { ...makeLine('new-101'), index: 101 },
      ],
    } as TerminalBufferPayload);
    apply({
      revision: 11,
      startIndex: 102,
      endIndex: 104,
      availableStartIndex: 100,
      availableEndIndex: 104,
      frameStartIndex: 100,
      frameEndIndex: 104,
      frameChunkIndex: 1,
      frameChunkCount: 2,
      generatedAt: 1234,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      lines: [
        { ...makeLine('new-102'), index: 102 },
        { ...makeLine('new-103'), index: 103 },
      ],
    } as TerminalBufferPayload);

    expect(commitSessionBufferUpdate).toHaveBeenCalledTimes(2);
    expect(cellsToText(localBuffer.lines[0])).toBe('new-100');
    expect(cellsToText(localBuffer.lines[1])).toBe('new-101');
    expect(cellsToText(localBuffer.lines[2])).toBe('new-102');
    expect(cellsToText(localBuffer.lines[3])).toBe('new-103');
    expect(scheduleSessionRenderCommit).toHaveBeenCalledTimes(2);
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.buffer.sync.stale-same-revision-drop',
      expect.anything(),
    );
  });

  it('does not let chunk metadata alone authorize an unsolicited same-revision overwrite', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const localBuffer = createSessionBufferState({
      lines: ['new-100', 'new-101'],
      startIndex: 100,
      endIndex: 102,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 102,
      cols: 80,
      rows: 24,
      revision: 11,
      cacheLines: 1000,
    });
    const commitSessionBufferUpdate = vi.fn(() => true);
    const scheduleSessionRenderCommit = vi.fn();
    const runtimeDebug = vi.fn();

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 11,
        startIndex: 100,
        endIndex: 102,
        availableStartIndex: 100,
        availableEndIndex: 104,
        frameStartIndex: 100,
        frameEndIndex: 104,
        frameChunkIndex: 1,
        frameChunkCount: 2,
        generatedAt: 1234,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [
          { ...makeLine('old-100'), index: 100 },
          { ...makeLine('old-101'), index: 101 },
        ],
      } as TerminalBufferPayload,
      refs: {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionRevisionResetRef: { current: new Map() },
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
        sameRevisionChunkFrameRef: { current: new Map<string, any>() },
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
      requestSessionBufferSync: vi.fn(() => true),
    });

    expect(commitSessionBufferUpdate).not.toHaveBeenCalled();
    expect(scheduleSessionRenderCommit).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.sync.stale-same-revision-drop',
      expect.objectContaining({
        sessionId,
        localRevision: 11,
        incomingRevision: 11,
      }),
    );
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
    const session: TestSession = {
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
    const tailRefreshStoreRef = makeTailRefreshStoreRef({
      syncRequests: [[sessionId, 'tail-refresh', {
        sentAt: 10,
        requestStartIndex: 100,
        requestEndIndex: 104,
        knownRevision: 10,
        localStartIndex: 100,
        localEndIndex: 104,
        targetHeadRevision: 10,
        repairSignature: '',
      }]],
    });
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
    headRefs.tailRefreshStoreRef = tailRefreshStoreRef;

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

    expect(tailRefreshStoreRef.current.hasSyncRequest(sessionId, 'tail-refresh')).toBe(true);

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
        sessionHeadStoreRef: headRefs.sessionHeadStoreRef,
        tailRefreshStoreRef,
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
    expect(tailRefreshStoreRef.current.hasSyncRequest(sessionId, 'tail-refresh')).toBe(false);
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([
            [sessionId, {
              revision: 12,
              latestEndIndex: 104,
              availableStartIndex: 100,
              availableEndIndex: 104,
              seenAt: 1,
            }],
          ]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
    const session: TestSession = {
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
    const tailRefreshStoreRef = makeTailRefreshStoreRef({
      syncRequests: [[sessionId, 'tail-refresh', {
        sentAt: 10,
        requestStartIndex: 0,
        requestEndIndex: 30,
        knownRevision: 1,
        localStartIndex: 0,
        localEndIndex: 1,
        targetHeadRevision: 3,
        repairSignature: '',
      }]],
    });
    const sessionRevisionResetRef = {
      current: new Map([[sessionId, { revision: 3, latestEndIndex: 30, seenAt: 1 }]]),
    };
    const sessionHeadStoreRef = makeLiveHeadStoreRef([[sessionId, { revision: 3, latestEndIndex: 30, seenAt: 1 }]]);

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
        sessionHeadStoreRef,
        tailRefreshStoreRef,
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
    expect(tailRefreshStoreRef.current.hasSyncRequest(sessionId, 'tail-refresh')).toBe(false);
    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, {
      reason: 'revision-reset-empty-payload-retry',
      purpose: 'tail-refresh',
      headOverride: expect.objectContaining({
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
      const tailRefreshStoreRef = makeTailRefreshStoreRef();

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
          sessionHeadStoreRef: makeLiveHeadStoreRef(),
          sessionPullStateRef: { current: new Map() },
          tailRefreshStoreRef,
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
      expect(tailRefreshStoreRef.current.readSyncRequest(sessionId, 'tail-refresh')).toMatchObject({
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
          sessionHeadStoreRef: makeLiveHeadStoreRef(),
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
          tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
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
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, { revision: 7, latestEndIndex: 120, seenAt: 1 }]]),
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
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
    const session: TestSession = {
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, { revision: 6, latestEndIndex: 80, seenAt: 1 }]]),
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: makeTailRefreshStoreRef({ resume: [sessionId] }),
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
    const session: TestSession = {
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, { revision: 6, latestEndIndex: 80, seenAt: 1 }]]),
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: makeTailRefreshStoreRef({
          input: [[sessionId, { requestedAt: 1, localRevision: 5 }]],
        }),
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

    const session: TestSession = {
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
      sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, { revision: 5, latestEndIndex: 120, seenAt: 1 }]]),
      sessionPullStateRef: { current: new Map() },
      tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef(),
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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

  it('uses explicit headOverride for reading-repair even when live head store is stale', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const refs = {
      stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
      sessionVisibleRangeRef: {
        current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
      },
      sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
        revision: 6,
        latestEndIndex: 1,
        seenAt: 1,
      }]]),
      sessionPullStateRef: { current: new Map() },
      tailRefreshStoreRef: makeTailRefreshStoreRef(),
    };

    const requested = requestSessionBufferSyncRuntime({
      sessionId,
      requestOptions: {
        reason: 'visible-non-gap-repair',
        purpose: 'reading-repair',
        headOverride: { daemonHeadRevision: 9, daemonHeadEndIndex: 1 },
        requestWindowOverride: { requestStartIndex: 0, requestEndIndex: 1 },
        requestMissingRangesOverride: [{ startIndex: 0, endIndex: 1 }],
      },
      refs,
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
        targetHeadRevision: 9,
        requestStartIndex: 0,
        requestEndIndex: 1,
      }),
    });
    expect(sendSocketPayload.mock.calls[0][3]).toMatchObject({
      pullPurpose: 'reading-repair',
      targetHeadRevision: 9,
      targetStartIndex: 0,
      targetEndIndex: 1,
    });
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 2,
          latestEndIndex: 2,
          availableStartIndex: 0,
          availableEndIndex: 2,
          seenAt: 100,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
        sessionVisibleRangeRef: { current: new Map([[sessionId, buildDefaultSessionVisibleRange(session, undefined, session.buffer)]]) },
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 3,
          latestEndIndex: 3,
          availableStartIndex: 0,
          availableEndIndex: 3,
          seenAt: 100,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 6,
          latestEndIndex: 240,
          availableStartIndex: 0,
          availableEndIndex: 240,
          seenAt: 100,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 6,
          latestEndIndex: 240,
          availableStartIndex: 0,
          availableEndIndex: 240,
          seenAt: 100,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
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
        sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 5,
          latestEndIndex: 5,
          availableStartIndex: 0,
          availableEndIndex: 5,
          seenAt: 100,
        }]]),
        tailRefreshStoreRef: makeTailRefreshStoreRef(),
        sessionVisibleRangeRef: { current: new Map([[sessionId, buildDefaultSessionVisibleRange(session, undefined, session.buffer)]]) },
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
