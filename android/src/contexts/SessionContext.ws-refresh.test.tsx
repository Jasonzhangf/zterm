// @vitest-environment jsdom

import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Filesystem } from '@capacitor/filesystem';
import {
  SessionProvider,
  shouldReconnectActivatedSession,
  shouldReconnectQueuedActiveInput,
  useSession,
} from './SessionContext';
import { useSessionBufferSnapshot } from '../lib/session-buffer-store';
import { useSessionHeadSnapshot } from '../lib/session-head-store';
import { DEFAULT_TERMINAL_CACHE_LINES, resolveTerminalRequestWindowLines } from '../lib/mobile-config';
import type { Host, ServerMessage, TerminalBufferPayload, TerminalIndexedLine } from '../lib/types';
import { applyBufferSyncToSessionBuffer, cellsToLine, createSessionBufferState } from '../lib/terminal-buffer';

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    ExternalStorage: 'ExternalStorage',
  },
  Filesystem: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static controlInstances: MockWebSocket[] = [];

  readonly url: string;
  readonly transportRole: 'control' | 'session';
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    const role = (() => {
      try {
        const parsed = new URL(url);
        return parsed.searchParams.get('ztermTransport') === 'control' ? 'control' : 'session';
      } catch {
        return 'session';
      }
    })();
    this.transportRole = role;
    if (role === 'control') {
      MockWebSocket.controlInstances.push(this);
      queueMicrotask(() => {
        if (this.readyState === MockWebSocket.CONNECTING) {
          this.triggerOpen();
        }
      });
    } else {
      MockWebSocket.instances.push(this);
    }
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (this.transportRole !== 'control' || typeof data !== 'string') {
      return;
    }
    const message = JSON.parse(data);
    if (message?.type !== 'session-open') {
      return;
    }
    const payload = message.payload || {};
    this.triggerMessage({
      type: 'session-ticket',
      payload: {
        clientSessionId: payload.clientSessionId,
        sessionTransportToken: `ticket-${payload.clientSessionId}`,
        sessionName: payload.sessionName,
      },
    } as ServerMessage);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  triggerError() {
    this.onerror?.();
  }

  static reset() {
    MockWebSocket.instances = [];
    MockWebSocket.controlInstances = [];
  }
}

function linesToPayload(lines: string[], _viewportEndIndex: number, revision: number): TerminalBufferPayload {
  const indexedLines: TerminalIndexedLine[] = lines.map((line, index) => ({
    index,
    cells: Array.from(line).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    })),
  }));

  return {
    revision,
    startIndex: 0,
    endIndex: lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: indexedLines,
  };
}

function indexedPayload(options: {
  startIndex: number;
  endIndex: number;
  viewportEndIndex?: number;
  revision: number;
  lines: ReadonlyArray<readonly [number, string]>;
}): TerminalBufferPayload {
  return {
    revision: options.revision,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: options.lines.map(([index, line]) => ({
      index,
      cells: Array.from(line).map((char) => ({
        char: char.codePointAt(0) || 32,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      })),
    })),
  };
}

function compactPayload(options: {
  startIndex: number;
  endIndex: number;
  revision: number;
  cols?: number;
  rows?: number;
  lines: ReadonlyArray<readonly [number, string]>;
}): TerminalBufferPayload {
  return {
    revision: options.revision,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cursorKeysApp: false,
    lines: options.lines.map(([index, line]) => ({
      i: index,
      t: line,
    })),
  };
}

function readSentMessages(ws: MockWebSocket) {
  return ws.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item));
}

const host: Host = {
  id: 'host-1',
  createdAt: 1,
  name: 'local-test',
  bridgeHost: '127.0.0.1',
  bridgePort: 3333,
  sessionName: 'zterm_mirror_lab',
  authType: 'password',
  tags: [],
  pinned: false,
};

const host2: Host = {
  ...host,
  id: 'host-2',
  name: 'local-test-2',
  sessionName: 'zterm_mirror_lab_2',
};

function SessionHarness() {
  const {
    state,
    createSession,
    sendInput,
    sendImagePaste,
    requestRemoteScreenshot,
    reconnectSession,
    reconnectAllSessions,
    resumeActiveSessionTransport,
    updateSessionViewport,
    getSessionDebugMetrics,
    getSessionBufferStore,
    getSessionHeadStore,
  } = useSession();
  const [remoteScreenshotResult, setRemoteScreenshotResult] = useState('idle');
  const [remoteScreenshotPhase, setRemoteScreenshotPhase] = useState('idle');

  useEffect(() => {
    createSession(host, { sessionId: 'session-1', activate: true });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;
  const renderedLines = activeBuffer?.lines.map(cellsToLine) || [];
  const emitFollowViewport = () => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  };

  useEffect(() => {
    emitFollowViewport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id]);

  return (
    <div>
      <div data-testid="session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="session-revision">{activeBuffer?.revision ?? -1}</div>
      <div data-testid="session-cursor">
        {activeBuffer?.cursor
          ? `${activeBuffer.cursor.rowIndex}:${activeBuffer.cursor.col}:${activeBuffer.cursor.visible ? 'visible' : 'hidden'}`
          : 'null'}
      </div>
      <div data-testid="session-start-index">{activeBuffer?.startIndex ?? -1}</div>
      <div data-testid="session-end-index">{activeBuffer?.endIndex ?? -1}</div>
      <div data-testid="session-lines">{renderedLines.join('|')}</div>
      <div data-testid="session-debug-status">{activeSession ? (getSessionDebugMetrics(activeSession.id)?.status || 'missing') : 'missing'}</div>
      <div data-testid="session-buffer-pull-active">{activeSession && getSessionDebugMetrics(activeSession.id)?.bufferPullActive ? 'true' : 'false'}</div>
      <div data-testid="session-debug-active">{activeSession && getSessionDebugMetrics(activeSession.id)?.active ? 'true' : 'false'}</div>
      <div data-testid="remote-screenshot-result">{remoteScreenshotResult}</div>
      <div data-testid="remote-screenshot-phase">{remoteScreenshotPhase}</div>
      <button
        type="button"
        onClick={() => {
          sendInput('session-1', 'typed-from-client\r');
          emitFollowViewport();
        }}
      >
        send-input
      </button>
      <button
        type="button"
        onClick={() =>
          sendImagePaste(
            'session-1',
            new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' }),
          )
        }
      >
        send-image
      </button>
      <button
        type="button"
        onClick={() => {
          void requestRemoteScreenshot('session-1', (progress) => {
            setRemoteScreenshotPhase(`${progress.phase}:${progress.receivedChunks || 0}/${progress.totalChunks || 0}`);
          })
            .then((capture) => setRemoteScreenshotResult(`${capture.fileName}:${capture.dataBase64}`))
            .catch((error) => setRemoteScreenshotResult(`error:${error instanceof Error ? error.message : String(error)}`));
        }}
      >
        request-screenshot
      </button>
      <button type="button" onClick={() => reconnectSession('session-1')}>
        reconnect-session
      </button>
      <button type="button" onClick={() => reconnectAllSessions()}>
        reconnect-all
      </button>
      <button type="button" onClick={() => resumeActiveSessionTransport('session-1')}>
        resume-active
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          startIndex: 56,
          endIndex: 80,
          viewportRows: 24,
        })}
      >
        viewport-reading
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          startIndex: 8,
          endIndex: 80,
          viewportRows: 24,
        })}
      >
        viewport-reading-gap
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          startIndex: 96,
          endIndex: 120,
          viewportRows: 24,
        })}
      >
        viewport-follow
      </button>
    </div>
  );
}

function MultiSessionHarness() {
  const {
    state,
    createSession,
    switchSession,
    reconnectAllSessions,
    updateSessionViewport,
    getSessionDebugMetrics,
    getSessionBufferStore,
    getSessionHeadStore,
  } = useSession();

  useEffect(() => {
    createSession(host, { sessionId: 'session-1', activate: true });
    createSession(host2, { sessionId: 'session-2', activate: false });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const sessionBufferStore = getSessionBufferStore();
  const sessionHeadStore = getSessionHeadStore();
  const activeBufferSnapshot = useSessionBufferSnapshot(sessionBufferStore, activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(sessionHeadStore, activeSession?.id || null);
  const session1BufferSnapshot = useSessionBufferSnapshot(sessionBufferStore, 'session-1');
  const session2BufferSnapshot = useSessionBufferSnapshot(sessionBufferStore, 'session-2');
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="active-session">{state.activeSessionId || 'missing'}</div>
      <div data-testid="session-1-state">
        {state.sessions.find((session) => session.id === 'session-1')?.state || 'missing'}
      </div>
      <div data-testid="session-2-state">
        {state.sessions.find((session) => session.id === 'session-2')?.state || 'missing'}
      </div>
      <div data-testid="session-1-revision">
        {session1BufferSnapshot.buffer.revision ?? -1}
      </div>
      <div data-testid="session-2-revision">
        {session2BufferSnapshot.buffer.revision ?? -1}
      </div>
      <div data-testid="session-1-debug-active">
        {getSessionDebugMetrics('session-1')?.active ? 'true' : 'false'}
      </div>
      <div data-testid="session-2-debug-active">
        {getSessionDebugMetrics('session-2')?.active ? 'true' : 'false'}
      </div>
      <button type="button" onClick={() => switchSession('session-1')}>
        switch-first
      </button>
      <button type="button" onClick={() => switchSession('session-2')}>
        switch-second
      </button>
      <button type="button" onClick={() => reconnectAllSessions()}>
        reconnect-all
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) {
            return;
          }
          updateSessionViewport(activeSession.id, {
            startIndex: 86,
            endIndex: 110,
            viewportRows: 24,
          });
        }}
      >
        active-viewport-reading
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) {
            return;
          }
          updateSessionViewport(activeSession.id, {
            startIndex: 72,
            endIndex: 96,
            viewportRows: 24,
          });
        }}
      >
        active-viewport-reading-deeper
      </button>
    </div>
  );
}

function StaleFollowHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'stale-session',
      activate: true,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 1033 }, (_, offset) => `line-${63661 + offset}`),
        startIndex: 63661,
        endIndex: 64694,
        bufferHeadStartIndex: 63661,
        bufferTailEndIndex: 64694,
        cols: 56,
        rows: 33,
        revision: 6,
        cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      }),
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="stale-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="stale-session-revision">{activeBuffer?.revision ?? -1}</div>
    </div>
  );
}

function StaleFollowVisibleTruthHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'stale-visible-session',
      activate: true,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 1033 }, (_, offset) => `line-${63661 + offset}`),
        startIndex: 63661,
        endIndex: 64694,
        bufferHeadStartIndex: 63661,
        bufferTailEndIndex: 64694,
        cols: 56,
        rows: 33,
        revision: 6,
        cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      }),
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="stale-visible-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="stale-visible-session-revision">{activeBuffer?.revision ?? -1}</div>
      <div data-testid="stale-visible-session-start-index">{activeBuffer?.startIndex ?? -1}</div>
      <div data-testid="stale-visible-session-end-index">{activeBuffer?.endIndex ?? -1}</div>
      <div data-testid="stale-visible-session-first-line">{cellsToLine(activeBuffer?.lines[0] || [])}</div>
      <div data-testid="stale-visible-session-last-line">{cellsToLine(activeBuffer?.lines[activeBuffer?.lines.length ? activeBuffer.lines.length - 1 : 0] || [])}</div>
    </div>
  );
}

function FarBehindFollowHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'far-behind-session',
      activate: true,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 120 }, (_, offset) => `line-${offset}`),
        startIndex: 0,
        endIndex: 120,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 120,
        cols: 80,
        rows: 24,
        revision: 3,
        cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      }),
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="far-behind-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="far-behind-session-revision">{activeBuffer?.revision ?? -1}</div>
    </div>
  );
}

function NearHeadFollowHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'near-head-session',
      activate: true,
      buffer: createSessionBufferState({
        lines: Array.from({ length: 52 }, (_, offset) => `line-${428 + offset}`),
        startIndex: 428,
        endIndex: 480,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 480,
        cols: 80,
        rows: 24,
        revision: 5,
        cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      }),
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="near-head-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="near-head-session-revision">{activeBuffer?.revision ?? -1}</div>
    </div>
  );
}

function NearHeadGapFollowHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    const sparseBuffer = applyBufferSyncToSessionBuffer(
      undefined,
      indexedPayload({
        startIndex: 428,
        endIndex: 500,
        revision: 5,
        lines: Array.from({ length: 62 }, (_, offset) => {
          const absoluteIndex = 428 + offset;
          return [absoluteIndex >= 450 ? absoluteIndex + 10 : absoluteIndex, `line-${absoluteIndex}`] as [number, string];
        }),
      }),
      DEFAULT_TERMINAL_CACHE_LINES,
    );

    createSession(host, {
      sessionId: 'near-head-gap-session',
      activate: true,
      buffer: sparseBuffer,
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="near-head-gap-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="near-head-gap-session-revision">{activeBuffer?.revision ?? -1}</div>
    </div>
  );
}

function CompactFollowImmediateApplyHarness() {
  const { state, createSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'compact-follow-session',
      activate: true,
      buffer: createSessionBufferState({
        lines: [],
        startIndex: 171108,
        endIndex: 171108,
        bufferHeadStartIndex: 171108,
        bufferTailEndIndex: 171108,
        cols: 56,
        rows: 33,
        revision: 4206,
        cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
      }),
    });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;

  useEffect(() => {
    if (!activeSession || !activeBuffer) {
      return;
    }
    const endIndex = Math.max(
      0,
      Math.floor(
        activeHeadSnapshot.daemonHeadEndIndex
        || activeBuffer.bufferTailEndIndex
        || activeBuffer.endIndex
        || 0,
      ),
    );
    const viewportRows = Math.max(1, Math.floor(activeBuffer.rows || 24));
    updateSessionViewport(activeSession.id, {
      startIndex: Math.max(0, endIndex - viewportRows),
      endIndex,
      viewportRows,
    });
  }, [activeBuffer, activeSession?.id, updateSessionViewport]);

  return (
    <div>
      <div data-testid="compact-follow-session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="compact-follow-session-revision">{activeBuffer?.revision ?? -1}</div>
      <div data-testid="compact-follow-session-start-index">{activeBuffer?.startIndex ?? -1}</div>
      <div data-testid="compact-follow-session-end-index">{activeBuffer?.endIndex ?? -1}</div>
    </div>
  );
}

describe('SessionContext websocket dynamic refresh', () => {
  const originalWebSocket = globalThis.WebSocket;

  it('reconnects an activated tab based on transport truth even if a stale session label still says reconnecting', () => {
    expect(shouldReconnectActivatedSession({
      hasSession: true,
      wsReadyState: MockWebSocket.CLOSED,
      reconnectInFlight: false,
    })).toBe(true);

    expect(shouldReconnectActivatedSession({
      hasSession: true,
      wsReadyState: MockWebSocket.CLOSED,
      reconnectInFlight: true,
    })).toBe(false);
  });

  it('keeps ensuring reconnect for active queued input whenever the transport is still dead', () => {
    expect(shouldReconnectQueuedActiveInput({
      isActiveTarget: true,
      wsReadyState: MockWebSocket.CLOSED,
      reconnectInFlight: false,
    })).toBe(true);

    expect(shouldReconnectQueuedActiveInput({
      isActiveTarget: true,
      wsReadyState: MockWebSocket.CLOSED,
      reconnectInFlight: true,
    })).toBe(false);
  });

  beforeEach(() => {
    cleanup();
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    MockWebSocket.reset();
    vi.mocked(Filesystem.mkdir).mockClear();
    vi.mocked(Filesystem.writeFile).mockClear();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it('applies sequential websocket buffer-sync updates to the active session', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const sentTypes = ws.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item).type);
      expect(sentTypes).toContain('connect');
    });

    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    const topRows = Array.from({ length: 24 }, (_, index) =>
      index === 0 ? 'TOP_MARKER-row-001' : `row-${String(index + 1).padStart(3, '0')}`,
    );
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(topRows, 24, 1),
    });
    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('TOP_MARKER-row-001'));

    const bottomRows = Array.from({ length: 80 }, (_, index) =>
      index === 79 ? 'BOTTOM_MARKER-row-080' : `row-${String(index + 1).padStart(3, '0')}`,
    );
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(bottomRows, 80, 2),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('BOTTOM_MARKER-row-080');
      expect(screen.getByTestId('session-revision').textContent).toBe('2');
    });

    const appendedRows = [...bottomRows, 'APPEND_MARKER-'];
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(appendedRows, appendedRows.length, 3),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('APPEND_MARKER-');
      expect(screen.getByTestId('session-revision').textContent).toBe('3');
    });
  });

  it('applies incoming buffer-sync without waiting for timer-based flush ticks', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      ws.triggerMessage({
        type: 'buffer-sync',
        payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most the latest 1000 local buffer lines even if bridge settings request more', async () => {
    render(
      <SessionProvider
        wsUrl="ws://127.0.0.1:3333/ws"
        terminalCacheLines={5000}
      >
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    const fullBuffer = Array.from({ length: 1200 }, (_, index) => `line-${String(index).padStart(4, '0')}`);
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(fullBuffer, fullBuffer.length, 1),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('line-0200');
      const renderedLines = (screen.getByTestId('session-lines').textContent || '').split('|');
      expect(renderedLines).toHaveLength(DEFAULT_TERMINAL_CACHE_LINES);
      expect(renderedLines[0]).toBe('line-0200');
      expect(renderedLines[DEFAULT_TERMINAL_CACHE_LINES - 1]).toBe('line-1199');
      expect(screen.getByTestId('session-start-index').textContent).toBe('200');
      expect(screen.getByTestId('session-end-index').textContent).toBe('1200');
    });
  });

  it('does not re-send follow buffer requests on every incoming buffer-sync frame', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(
        Array.from({ length: 24 }, (_, index) => `row-${String(index + 1).padStart(3, '0')}`),
        24,
        1,
      ),
    });
    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('1'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(
        Array.from({ length: 25 }, (_, index) => `row-${String(index + 1).padStart(3, '0')}`),
        25,
        2,
      ),
    });
    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('2'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const sentTypes = ws.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item).type);
    expect(sentTypes).not.toContain('buffer-sync-request');
  });

  it('does not create a third transport when switching between two same-target sessions that already have their own transports', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('session-1-state').textContent).toBe('connected'));
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('advances local revision even when a newer buffer-sync keeps the same visible lines', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    const stableLines = ['row-001', 'row-002', 'row-003'];
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(stableLines, stableLines.length, 5),
    });
    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(stableLines, stableLines.length, 6),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('row-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
    });
  });

  it('refreshes head on explicit active resume', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('resume-active'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });
  });

  it('bootstrap sync starts from head truth and only asks the latest follow window after head arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    const bootstrapMessages = readSentMessages(ws);
    expect(bootstrapMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    expect(bootstrapMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 9,
        latestEndIndex: 240,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const followRequest = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(followRequest).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: Math.max(0, 240 - resolveTerminalRequestWindowLines(24)),
          requestEndIndex: 240,
        },
      });
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });
  });

  it('forces a fresh head request on explicit active resume even inside the head throttle window', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
      ws.sent.length = 0;

      fireEvent.click(screen.getByText('resume-active'));

      await waitFor(() => {
        const sentMessages = readSentMessages(ws);
        expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
        expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('forces a fresh head request when switching back to a connected tab inside the head throttle window', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      ws2.sent.length = 0;
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      const sent2 = readSentMessages(ws2);
      expect(sent2.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('clears stale in-flight pull bookkeeping on explicit active resume and re-issues head-first refresh', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 90,
        endIndex: 120,
        revision: 1,
        lines: [[119, 'tail-before-stall']],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('tail-before-stall'));

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('send-input'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('resume-active'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });
    expect(readSentMessages(ws).some((item) => item.type === 'buffer-sync-request')).toBe(false);
  });

  it('reconnects the active tab when switching back to a stale session whose websocket is already closed', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.readyState = MockWebSocket.CLOSED;

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(3));
  });

  it('reconnects the active session immediately when input is queued against a closed websocket', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    ws.readyState = MockWebSocket.CLOSED;

    fireEvent.click(screen.getByText('send-input'));

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2));
  });


  it('probes a stale-open active transport after immediate input instead of silently idling', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws1 = MockWebSocket.instances[0]!;
      ws1.triggerOpen();
      ws1.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
      ws1.sent.length = 0;

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      fireEvent.click(screen.getByText('send-input'));

      await waitFor(() => {
        const sentMessages = readSentMessages(ws1);
        expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
        expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThanOrEqual(2);
      });
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sends input immediately on an open session transport even when activity audit is stale', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws1 = MockWebSocket.instances[0]!;
      ws1.triggerOpen();
      ws1.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
      ws1.sent.length = 0;

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      fireEvent.click(screen.getByText('send-input'));

      await waitFor(() => {
        const sentMessages = readSentMessages(ws1);
        expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
        expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      });
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reuses the active open websocket on foreground resume before any reconnect decision', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
      ws.sent.length = 0;

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      fireEvent.click(screen.getByText('resume-active'));

      await waitFor(() => {
        expect(screen.getByTestId('session-state').textContent).toBe('connected');
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks only the current active session as active in debug metrics and flips immediately on tab switch', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    await waitFor(() => expect(screen.getByTestId('session-1-debug-active').textContent).toBe('true'));
    expect(screen.getByTestId('session-2-debug-active').textContent).toBe('false');

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    await waitFor(() => expect(screen.getByTestId('session-2-debug-active').textContent).toBe('true'));
    expect(screen.getByTestId('session-1-debug-active').textContent).toBe('false');
    expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
  });

  it('reconnects active transport on explicit resume when no usable websocket exists', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    ws1.close();
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('reconnecting'));

    fireEvent.click(screen.getByText('resume-active'));

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1));
  });

  it('reuses an active open transport on explicit resume even while the session label is still connecting', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('resume-active'));

    await waitFor(() => {
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(screen.getByTestId('session-state').textContent).toBe('connecting');
  });

  it('does not reconnect a stale-open active websocket while the app is hidden', async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
      ws.sent.length = 0;

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      now = new Date('2026-04-27T00:00:40.000Z').getTime();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(80);
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('uses App-provided foreground truth instead of directly reading document visibility for active tick refresh', async () => {
    vi.useFakeTimers();
    try {
      const view = render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive={false}>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await act(async () => {
        await Promise.resolve();
      });
      ws.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(false);

      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });


  it('does not stack multiple active-tick loops across provider rerenders', async () => {
    vi.useFakeTimers();
    try {
      const view = render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await act(async () => {
        await Promise.resolve();
      });

      ws.sent.length = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
      expect(readSentMessages(ws).filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);

      ws.sent.length = 0;
      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );
      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );
      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      expect(readSentMessages(ws).filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the same reading viewport state directly trigger duplicate repair requests before head arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('viewport-reading'));
    fireEvent.click(screen.getByText('viewport-reading'));

    let sentMessages = ws.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item));
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 80,
      },
    });

    await waitFor(() => {
      sentMessages = ws.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      const requests = sentMessages.filter((item) => item.type === 'buffer-sync-request');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.payload?.missingRanges).toEqual([{ startIndex: 8, endIndex: 80 }]);
      expect(requests[1]?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('does not emit an extra repair request before head when the same session returns from reading to follow', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('viewport-reading'));
    fireEvent.click(screen.getByText('viewport-follow'));

    let sentMessages = ws.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item));
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 80,
      },
    });

    await waitFor(() => {
      sentMessages = ws.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      const requests = sentMessages.filter((item) => item.type === 'buffer-sync-request');
      expect(requests).toHaveLength(2);
      expect(requests[1]?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('does not request a follow buffer sync when the local hot tail window already covers the known daemon head', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 5,
        latestEndIndex: 80,
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 8,
        endIndex: 80,
        viewportEndIndex: 80,
        revision: 5,
        lines: Array.from({ length: 72 }, (_, offset) => [8 + offset, `line-${String(8 + offset).padStart(3, '0')}`]),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('viewport-follow'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
  });

  it('does not send follow missingRanges even when the local tail window still has gaps', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 8,
        endIndex: 80,
        viewportEndIndex: 80,
        revision: 5,
        lines: Array.from({ length: 71 }, (_, offset) => {
          const absoluteIndex = 8 + offset;
          return [absoluteIndex >= 68 ? absoluteIndex + 1 : absoluteIndex, `line-${String(absoluteIndex).padStart(3, '0')}`] as [number, string];
        }),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 80,
      },
    });

    await waitFor(() => {
      const lastRequest = [...readSentMessages(ws)].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(lastRequest?.payload?.requestStartIndex).toBe(
        56,
      );
      expect(lastRequest?.payload?.requestEndIndex).toBe(80);
      expect(lastRequest?.payload?.missingRanges).toBeUndefined();
    }, { timeout: 2000 });
  });

  it('accepts remote debug-control and flips the client runtime debug flag', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'debug-control',
      payload: {
        enabled: true,
        reason: 'test',
      },
    });

    await waitFor(() => expect(window.localStorage.getItem('zterm:runtime-debug-log')).toBe('1'));
  });

  it('sends user input upstream, requests head truth first, and does not locally mutate session buffer', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });
    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001'));

    const sentCountBeforeInput = ws.sent.length;

    fireEvent.click(screen.getByText('send-input'));

    await waitFor(() => {
      const sentMessages = ws.sent
        .slice(sentCountBeforeInput)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      expect(sentMessages.some((item) => item.type === 'input' && item.payload === 'typed-from-client\r')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });

    expect(screen.getByTestId('session-lines').textContent).not.toContain('typed-from-client');
    expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001');
  });

  it('coalesces burst input into a single head refresh request', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('send-input'));
    fireEvent.click(screen.getByText('send-input'));
    fireEvent.click(screen.getByText('send-input'));

    const sentMessages = ws.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item));

    expect(sentMessages.filter((item) => item.type === 'input')).toHaveLength(3);
    expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBe(3);
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 180));
  });

  it('forces a fresh head request when user input exits reading mode inside the head throttle window', async () => {
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
      });

      await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001'));
      ws.sent.length = 0;

      now = 1100;
      fireEvent.click(screen.getByText('send-input'));
      now = 1100;
      fireEvent.click(screen.getByText('viewport-reading'));
      fireEvent.click(screen.getByText('send-input'));

      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'input')).toHaveLength(2);
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not treat pong as a head-refresh ack and avoids duplicate input refresh requests', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('send-input'));
    ws.triggerMessage({ type: 'pong' });

    await waitFor(() => {
      const sentMessages = ws.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBeLessThanOrEqual(1);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);
    }, { timeout: 220 });
  });


  it('does not let pong-only traffic keep a stalled active transport healthy forever', async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now');
    let now = 1000;
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws1 = MockWebSocket.instances[0]!;
      ws1.triggerOpen();
      ws1.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });
      ws1.triggerMessage({
        type: 'buffer-sync',
        payload: indexedPayload({
          startIndex: 90,
          endIndex: 120,
          revision: 1,
          lines: [[119, 'tail-before-pong-stall']],
        }),
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('session-lines').textContent).toContain('tail-before-pong-stall');

      ws1.sent.length = 0;
      now = 42000;
      ws1.triggerMessage({ type: 'pong' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      const firstTickMessages = readSentMessages(ws1);
      expect(firstTickMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);

      ws1.sent.length = 0;
      now = 44050;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(MockWebSocket.controlInstances.length).toBeGreaterThanOrEqual(1);
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('input immediately requests head and follows with a tail fetch when a newer head arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('send-input'));
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = ws.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    }, { timeout: 220 });
  });

  it('immediately catches up to a newer head after an older tail pull finishes instead of waiting for the next head tick', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    fireEvent.click(screen.getByText('send-input'));
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 45,
        endIndex: 240,
        revision: 1,
        lines: [[239, 'prompt-before-input']],
      }),
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request').length).toBeGreaterThanOrEqual(2);
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request' && item.payload?.knownRevision === 1)).toBe(true);
    }, { timeout: 220 });
  });

  it('flushes queued input with a forced head request as soon as the session reconnects', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    ws1.close();
    fireEvent.click(screen.getByText('send-input'));
    fireEvent.click(screen.getByText('reconnect-session'));

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2));
    const ws2 = MockWebSocket.instances[1]!;
    ws2.triggerOpen();
    ws2.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
  });



  it('does not let an in-flight reading repair block latest tail refresh while renderer stays in reading', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws"> 
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: [
          ...Array.from({ length: 56 }, (_, index) => [index, `row-${String(index + 1).padStart(3, '0')}`] as const),
          ...Array.from({ length: 40 }, (_, index) => [80 + index, `row-${String(81 + index).padStart(3, '0')}`] as const),
        ],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('viewport-reading-gap'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const readingRepair = sentMessages.find(
        (item) => item.type === 'buffer-sync-request'
          && item.payload?.requestStartIndex === 8
          && item.payload?.requestEndIndex === 80,
      );
      expect(readingRepair).toBeDefined();
      const firstMissingRange = readingRepair?.payload?.missingRanges?.[0];
      expect(firstMissingRange?.endIndex).toBe(80);
      expect([8, 56]).toContain(firstMissingRange?.startIndex);
    });

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 121,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 120,
          requestEndIndex: 121,
        },
      });
    });
  });

  it('keeps latest tail sync active while renderer is currently reading', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws"> 
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: [
          ...Array.from({ length: 56 }, (_, index) => [index, `row-${String(index + 1).padStart(3, '0')}`] as const),
          ...Array.from({ length: 40 }, (_, index) => [80 + index, `row-${String(81 + index).padStart(3, '0')}`] as const),
        ],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    fireEvent.click(screen.getByText('viewport-reading'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 121,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 120,
          requestEndIndex: 121,
        },
      });
    });
  });

  it('requests reading repair immediately when renderer reports a reading gap demand', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: [
          ...Array.from({ length: 56 }, (_, index) => [index, `row-${String(index + 1).padStart(3, '0')}`] as const),
          ...Array.from({ length: 40 }, (_, index) => [80 + index, `row-${String(81 + index).padStart(3, '0')}`] as const),
        ],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('viewport-reading-gap'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const readingRepair = sentMessages.find(
        (item) => item.type === 'buffer-sync-request'
          && item.payload?.requestStartIndex === 8
          && item.payload?.requestEndIndex === 80,
      );
      expect(readingRepair).toBeDefined();
      const firstMissingRange = readingRepair?.payload?.missingRanges?.[0];
      expect(firstMissingRange?.endIndex).toBe(80);
      expect([8, 56]).toContain(firstMissingRange?.startIndex);
    });
  });

  it('does not issue duplicate reading-repair requests while the local snapshot is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: [
          ...Array.from({ length: 56 }, (_, index) => [index, `row-${String(index + 1).padStart(3, '0')}`] as const),
          ...Array.from({ length: 40 }, (_, index) => [80 + index, `row-${String(81 + index).padStart(3, '0')}`] as const),
        ],
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('viewport-reading-gap'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    fireEvent.click(screen.getByText('viewport-follow'));
    fireEvent.click(screen.getByText('viewport-reading-gap'));

    await new Promise((resolve) => setTimeout(resolve, 80));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
  });


  it('forces active reading mode back to follow when the user sends input', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(
        Array.from({ length: 120 }, (_, index) => `row-${String(index + 1).padStart(3, '0')}`),
        120,
        5,
      ),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    fireEvent.click(screen.getByText('viewport-reading'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('send-input'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'input' && item.payload === 'typed-from-client\r')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });
  });

  it('ignores stale websocket buffer-sync revisions after newer active buffer truth already landed', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['new-line-001', 'new-line-002'], 2, 6),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('new-line-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['old-line-001', 'old-line-002'], 2, 5),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('new-line-001');
      expect(screen.getByTestId('session-lines').textContent).not.toContain('old-line-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
    });
  });

  it('applies valid incremental websocket buffer-sync payloads onto the current mirror window', async () => {

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 1,
        lines: [
          [100, 'line-a'],
          [101, 'line-b'],
          [102, 'line-c'],
          [103, 'line-d'],
          [104, 'line-e'],
          [105, 'line-f'],
        ],
      }),
    });
    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('line-a|line-b|line-c|line-d|line-e|line-f'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 101,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 2,
        lines: [
          [106, 'LINE-G'],
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('line-b|line-c|line-d|line-e|line-f|LINE-G');
      expect(screen.getByTestId('session-revision').textContent).toBe('2');
    });
  });

  it('stitches prepended history rows onto the current local mirror without a full reset', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 100,
        endIndex: 106,
        viewportEndIndex: 106,
        revision: 1,
        lines: [
          [100, 'line-a'],
          [101, 'line-b'],
          [102, 'line-c'],
          [103, 'line-d'],
          [104, 'line-e'],
          [105, 'line-f'],
        ],
      }),
    });
    await waitFor(() => expect(screen.getByTestId('session-lines').textContent).toContain('line-a|line-b|line-c|line-d|line-e|line-f'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 98,
        endIndex: 107,
        viewportEndIndex: 107,
        revision: 2,
        lines: [
          [98, 'line-y'],
          [99, 'line-z'],
          [106, 'line-g'],
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('line-y|line-z|line-a|line-b|line-c|line-d|line-e|line-f|line-g');
      expect(screen.getByTestId('session-revision').textContent).toBe('2');
    });
  });

  it('stitches back-to-back buffer-sync payloads that arrive in the same task without repeating the newest tail in history', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    act(() => {
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: indexedPayload({
          startIndex: 100,
          endIndex: 106,
          viewportEndIndex: 106,
          revision: 1,
          lines: [
            [100, 'line-a'],
            [101, 'line-b'],
            [102, 'line-c'],
            [103, 'line-d'],
            [104, 'line-e'],
            [105, 'line-f'],
          ],
        }),
      });
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: indexedPayload({
          startIndex: 98,
          endIndex: 107,
          viewportEndIndex: 107,
          revision: 2,
          lines: [
            [98, 'line-y'],
            [99, 'line-z'],
            [106, 'line-g'],
          ],
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('line-y|line-z|line-a|line-b|line-c|line-d|line-e|line-f|line-g');
      expect(screen.getByTestId('session-lines').textContent).not.toContain('line-g|line-g');
      expect(screen.getByTestId('session-revision').textContent).toBe('2');
    });
  });

  it('keeps latest mirror truth across reconnect and rejects stale post-reconnect buffer-sync payloads', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws1.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['before-reconnect-001', 'before-reconnect-002'], 2, 6),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('before-reconnect-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
    });

    fireEvent.click(screen.getByText('reconnect-session'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws2 = MockWebSocket.instances[1]!;
    ws2.triggerOpen();
    ws2.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => {
      const sentMessages = ws2.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 7,
        latestEndIndex: 2,
      },
    });

    await waitFor(() => {
      const sentMessages = ws2.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      const tailRefreshRequest = [...sentMessages].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(tailRefreshRequest?.payload).toMatchObject({
        knownRevision: 6,
        localStartIndex: 0,
        localEndIndex: 2,
        requestStartIndex: expect.any(Number),
        requestEndIndex: expect.any(Number),
      });
    });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stale-after-reconnect-001', 'stale-after-reconnect-002'], 2, 5),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('before-reconnect-001');
      expect(screen.getByTestId('session-lines').textContent).not.toContain('stale-after-reconnect-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
    });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['after-reconnect-001', 'after-reconnect-002'], 2, 7),
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('after-reconnect-001');
      expect(screen.getByTestId('session-revision').textContent).toBe('7');
    });
  });

  it('accepts lower remote revisions after daemon revision reset without forcing a full-window rebootstrap', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['old-a', 'old-b', 'old-c', 'old-d'], 4, 10),
    });
    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('10'));
    expect(screen.getByTestId('session-lines').textContent).toContain('old-a');

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 3,
        latestEndIndex: 8,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const lastRequest = [...sentMessages].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(lastRequest?.payload).toMatchObject({
        knownRevision: 10,
        localStartIndex: 0,
        localEndIndex: 4,
        requestStartIndex: expect.any(Number),
        requestEndIndex: expect.any(Number),
      });
      expect(lastRequest?.payload?.missingRanges).toBeUndefined();
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(
        ['new-1', 'new-2', 'new-3', 'new-4', 'new-5', 'new-6', 'new-7', 'new-8'],
        8,
        3,
      ),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-revision').textContent).toBe('3');
      expect(screen.getByTestId('session-lines').textContent).toContain('new-8');
      expect(screen.getByTestId('session-lines').textContent).not.toContain('old-a');
    });
  });

  it('prioritizes the active session first when reconnecting all tabs on the same host', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    fireEvent.click(screen.getByText('reconnect-all'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(4));
    const reconnectWsActive = MockWebSocket.instances[2]!;
    const reconnectWsSibling = MockWebSocket.instances[3]!;
    reconnectWsActive.triggerOpen();
    reconnectWsSibling.triggerOpen();

    await waitFor(() => {
      const connectMessage = reconnectWsActive.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .find((item) => item.type === 'connect');
      expect(connectMessage?.payload?.sessionName).toBe('zterm_mirror_lab_2');
    });
  });

  it('keeps the same client-owned stable clientSessionId across initial connect and reconnect handshakes', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
      expect(connectMessage?.payload?.clientSessionId).toBe('session-1');
    });

    fireEvent.click(screen.getByText('reconnect-session'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectWs = MockWebSocket.instances[1]!;
    reconnectWs.triggerOpen();

    await waitFor(() => {
      const reconnectMessage = readSentMessages(reconnectWs).find((item) => item.type === 'connect');
      expect(reconnectMessage?.payload?.clientSessionId).toBe('session-1');
    });
  });

  it('does not eagerly close the current open transport before the replacement reconnect transport starts', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('reconnect-session'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(screen.getByTestId('session-state').textContent).toBe('reconnecting');
  });

  it('closes the superseded open transport after the replacement reconnect transport has connected', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('reconnect-session'));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectWs = MockWebSocket.instances[1]!;
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    reconnectWs.triggerOpen();
    reconnectWs.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(reconnectWs.readyState).toBe(MockWebSocket.OPEN);
  });

  it('does not send Android UI viewport rows/cols in connect or reconnect handshakes', async () => {
    const originalInnerHeight = window.innerHeight;
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();

      await waitFor(() => {
        const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
        expect(connectMessage?.payload?.clientSessionId).toBe('session-1');
        expect(connectMessage?.payload?.cols).toBeUndefined();
        expect(connectMessage?.payload?.rows).toBeUndefined();
      });

      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: Math.max(320, originalInnerHeight - 240),
      });

      fireEvent.click(screen.getByText('reconnect-session'));

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const reconnectWs = MockWebSocket.instances[1]!;
      reconnectWs.triggerOpen();

      await waitFor(() => {
        const reconnectMessage = readSentMessages(reconnectWs).find((item) => item.type === 'connect');
        expect(reconnectMessage?.payload?.clientSessionId).toBe('session-1');
        expect(reconnectMessage?.payload?.cols).toBeUndefined();
        expect(reconnectMessage?.payload?.rows).toBeUndefined();
      });
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('keeps the inactive tab transport open when switching active tabs', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    expect(ws1.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(2);

    fireEvent.click(screen.getByText('switch-first'));

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    expect(ws1.readyState).toBe(MockWebSocket.OPEN);
    expect(ws2.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('releases the reconnect bucket when an opened reconnect socket never completes the session handshake', async () => {
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

      vi.useFakeTimers();
      fireEvent.click(screen.getByText('reconnect-all'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(MockWebSocket.instances).toHaveLength(4);
      const reconnectWsActive = MockWebSocket.instances[2]!;
      const reconnectWsSibling = MockWebSocket.instances[3]!;
      reconnectWsActive.triggerOpen();
      reconnectWsSibling.triggerOpen();
      const activeConnectMessage = reconnectWsActive.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .find((item) => item.type === 'connect');
      expect(activeConnectMessage?.payload?.sessionName).toBe('zterm_mirror_lab_2');
      const nextConnectMessage = reconnectWsSibling.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .find((item) => item.type === 'connect');
      expect(nextConnectMessage?.payload?.sessionName).toBe('zterm_mirror_lab');
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('does not serialize same-host session reconnect behind a host-global gate while preserving per-session client ids', async () => {
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      vi.useFakeTimers();
      fireEvent.click(screen.getByText('reconnect-all'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });

      expect(MockWebSocket.instances).toHaveLength(4);
      const reconnectWs1 = MockWebSocket.instances[2]!;
      const reconnectWs2 = MockWebSocket.instances[3]!;
      reconnectWs1.triggerOpen();
      reconnectWs2.triggerOpen();

      const connect1 = readSentMessages(reconnectWs1).find((item) => item.type === 'connect');
      const connect2 = readSentMessages(reconnectWs2).find((item) => item.type === 'connect');
      expect(connect1?.payload?.clientSessionId).toBe('session-1');
      expect(connect2?.payload?.clientSessionId).toBe('session-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests latest head when switching to a connected tab with a continuous local tail', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tail-row-001', 'tail-row-002', 'tail-row-003'], 3, 6),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-2-revision').textContent).toBe('6');
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = ws2.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });
  });

  it('requests latest head when switching to a connected tab without local lines', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      const sent2 = ws2.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });
  });

  it('repairs local gaps after the newly active renderer declares its visible range when switching to a connected tab whose local buffer misses the visible window', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 70,
        endIndex: 80,
        viewportEndIndex: 80,
        revision: 6,
        lines: Array.from({ length: 10 }, (_, offset) => [70 + offset, `tail-${70 + offset}`]),
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-2-revision').textContent).toBe('6');
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = ws2.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });
  });

  it('repairs local visible gaps after the newly active renderer declares its visible range when switching to a connected tab whose local tail window still has visible gaps', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 56,
        endIndex: 80,
        viewportEndIndex: 80,
        revision: 6,
        lines: Array.from({ length: 10 }, (_, offset) => [70 + offset, `tail-${70 + offset}`]),
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-2-revision').textContent).toBe('6');
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = ws2.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });
  });

  it('head metadata alone does not force reconnect when no newer tail exists', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tail-row-001', 'tail-row-002', 'tail-row-003'], 3, 6),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('6'));
    ws2.sent.length = 0;

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 3,
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('6'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(MockWebSocket.instances).toHaveLength(2);
  });


  it('active tick does not clear an in-flight tail-refresh request before the matching buffer-sync arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('1'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });

    const sentMessagesAfterTicks = readSentMessages(ws);
    expect(sentMessagesAfterTicks.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
  }, 10000);

  it('does not issue duplicate tail-refresh requests while a prior tail-refresh is still in flight', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('1'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 3,
        latestEndIndex: 3,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const sentMessagesAfterRevisionAdvance = readSentMessages(ws);
    expect(sentMessagesAfterRevisionAdvance.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
  });

  it('reissues tail-refresh when the same local snapshot needs a wider follow window', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'session-1' },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 189308,
        endIndex: 190308,
        revision: 41755,
        lines: Array.from({ length: 1000 }, (_, index) => [189308 + index, `row-${189308 + index}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('41755'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 41756,
        latestEndIndex: 190383,
        availableStartIndex: 187383,
        availableEndIndex: 190383,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 41755,
          localStartIndex: 189308,
          localEndIndex: 190308,
          requestEndIndex: 190383,
        }),
      });
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 41758,
        latestEndIndex: 190411,
        availableStartIndex: 187411,
        availableEndIndex: 190411,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 41755,
          localStartIndex: 189308,
          localEndIndex: 190308,
          requestEndIndex: 190411,
        }),
      });
      const firstEnd = Number((sentMessages[0] as any).payload?.requestEndIndex || 0);
      const secondEnd = Number((sentMessages[1] as any).payload?.requestEndIndex || 0);
      expect(secondEnd).toBeGreaterThan(firstEnd);
    });
  });

  it('does not supersede same-window tail refresh repeatedly while local snapshot is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 132711,
        endIndex: 133711,
        revision: 1447,
        lines: Array.from({ length: 1000 }, (_, index) => [132711 + index, `row-${132711 + index}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('1447'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1494,
        latestEndIndex: 133718,
        availableStartIndex: 130718,
        availableEndIndex: 133718,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 1447,
          localStartIndex: 132711,
          localEndIndex: 133711,
          requestStartIndex: 133711,
          requestEndIndex: 133718,
        }),
      });
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1498,
        latestEndIndex: 133718,
        availableStartIndex: 130718,
        availableEndIndex: 133718,
      },
    });
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1505,
        latestEndIndex: 133718,
        availableStartIndex: 130718,
        availableEndIndex: 133718,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
  });

  it('refreshes only the visible follow viewport when revision advances at the same head end without an explicit tail reanchor demand', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('session-state').textContent).toBe('connected');
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 240,
        revision: 3,
        lines: Array.from({ length: 240 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
      }),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('session-revision').textContent).toBe('3');
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 4,
        latestEndIndex: 240,
        availableStartIndex: 0,
        availableEndIndex: 240,
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    const sentMessages = readSentMessages(ws);
    const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
    expect(tailRefresh).toMatchObject({
      type: 'buffer-sync-request',
      payload: {
        requestStartIndex: 216,
        requestEndIndex: 240,
      },
    });
  });

  it('clears in-flight tail-refresh state when daemon completes the request with an empty buffer-sync payload', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002'], 2, 1),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('1'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: {
        revision: 2,
        startIndex: 3,
        endIndex: 3,
        availableStartIndex: 0,
        availableEndIndex: 3,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: [],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 3,
        latestEndIndex: 4,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(2);
    });
  });

  it('reanchors follow tail-refresh to daemon authoritative tail instead of reusing an impossible stale local window', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <StaleFollowHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'stale-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('stale-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'stale-session',
        revision: 7,
        latestEndIndex: 51511,
        availableStartIndex: 50511,
        availableEndIndex: 51511,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const requests = sentMessages.filter((item) => item.type === 'buffer-sync-request');
      const lastRequest = requests[requests.length - 1];
      expect(lastRequest).toBeTruthy();
      expect(lastRequest?.payload?.requestEndIndex).toBe(51511);
      expect(lastRequest?.payload?.requestStartIndex).toBeLessThan(51511);
      expect(lastRequest?.payload?.requestStartIndex).toBeGreaterThanOrEqual(50511);
    });
  });

  it('does not clear existing local absolute-index truth just because the follow window is impossible before replacement data arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <StaleFollowVisibleTruthHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'stale-visible-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('stale-visible-session-state').textContent).toBe('connected'));
    expect(screen.getByTestId('stale-visible-session-start-index').textContent).toBe('63694');
    expect(screen.getByTestId('stale-visible-session-end-index').textContent).toBe('64694');
    expect(screen.getByTestId('stale-visible-session-first-line').textContent).toBe('line-63694');
    expect(screen.getByTestId('stale-visible-session-last-line').textContent).toBe('line-64693');

    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'stale-visible-session',
        revision: 7,
        latestEndIndex: 51511,
        availableStartIndex: 50511,
        availableEndIndex: 51511,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const requests = sentMessages.filter((item) => item.type === 'buffer-sync-request');
      expect(requests.length).toBeGreaterThan(0);
    });

    expect(screen.getByTestId('stale-visible-session-first-line').textContent).toBe('line-63694');
    expect(screen.getByTestId('stale-visible-session-last-line').textContent).toBe('line-64693');
    expect(screen.getByTestId('stale-visible-session-start-index').textContent).toBe('63694');
    expect(screen.getByTestId('stale-visible-session-end-index').textContent).toBe('64694');
  });

  it('jumps directly to the latest three-screen tail when daemon head is far ahead of the local buffer', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <FarBehindFollowHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'far-behind-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('far-behind-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'far-behind-session',
        revision: 4,
        latestEndIndex: 500,
        availableStartIndex: 0,
        availableEndIndex: 500,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 428,
          requestEndIndex: 500,
        },
      });
      expect(tailRefresh?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('pulls only the tail diff when daemon head is near the local tail in follow mode', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <NearHeadFollowHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'near-head-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('near-head-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'near-head-session',
        revision: 5,
        latestEndIndex: 500,
        availableStartIndex: 0,
        availableEndIndex: 500,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 480,
          requestEndIndex: 500,
        },
      });
      expect(tailRefresh?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('applies compact follow buffer-sync immediately so the next head only requests tail diff', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <CompactFollowImmediateApplyHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'compact-follow-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('compact-follow-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'compact-follow-session',
        revision: 4256,
        latestEndIndex: 172141,
        availableStartIndex: 171108,
        availableEndIndex: 172141,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const firstRequest = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(firstRequest).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          knownRevision: 4206,
          localStartIndex: 171108,
          localEndIndex: 171108,
          requestStartIndex: 172042,
          requestEndIndex: 172141,
        },
      });
    });

    ws.sent.length = 0;

    act(() => {
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: compactPayload({
          revision: 4256,
          startIndex: 172042,
          endIndex: 172141,
          cols: 56,
          rows: 33,
          lines: Array.from({ length: 99 }, (_, offset) => [172042 + offset, `tail-${172042 + offset}`] as const),
        }),
      });
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'compact-follow-session',
          revision: 4257,
          latestEndIndex: 172150,
          availableStartIndex: 171117,
          availableEndIndex: 172150,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('compact-follow-session-revision').textContent).toBe('4256');
      expect(screen.getByTestId('compact-follow-session-end-index').textContent).toBe('172141');
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => (
        item.type === 'buffer-sync-request'
        && item.payload?.knownRevision === 4256
        && item.payload?.localEndIndex === 172141
        && item.payload?.requestStartIndex === 172141
        && item.payload?.requestEndIndex === 172150
      ))).toBe(true);
    });

    ws.sent.length = 0;

    act(() => {
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: compactPayload({
          revision: 4257,
          startIndex: 172141,
          endIndex: 172150,
          cols: 56,
          rows: 33,
          lines: Array.from({ length: 9 }, (_, offset) => [172141 + offset, `tail-${172141 + offset}`] as const),
        }),
      });
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'compact-follow-session',
          revision: 4258,
          latestEndIndex: 172159,
          availableStartIndex: 171126,
          availableEndIndex: 172159,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('compact-follow-session-revision').textContent).toBe('4257');
      expect(screen.getByTestId('compact-follow-session-end-index').textContent).toBe('172150');
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => (
        item.type === 'buffer-sync-request'
        && item.payload?.knownRevision === 4257
        && item.payload?.localEndIndex === 172150
        && item.payload?.requestStartIndex === 172150
        && item.payload?.requestEndIndex === 172159
      ))).toBe(true);
    });
  });

  it('does not let follow-mode tail refresh repair old local gaps when only the head advances a little', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <NearHeadGapFollowHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'near-head-gap-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('near-head-gap-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'near-head-gap-session',
        revision: 6,
        latestEndIndex: 505,
        availableStartIndex: 0,
        availableEndIndex: 505,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      const tailRefresh = sentMessages.find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 500,
          requestEndIndex: 505,
        },
      });
      expect(tailRefresh?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('repairs visible gaps when the renderer-visible window still has gaps even if daemon head truth is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <NearHeadGapFollowHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'near-head-gap-session',
      },
    });

    await waitFor(() => expect(screen.getByTestId('near-head-gap-session-state').textContent).toBe('connected'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'near-head-gap-session',
        revision: 5,
        latestEndIndex: 500,
        availableStartIndex: 0,
        availableEndIndex: 500,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    const sentMessages = readSentMessages(ws);
    expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(true);
  });

  it('refreshes the current follow tail window when daemon revision changes even if endIndex is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002', 'stable-line-003'], 3, 5),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 3,
        availableStartIndex: 0,
        availableEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 0,
          requestEndIndex: 3,
        }),
      });
    });
  });

  it('reissues same-window tail refresh immediately after an older same-end in-flight refresh settles against a newer head revision', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: Array.from({ length: 120 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 120,
        availableStartIndex: 0,
        availableEndIndex: 120,
      },
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 7,
        latestEndIndex: 120,
        availableStartIndex: 0,
        availableEndIndex: 120,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 96,
        endIndex: 120,
        revision: 6,
        lines: Array.from({ length: 24 }, (_, offset) => [96 + offset, `row-${String(96 + offset).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 6,
          requestStartIndex: 96,
          requestEndIndex: 120,
        }),
      });
    });
  });

  it('does not let an older covered pull from a stale local snapshot block a new tail refresh after partial apply', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 186512,
        endIndex: 187512,
        revision: 71688,
        lines: Array.from({ length: 1000 }, (_, index) => [186512 + index, `row-${186512 + index}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('71688'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 71689,
        latestEndIndex: 187555,
        availableStartIndex: 184555,
        availableEndIndex: 187555,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 71688,
          localStartIndex: 186512,
          localEndIndex: 187512,
          requestStartIndex: 187512,
          requestEndIndex: 187555,
        }),
      });
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 187167,
        endIndex: 187257,
        revision: 71736,
        lines: Array.from({ length: 90 }, (_, index) => [187167 + index, `row-${187167 + index}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('71736'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 71737,
        latestEndIndex: 187577,
        availableStartIndex: 184577,
        availableEndIndex: 187577,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          knownRevision: 71736,
          localStartIndex: 186512,
          localEndIndex: 187512,
          requestStartIndex: 187512,
          requestEndIndex: 187577,
        }),
      });
    });
  });

  it('applies cursor metadata from buffer-head immediately even before a follow buffer-sync returns', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: {
        ...linesToPayload(['prompt-before-head'], 1, 5),
        cursor: { rowIndex: 0, col: 2, visible: true },
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-cursor').textContent).toBe('0:2:visible'));
    ws.sent.length = 0;

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 1,
        availableStartIndex: 0,
        availableEndIndex: 1,
        cursor: { rowIndex: 0, col: 0, visible: true },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-cursor').textContent).toBe('0:0:visible');
    });
  });

  it('supersedes a stale in-flight tail refresh when a re-activated tab comes back with a newer head', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: Array.from({ length: 120 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('5'));

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    ws2.sent.length = 0;

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 121,
        availableStartIndex: 0,
        availableEndIndex: 121,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 120,
          requestEndIndex: 121,
        }),
      });
    });

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    ws2.sent.length = 0;

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 7,
        latestEndIndex: 122,
        availableStartIndex: 0,
        availableEndIndex: 122,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 120,
          requestEndIndex: 122,
        }),
      });
    });
  });

  it('reissues tail refresh after active tab re-entry even when the stale in-flight request targets the same head window', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 120,
        revision: 5,
        lines: Array.from({ length: 120 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('5'));

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    ws2.sent.length = 0;

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 121,
        availableStartIndex: 0,
        availableEndIndex: 121,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 120,
          requestEndIndex: 121,
        }),
      });
    });

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.sent.length = 0;
    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 121,
        availableStartIndex: 0,
        availableEndIndex: 121,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 120,
          requestEndIndex: 121,
        }),
      });
    });
  });

  it('reissues tail-refresh after stale in-flight request is stranded without any buffer-sync response', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: indexedPayload({
          startIndex: 0,
          endIndex: 120,
          revision: 5,
          lines: Array.from({ length: 120 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
        }),
      });

      await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));
      ws.sent.length = 0;

      now = new Date('2026-04-27T00:00:00.100Z').getTime();
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'session-1',
          revision: 6,
          latestEndIndex: 121,
          availableStartIndex: 0,
          availableEndIndex: 121,
        },
      });

      await waitFor(() => {
        const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toEqual({
          type: 'buffer-sync-request',
          payload: expect.objectContaining({
            knownRevision: 5,
            localStartIndex: 0,
            localEndIndex: 120,
            requestStartIndex: 120,
            requestEndIndex: 121,
          }),
        });
      });

      ws.sent.length = 0;

      now = new Date('2026-04-27T00:00:36.000Z').getTime();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      await waitFor(() => {
        const sentMessages = readSentMessages(ws);
        expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      });
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-sync-request')).toBe(false);

      ws.sent.length = 0;
      now = new Date('2026-04-27T00:00:36.080Z').getTime();
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'session-1',
          revision: 6,
          latestEndIndex: 121,
          availableStartIndex: 0,
          availableEndIndex: 121,
        },
      });

      await waitFor(() => {
        const sentMessages = readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request');
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toEqual({
          type: 'buffer-sync-request',
          payload: expect.objectContaining({
            knownRevision: 5,
            localStartIndex: 0,
            localEndIndex: 120,
            requestStartIndex: 120,
            requestEndIndex: 121,
          }),
        });
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('probes an active tab over its existing open transport before any reconnect when activity is stale', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));
      ws2.sent.length = 0;

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reconnects only after a stale-open active transport stays silent after an explicit probe', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      ws2.sent.length = 0;
      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      now = new Date('2026-04-27T00:00:45.000Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('reconnecting');
      });
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(3));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not reconnect on the very next active tick while a stale transport probe is still within its wait window', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      ws2.sent.length = 0;

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);

      now = new Date('2026-04-27T00:00:40.200Z').getTime();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not auto reconnect an inactive session after its transport closes', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

    ws2.close();

    await waitFor(() => {
      expect(screen.getByTestId('session-2-state').textContent).toBe('idle');
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('lets the second tab continue scrolling deeper while an older reading repair is still in flight', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 100,
        endIndex: 120,
        revision: 5,
        lines: Array.from({ length: 20 }, (_, index) => [100 + index, `row-${String(100 + index).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('5'));
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 5,
        latestEndIndex: 120,
        availableStartIndex: 0,
        availableEndIndex: 120,
      },
    });
    ws2.sent.length = 0;

    fireEvent.click(screen.getByText('active-viewport-reading'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 38,
          requestEndIndex: 110,
        }),
      });
    });

    fireEvent.click(screen.getByText('active-viewport-reading-deeper'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 24,
          requestEndIndex: 96,
        }),
      });
    });
  });

  it('issues a single tail refresh after user input even when the daemon tail line count stays unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002', 'prompt-$'], 3, 5),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    fireEvent.click(screen.getByText('send-input'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 6,
        latestEndIndex: 3,
        availableStartIndex: 0,
        availableEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['stable-line-001', 'stable-line-002', 'prompt-$ typed-from-client'], 3, 6),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-revision').textContent).toBe('6');
      expect(screen.getByTestId('session-lines').textContent).toContain('typed-from-client');
    });

    ws.sent.length = 0;
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 7,
        latestEndIndex: 3,
        availableStartIndex: 0,
        availableEndIndex: 3,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(1);
    });
  });

  it('promotes a connecting session from live buffer-head before connected arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'connect')).toBe(true);
    });

    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 1,
        latestEndIndex: 2,
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['late-connected-line-001', 'late-connected-line-002'], 2, 1),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-revision').textContent).toBe('1');
      expect(screen.getByTestId('session-lines').textContent).toContain('late-connected-line-001');
    });
  });

  it('keeps polling buffer head while the active session is still connecting', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'connect')).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('session-state').textContent).toBe('connecting');
  });

  it('does not force reconnect just because head polling has not produced a newer payload yet', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));

    expect(
      ws2.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .some((item) => item.type === 'buffer-head-request'),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('sends image paste as metadata plus binary frame without reconnect side effects', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('send-image'));

    await waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(3));

    const pasteMeta = ws.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item))
      .find((item) => item.type === 'paste-image-start');

    expect(pasteMeta).toBeTruthy();
    expect(pasteMeta.payload).toMatchObject({
      name: 'proof.png',
      mimeType: 'image/png',
      byteLength: 4,
      pasteSequence: '\u0016',
    });
    expect(ws.sent.some((item) => item instanceof ArrayBuffer)).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('streams remote screenshot chunks into preview payload and reports progress phases', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('request-screenshot'));

    await waitFor(() => {
      const messages = readSentMessages(ws);
      expect(messages.some((item) => item.type === 'remote-screenshot-request')).toBe(true);
    });

    const requestMessage = readSentMessages(ws).find((item) => item.type === 'remote-screenshot-request');
    const requestId = requestMessage?.payload?.requestId;
    expect(typeof requestId).toBe('string');

    ws.triggerMessage({
      type: 'remote-screenshot-status',
      payload: {
        requestId,
        phase: 'capturing',
        fileName: 'remote-shot.png',
      },
    });
    ws.triggerMessage({
      type: 'remote-screenshot-status',
      payload: {
        requestId,
        phase: 'transferring',
        fileName: 'remote-shot.png',
        receivedChunks: 0,
        totalChunks: 2,
        totalBytes: 6,
      },
    });
    ws.triggerMessage({
      type: 'file-download-chunk',
      payload: {
        requestId,
        chunkIndex: 1,
        totalChunks: 2,
        fileName: 'remote-shot.png',
        dataBase64: 'YmFy',
      },
    });
    ws.triggerMessage({
      type: 'file-download-chunk',
      payload: {
        requestId,
        chunkIndex: 0,
        totalChunks: 2,
        fileName: 'remote-shot.png',
        dataBase64: 'Zm9v',
      },
    });
    ws.triggerMessage({
      type: 'file-download-complete',
      payload: {
        requestId,
        fileName: 'remote-shot.png',
        totalBytes: 6,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('remote-screenshot-phase').textContent).toBe('transferring:2/2');
      expect(screen.getByTestId('remote-screenshot-result').textContent).toBe('remote-shot.png:Zm9vYmFy');
    });
    expect(Filesystem.mkdir).not.toHaveBeenCalled();
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('fails remote screenshot request explicitly when no progress arrives before timeout', async () => {
    let screenshotTimeout: (() => void) | null = null;
    const realSetTimeout = window.setTimeout.bind(window);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 15000 && typeof handler === 'function' && screenshotTimeout === null) {
        screenshotTimeout = () => (handler as (...invokeArgs: any[]) => void)(...args);
        return 9001 as unknown as number;
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    fireEvent.click(screen.getByText('request-screenshot'));

    await waitFor(() => {
      const messages = readSentMessages(ws);
      expect(messages.some((item) => item.type === 'remote-screenshot-request')).toBe(true);
    });

    await act(async () => {
      expect(screenshotTimeout).not.toBeNull();
      screenshotTimeout?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('remote-screenshot-result').textContent).toBe('error:Remote screenshot timed out during request-sent');
    });

    setTimeoutSpy.mockRestore();
  });

  it('shares one control socket across same-target sessions while keeping per-session data sockets', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.controlInstances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    const controlWs = MockWebSocket.controlInstances[0]!;
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();

    expect(readSentMessages(controlWs).filter((item) => item.type === 'session-open')).toHaveLength(2);
    expect(readSentMessages(ws1).some((item) => item.type === 'connect')).toBe(true);
    expect(readSentMessages(ws2).some((item) => item.type === 'connect')).toBe(true);
  });

  it('reuses the same control socket when reconnecting one session on a shared target', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(MockWebSocket.controlInstances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    const controlWs = MockWebSocket.controlInstances[0]!;
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();

    fireEvent.click(screen.getByText('reconnect-all'));

    await waitFor(() => expect(MockWebSocket.controlInstances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(4));
    expect(readSentMessages(controlWs).filter((item) => item.type === 'session-open').length).toBeGreaterThanOrEqual(4);
  });

  it('deduplicates semantic duplicate createSession requests onto one managed session truth', async () => {
    function DuplicateSessionHarness() {
      const { state, createSession } = useSession();

      useEffect(() => {
        createSession(host, { sessionId: 'session-1', activate: true });
        createSession({ ...host, id: 'host-dup' }, { sessionId: 'session-dup', activate: true });
      }, [createSession]);

      return (
        <div>
          <div data-testid="session-count">{state.sessions.length}</div>
          <div data-testid="active-session">{state.activeSessionId || 'missing'}</div>
          <div data-testid="session-ids">{state.sessions.map((session) => session.id).join('|')}</div>
        </div>
      );
    }

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <DuplicateSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('session-count').textContent).toBe('1'));
    await waitFor(() => expect(MockWebSocket.controlInstances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    expect(screen.getByTestId('session-ids').textContent).toBe('session-1');
  });
});
