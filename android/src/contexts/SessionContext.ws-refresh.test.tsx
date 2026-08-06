// @vitest-environment jsdom

import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Filesystem } from '@capacitor/filesystem';
import {
  SessionProvider,
  shouldReconnectActivatedSession,
  useSession,
} from './SessionContext';
import { useSessionBufferSnapshot } from '../lib/session-buffer-store';
import { useSessionRenderBufferSnapshot } from '../lib/session-render-buffer-store';
import { useSessionHeadSnapshot } from '../lib/session-head-store';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import type { Host, ServerMessage, TerminalBufferPayload, TerminalIndexedLine } from '../lib/types';
import { applyBufferSyncToSessionBuffer, cellsToLine, createSessionBufferState } from '../lib/terminal-buffer';
import { defaultTraversalRouteHealthCache } from '../lib/traversal/route-health-cache';
import { SESSION_TRANSPORT_KEEPALIVE_GRACE_MS } from './session-context-activity-runtime';

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
  static physicalInstances: MockWebSocket[] = [];
  static instances: MockWebSocket[] = [];
  static controlInstances: MockWebSocket[] = [];
  static autoOpenChannelReplies = true;

  readonly url: string;
  readonly transportRole: 'control' | 'session';
  private rootSocket: MockWebSocket;
  channelId: string | null = null;
  private channelViews = new Map<string, MockWebSocket>();
  private pendingServerMessages: Array<ServerMessage | Record<string, unknown>> = [];
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.rootSocket = this;
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
      MockWebSocket.physicalInstances.push(this);
      MockWebSocket.instances.push(this);
    }
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (typeof data !== 'string') {
      return;
    }
    const message = JSON.parse(data);
    if (this.transportRole === 'control') {
      if (message?.type !== 'session-open') {
        return;
      }
      const payload = message.payload || {};
      this.triggerMessage({
        type: 'session-ticket',
        payload: {
          openRequestId: payload.openRequestId,
          sessionTransportToken: `ticket-${payload.openRequestId}`,
          sessionName: payload.sessionName,
        },
      } as ServerMessage);
      return;
    }
    if (message?.type === 'mux-hello') {
      if (this.readyState === MockWebSocket.OPEN) {
        this.triggerRawMessage({
          type: 'mux-ready',
          payload: {
            version: 1,
            capabilities: {
              version: 1,
              channelEnvelope: true,
              targetMessages: true,
              boundedBodyScheduler: true,
            },
          },
        });
      }
      return;
    }
    if (message?.type === 'mux-channel-open') {
      const channelId = typeof message.payload?.channelId === 'string'
        ? message.payload.channelId
        : '';
      if (!channelId) {
        return;
      }
      this.ensureChannelView(channelId);
      if (this.readyState === MockWebSocket.OPEN && MockWebSocket.autoOpenChannelReplies) {
        this.triggerChannelOpened(channelId, message.payload?.sessionName);
        const pending = this.pendingServerMessages.splice(0);
        for (const pendingMessage of pending) {
          this.triggerMessage(pendingMessage);
        }
      }
    }
  }

  close() {
    this.rootSocket.readyState = MockWebSocket.CLOSED;
    this.rootSocket.onclose?.();
  }

  triggerOpen() {
    if (this.rootSocket.readyState === MockWebSocket.OPEN) {
      return;
    }
    this.rootSocket.readyState = MockWebSocket.OPEN;
    this.rootSocket.onopen?.();
  }

  triggerMessage(message: ServerMessage | Record<string, unknown>) {
    if (
      this.transportRole === 'session'
      && !this.channelId
      && typeof message.type === 'string'
      && !message.type.startsWith('mux-')
    ) {
      this.rootSocket.pendingServerMessages.push(message);
      return;
    }
    if (
      this.transportRole === 'session'
      && this.channelId
      && typeof message.type === 'string'
      && !message.type.startsWith('mux-')
    ) {
      this.triggerRawMessage({
        type: 'mux-channel-message',
        payload: {
          channelId: this.channelId,
          message,
        },
      });
      return;
    }
    this.triggerRawMessage(message);
  }

  triggerBufferSync(revision: number, label: string, channelId = this.channelId || '') {
    if (!channelId) {
      return;
    }
    this.triggerRawMessage({
      type: 'mux-channel-message',
      payload: {
        channelId,
        message: {
          type: 'buffer-sync',
          payload: compactPayload({
            startIndex: 0,
            endIndex: 1,
            revision,
            lines: [[0, label]],
          }),
        },
      },
    });
  }

  triggerChannelOpened(channelId = this.channelId || '', sessionName?: unknown) {
    if (!channelId) {
      return;
    }
    this.ensureChannelView(channelId);
    this.triggerRawMessage({
      type: 'mux-channel-opened',
      payload: {
        channelId,
        sessionName: typeof sessionName === 'string' ? sessionName : channelId,
      },
    });
    this.triggerRawMessage({
      type: 'mux-channel-message',
      payload: {
        channelId,
        message: {
          type: 'connected',
          payload: {
            daemonHostId: 'test-daemon',
          },
        },
      },
    });
    const pending = this.pendingServerMessages.splice(0);
    for (const pendingMessage of pending) {
      this.triggerMessage(pendingMessage);
    }
  }

  triggerChannelClosed(reason = 'channel closed', code = 'channel_closed') {
    if (!this.channelId) {
      return;
    }
    this.triggerRawMessage({
      type: 'mux-channel-closed',
      payload: {
        channelId: this.channelId,
        reason,
        code,
      },
    });
  }

  triggerError() {
    this.rootSocket.onerror?.();
  }

  private triggerRawMessage(message: unknown) {
    this.rootSocket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  private ensureChannelView(channelId: string) {
    const root = this.rootSocket;
    const existing = root.channelViews.get(channelId);
    if (existing) {
      return existing;
    }
    if (!root.channelId) {
      root.channelId = channelId;
      root.channelViews.set(channelId, root);
      return root;
    }
    const view = Object.create(MockWebSocket.prototype) as MockWebSocket;
    Object.assign(view, {
      url: root.url,
      transportRole: root.transportRole,
      rootSocket: root,
      channelId,
      channelViews: root.channelViews,
      pendingServerMessages: root.pendingServerMessages,
      sent: root.sent,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    });
    Object.defineProperty(view, 'readyState', {
      configurable: true,
      get: () => root.readyState,
      set: (nextState: number) => {
        root.readyState = nextState;
      },
    });
    root.channelViews.set(channelId, view);
    MockWebSocket.instances.push(view);
    return view;
  }

  static reset() {
    MockWebSocket.autoOpenChannelReplies = true;
    MockWebSocket.physicalInstances = [];
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

function readSentMessages(ws: MockWebSocket, startIndex = 0) {
  const rawMessages = ws.sent
    .slice(startIndex)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item));
  if (ws.transportRole !== 'session' || !ws.channelId) {
    return rawMessages;
  }
  return rawMessages.flatMap((frame) => {
    if (frame.type === 'mux-channel-message') {
      return frame.payload?.channelId === ws.channelId ? [frame.payload.message] : [];
    }
    if (frame.type === 'mux-channel-open') {
      return frame.payload?.channelId === ws.channelId
        ? [{ type: 'connect', payload: frame.payload }]
        : [];
    }
    if (frame.type === 'mux-channel-close') {
      return frame.payload?.channelId === ws.channelId
        ? [{ type: 'close', payload: frame.payload }]
        : [];
    }
    if (frame.type === 'mux-channel-binary') {
      return frame.payload?.channelId === ws.channelId
        ? [{ type: 'binary', payload: frame.payload }]
        : [];
    }
    if (frame.type === 'mux-ping') {
      return [{ type: 'ping', payload: frame.payload }];
    }
    if (frame.type === 'mux-target-message') {
      return [frame.payload.message];
    }
    return frame.type === 'mux-hello' ? [] : [frame];
  });
}

function readMuxChannelOpenMessages(ws: MockWebSocket, startIndex = 0) {
  return ws.sent
    .slice(startIndex)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item))
    .filter((item) => item.type === 'mux-channel-open');
}

async function openMockSessionChannels(count: number) {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  for (const ws of MockWebSocket.physicalInstances) {
    ws.triggerOpen();
  }
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(count);
}

async function waitForMockSessionInstances(count: number) {
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1));
  if (count > 1) {
    for (const ws of MockWebSocket.physicalInstances) {
      ws.triggerOpen();
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(count));
}

async function waitForMockPhysicalInstances(count: number) {
  await waitFor(() => expect(MockWebSocket.physicalInstances).toHaveLength(count));
}

async function waitForAtLeastMockSessionInstances(count: number) {
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1));
  if (count > 1) {
    for (const ws of MockWebSocket.physicalInstances) {
      ws.triggerOpen();
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(count));
}

async function resumeSingleSessionAcrossStaleActivity(
  ws: MockWebSocket,
  setNow: (isoTimestamp: string) => void,
) {
  ws.sent.length = 0;
  setNow('2026-04-27T00:00:40.000Z');
  fireEvent.click(screen.getByText('resume-active'));

  await waitFor(() => {
    expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
  });
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(ws.readyState).toBe(MockWebSocket.OPEN);

  setNow('2026-04-27T00:00:45.000Z');
  fireEvent.click(screen.getByText('resume-active'));
  await waitFor(() => {
    expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
  });
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(ws.readyState).toBe(MockWebSocket.OPEN);
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
    switchSession,
    sendInput,
    sendImagePaste,
    requestRemoteScreenshot,
    reconnectSession,
    reconnectAllSessions,
    resumeActiveSessionTransport,
    sendTerminalResize,
    updateSessionViewport,
    getSessionDebugMetrics,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
  } = useSession();
  const [remoteScreenshotResult, setRemoteScreenshotResult] = useState('idle');
  const [remoteScreenshotPhase, setRemoteScreenshotPhase] = useState('idle');

  useEffect(() => {
    createSession(host, { sessionId: 'session-1' });
    switchSession('session-1');
  }, [createSession, switchSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const activeBufferSnapshot = useSessionBufferSnapshot(getSessionBufferStore(), activeSession?.id || null);
  const activeRenderBufferSnapshot = useSessionRenderBufferSnapshot(getSessionRenderBufferStore(), activeSession?.id || null);
  const activeHeadSnapshot = useSessionHeadSnapshot(getSessionHeadStore(), activeSession?.id || null);
  const activeBuffer = activeSession ? activeBufferSnapshot.buffer : null;
  const activeRenderBuffer = activeSession ? activeRenderBufferSnapshot.buffer : null;
  const renderedLines = activeBuffer?.lines.map(cellsToLine) || [];
  const renderSnapshotLines = activeRenderBuffer?.lines.map(cellsToLine) || [];
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
      <div data-testid="render-session-revision">{activeRenderBuffer?.revision ?? -1}</div>
      <div data-testid="render-session-lines">{renderSnapshotLines.join('|')}</div>
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
      <button type="button" onClick={() => sendTerminalResize('session-1', 91, undefined, 'adaptive-phone')}>
        resize-adaptive
      </button>
      <button type="button" onClick={() => sendTerminalResize('session-1', undefined, undefined, 'mirror-fixed')}>
        resize-fixed
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          mode: 'reading',
          viewportEndIndex: 80,
          viewportRows: 24,
        })}
      >
        viewport-reading
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          mode: 'reading',
          viewportEndIndex: 80,
          viewportRows: 24,
        })}
      >
        viewport-reading-gap
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          mode: 'follow',
          viewportEndIndex: 120,
          viewportRows: 24,
        })}
      >
        viewport-follow
      </button>
      <button
        type="button"
        onClick={() => updateSessionViewport('session-1', {
          mode: 'follow',
          viewportEndIndex: 120,
          viewportRows: 40,
        })}
      >
        viewport-follow-expanded
      </button>
    </div>
  );
}

function MultiSessionHarness() {
  const {
    state,
    createSession,
    sendInput,
    switchSession,
    setLiveSessionIds,
    reconnectAllSessions,
    resumeActiveSessionTransport,
    updateSessionViewport,
    getSessionDebugMetrics,
    getSessionBufferStore,
    getSessionHeadStore,
  } = useSession();

  useEffect(() => {
    createSession(host, { sessionId: 'session-1' });
    createSession(host2, { sessionId: 'session-2' });
    switchSession('session-1');
  }, [createSession, switchSession]);

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
      <button
        type="button"
        onClick={() => {
          sendInput('session-2', 'typed-on-second\r');
        }}
      >
        send-second-input
      </button>
      <button type="button" onClick={() => reconnectAllSessions()}>
        reconnect-all
      </button>
      <button type="button" onClick={() => setLiveSessionIds(['session-1', 'session-2'])}>
        live-both
      </button>
      <button type="button" onClick={() => setLiveSessionIds(['session-2', 'session-1'])}>
        live-both-reversed
      </button>
      <button type="button" onClick={() => setLiveSessionIds(['session-2', 'session-2'])}>
        live-second-duplicated
      </button>
      <button type="button" onClick={() => setLiveSessionIds(['session-2'])}>
        live-second-only
      </button>
      <button type="button" onClick={() => setLiveSessionIds([])}>
        live-none
      </button>
      <button type="button" onClick={() => resumeActiveSessionTransport('session-2')}>
        resume-second
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) {
            return;
          }
          updateSessionViewport(activeSession.id, {
            mode: 'reading',
            viewportEndIndex: 110,
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
            mode: 'reading',
            viewportEndIndex: 96,
            viewportRows: 24,
          });
        }}
      >
        active-viewport-reading-deeper
      </button>
    </div>
  );
}

const previewBootstrapSessionIds = ['preview-1', 'preview-2', 'preview-3', 'preview-4', 'preview-5', 'preview-6'];
const previewBootstrapHosts = previewBootstrapSessionIds.map((_, index) => ({
  ...host,
  sessionName: `zterm_preview_${index + 1}`,
}));

function PreviewBootstrapRevision({ sessionId, index }: { sessionId: string; index: number }) {
  const { getSessionRenderBufferStore } = useSession();
  const snapshot = useSessionRenderBufferSnapshot(getSessionRenderBufferStore(), sessionId);
  return (
    <div data-testid={`preview-bootstrap-revision-${index + 1}`}>
      {snapshot.buffer.revision ?? 0}
    </div>
  );
}

function SixSessionPreviewBootstrapHarness() {
  const { state, createSession, switchSession, setLiveSessionIds } = useSession();

  useEffect(() => {
    previewBootstrapHosts.forEach((previewHost, index) => {
      createSession(previewHost, { sessionId: previewBootstrapSessionIds[index] });
    });
    switchSession(previewBootstrapSessionIds[0]);
    setLiveSessionIds([previewBootstrapSessionIds[0]]);
  }, [createSession, setLiveSessionIds, switchSession]);

  return (
    <div>
      <div data-testid="preview-bootstrap-active">{state.activeSessionId || 'missing'}</div>
      {previewBootstrapSessionIds.map((sessionId, index) => (
        <PreviewBootstrapRevision key={sessionId} sessionId={sessionId} index={index} />
      ))}
      <button type="button" onClick={() => setLiveSessionIds(previewBootstrapSessionIds)}>preview-live-all</button>
      <button type="button" onClick={() => setLiveSessionIds([previewBootstrapSessionIds[0]])}>preview-live-primary-only</button>
    </div>
  );
}

function StaleFollowHarness() {
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'stale-session',
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
    switchSession('stale-session');
  }, [createSession, switchSession]);

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
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'stale-visible-session',
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
    switchSession('stale-visible-session');
  }, [createSession, switchSession]);

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
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'far-behind-session',
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
    switchSession('far-behind-session');
  }, [createSession, switchSession]);

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
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'near-head-session',
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
    switchSession('near-head-session');
  }, [createSession, switchSession]);

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
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

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
            buffer: sparseBuffer,
    });
    switchSession('near-head-gap-session');
  }, [createSession, switchSession]);

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
  const { state, createSession, switchSession, updateSessionViewport, getSessionBufferStore, getSessionHeadStore } = useSession();

  useEffect(() => {
    createSession(host, {
      sessionId: 'compact-follow-session',
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
    switchSession('compact-follow-session');
  }, [createSession, switchSession]);

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

  beforeEach(() => {
    cleanup();
    // Reset mock instances BEFORE stubbing to ensure clean slate for THIS test file.
    // This prevents cross-file bleed: other test files may not stub WebSocket to
    // MockWebSocket, so their WebSocket usage would go to the real global and bypass
    // MockWebSocket.instances tracking — but if they DO stub, their instances would
    // otherwise accumulate here.
    MockWebSocket.instances.length = 0;
    MockWebSocket.controlInstances.length = 0;
    defaultTraversalRouteHealthCache.clear();
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
    // Double-reset after unstub: ensures any late async callbacks that fire during
    // teardown don't re-populate instances for the NEXT file in the run queue.
    MockWebSocket.instances.length = 0;
    MockWebSocket.controlInstances.length = 0;
    globalThis.WebSocket = originalWebSocket;
  });

  it('applies sequential websocket buffer-sync updates to the active session', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const sentTypes = readSentMessages(ws).map((item) => item.type);
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
      await vi.advanceTimersByTimeAsync(33);
      await act(async () => {
        await Promise.resolve();
      });
      // The render gate has no per-session debounce; only the RAF batch needs one frame to flush.
      for (let frame = 0; frame < 5 && !screen.getByTestId('render-session-lines').textContent?.includes('stable-line-001'); frame += 1) {
        await vi.advanceTimersByTimeAsync(16);
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(screen.getByTestId('render-session-lines').textContent).toContain('stable-line-001');
      expect(screen.getByTestId('render-session-revision').textContent).toBe('1');
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    const sentTypes = readSentMessages(ws).map((item) => item.type);
    expect(sentTypes).not.toContain('buffer-sync-request');
  });

  it('does not create a third transport when switching between two same-target sessions that already have their own transports', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

  it('reuses the active session websocket on foreground resume and only requests head', async () => {
    const view = render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive={false}>
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    view.rerender(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sentMessages.some((item) => item.type === 'connect')).toBe(false);
    });
  });

  it('keeps a stale pending session websocket on foreground resume instead of creating another websocket', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const view = render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive={false}>
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const staleSessionSocket = MockWebSocket.instances[0]!;
      expect(staleSessionSocket.readyState).toBe(MockWebSocket.CONNECTING);

      nowSpy.mockReturnValue(7000);
      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(staleSessionSocket.readyState).toBe(MockWebSocket.CONNECTING);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not create a second websocket when explicit reconnect is requested while the socket is still open', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]).toBe(ws);
  });

  it('still creates a new websocket when explicit reconnect sees a closed socket', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
    fireEvent.click(screen.getByText('reconnect-session'));

    await waitForMockSessionInstances(2);
    expect(MockWebSocket.instances[0]).toBe(ws);
    expect(MockWebSocket.instances[1]).not.toBe(ws);
  });

  it('bootstrap sync starts from head truth and only asks the latest follow window after head arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
          requestStartIndex: 216,
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

      await waitForMockSessionInstances(1);
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

  it('forces explicit active resume head even when connected baseline just requested head', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });
      fireEvent.click(screen.getByText('resume-active'));

      await waitFor(() => {
        const sentMessages = readSentMessages(ws);
        expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(2);
        expect(sentMessages.filter((item) => item.type === 'connect')).toHaveLength(1);
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

      await waitForMockSessionInstances(2);
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

    await waitForMockSessionInstances(1);
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

  it('reconnects a recently alive closed websocket on session switch because the old socket cannot be reused', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-07-18T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
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
      now += 5_000;

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('reconnecting'));
      await waitForAtLeastMockSessionInstances(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reconnects the switched-to closed websocket after the keepalive grace window expires', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-07-18T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      ws2.readyState = MockWebSocket.CLOSED;
      now += SESSION_TRANSPORT_KEEPALIVE_GRACE_MS + 1;
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('reconnecting'));
      await waitForAtLeastMockSessionInstances(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reconnects the active session immediately when input is queued against a closed websocket', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForAtLeastMockSessionInstances(2);
  });

  it('sends input on an open active transport even after a long quiet period', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
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
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not treat quiet open transport as stale for explicit input', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
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
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
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

      await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(2);
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


  it('forces explicit foreground resume head after tab switch on the same active socket', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      ws2.sent.length = 0;
      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      fireEvent.click(screen.getByText('resume-second'));

      await waitFor(() => {
        const sentMessages = readSentMessages(ws2);
        expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(2);
        expect(sentMessages.some((item) => item.type === 'connect')).toBe(false);
      });
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-sync-request')).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reconnects active transport on explicit resume when no usable websocket exists', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForAtLeastMockSessionInstances(2);
  });

  it('marks the session non-connected immediately after live transport close so active refresh cannot keep treating it as connected', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

    ws.close();

    await waitFor(() => {
      expect(screen.getByTestId('session-state').textContent).not.toBe('connected');
    });
  });

  it('reuses an active open transport on explicit resume even while the session label is still connecting', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.sent.length = 0;

    fireEvent.click(screen.getByText('resume-active'));

    await waitFor(() => {
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
    expect(screen.getByTestId('session-state').textContent).toBe('connected');
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

  it('issues immediate explicit resume head refresh when app foreground truth flips back to active', async () => {
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

      view.rerender(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <SessionHarness />
        </SessionProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies foreground resume head and body updates on the same socket without freezing render output', async () => {
    const view = render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive={false}>
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
      payload: compactPayload({
        startIndex: 0,
        endIndex: 2,
        revision: 1,
        lines: [[0, 'background-old-line-001'], [1, 'background-old-line-002']],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('render-session-lines').textContent).toContain('background-old-line-001');
    });
    ws.sent.length = 0;

    view.rerender(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive foregroundResumeEpoch={1}>
        <SessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
    ws.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-1',
        revision: 2,
        latestEndIndex: 3,
        availableStartIndex: 0,
        availableEndIndex: 3,
      },
    });

    await waitFor(() => {
      expect(readSentMessages(ws).some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });
    ws.triggerMessage({
      type: 'buffer-sync',
      payload: compactPayload({
        startIndex: 0,
        endIndex: 3,
        revision: 2,
        lines: [[0, 'foreground-new-line-001'], [1, 'foreground-new-line-002'], [2, 'foreground-new-line-003']],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('render-session-revision').textContent).toBe('2');
      expect(screen.getByTestId('render-session-lines').textContent).toContain('foreground-new-line-003');
    });
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
  });


  it('does not stack multiple active-tick probe loops across provider rerenders', async () => {
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
      expect(readSentMessages(ws).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);

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

      expect(readSentMessages(ws).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active tick requests each live session at most once even when active session is also in the live set', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
      fireEvent.click(screen.getByText('live-both'));
      ws1.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-1', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests head immediately when a non-active pane first becomes visible live', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await openMockSessionChannels(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    ws1.sent.length = 0;
    ws2.sent.length = 0;

    fireEvent.click(screen.getByText('live-both'));

    await waitFor(() => {
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });
    expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
  });

  it('active tick does not multiply requests when live session order changes without semantic change', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
      fireEvent.click(screen.getByText('live-both'));
      fireEvent.click(screen.getByText('live-both-reversed'));
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active tick still refreshes the active session when pane live ids are temporarily empty', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
      fireEvent.click(screen.getByText('live-none'));
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active tick stops polling the previous tab after live sessions switch to the new active tab only', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByText('switch-second'));
      fireEvent.click(screen.getByText('live-second-only'));
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bootstraps all five passive preview channels from an already-connected primary-only live set', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
        <SixSessionPreviewBootstrapHarness />
      </SessionProvider>,
    );

    await openMockSessionChannels(6);
    await waitFor(() => {
      expect(screen.getByTestId('preview-bootstrap-active').textContent).toBe('preview-1');
    });

    for (const ws of MockWebSocket.instances.slice(1)) {
      expect(readMuxChannelOpenMessages(ws).map((message) => ([
        message.payload?.channelId,
        message.payload?.bodySubscribed,
      ]))).toContainEqual([ws.channelId, false]);
    }

    const sentBeforePreviewOpen = MockWebSocket.physicalInstances[0]!.sent.length;
    fireEvent.click(screen.getByText('preview-live-all'));

    for (const ws of MockWebSocket.instances.slice(1)) {
      await waitFor(() => {
        expect(readSentMessages(ws, sentBeforePreviewOpen).some((message) => (
          message.type === 'body-subscription' && message.payload?.subscribed === true
        ))).toBe(true);
      });
    }

    for (let index = 1; index < MockWebSocket.instances.length; index += 1) {
      const ws = MockWebSocket.instances[index]!;
      const sentBeforeHead = MockWebSocket.physicalInstances[0]!.sent.length;
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: previewBootstrapSessionIds[index],
          revision: 1,
          latestEndIndex: 24,
          availableStartIndex: 0,
          availableEndIndex: 24,
        },
      });
      await waitFor(() => {
        expect(readSentMessages(ws, sentBeforeHead).some((message) => (
          message.type === 'buffer-sync-request'
          && message.payload?.requestStartIndex === 0
          && message.payload?.requestEndIndex === 24
        ))).toBe(true);
      });
      ws.triggerMessage({
        type: 'buffer-sync',
        payload: compactPayload({
          startIndex: 0,
          endIndex: 24,
          revision: 1,
          lines: Array.from({ length: 24 }, (_, rowIndex) => [
            rowIndex,
            `preview-${index + 1}-row-${rowIndex}`,
          ] as const),
        }),
      });
    }

    for (let index = 1; index < previewBootstrapSessionIds.length; index += 1) {
      await waitFor(() => {
        expect(screen.getByTestId(`preview-bootstrap-revision-${index + 1}`).textContent).toBe('1');
      });
    }
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
  });

  it('visible non-active panes still refresh without requiring interactive activation, but no longer rely on same-frequency active-tick fan-out', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
      fireEvent.click(screen.getByText('live-both'));
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThan(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThan(0);
      ws1.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-1', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });

      fireEvent.click(screen.getByText('switch-second'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 2, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThan(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active tick deduplicates duplicate live-pane references for the same session in the real SessionContext loop', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws" appForegroundActive>
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await openMockSessionChannels(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByText('switch-second'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      fireEvent.click(screen.getByText('live-second-duplicated'));
      ws1.sent.length = 0;
      ws2.sent.length = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });

      expect(readSentMessages(ws1).filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      expect(readSentMessages(ws2).filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
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

    await waitForMockSessionInstances(1);
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

    let sentMessages = readSentMessages(ws);
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
      sentMessages = readSentMessages(ws);
      const requests = sentMessages.filter((item) => item.type === 'buffer-sync-request');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.payload?.missingRanges).toEqual([{ startIndex: 56, endIndex: 80 }]);
      expect(requests[1]?.payload?.missingRanges).toBeUndefined();
    });
  });

  it('does not emit an extra repair request before head when the same session returns from reading to follow', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    let sentMessages = readSentMessages(ws);
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
      sentMessages = readSentMessages(ws);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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
      const sentMessages = readSentMessages(ws, sentCountBeforeInput);
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

    await waitForMockSessionInstances(1);
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

    const sentMessages = readSentMessages(ws);

    expect(sentMessages.filter((item) => item.type === 'input')).toHaveLength(3);
    expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);

    await waitFor(() => {
      const delayedMessages = readSentMessages(ws);
      expect(delayedMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });
  });

  it('defers the input head request when user input exits reading mode inside the head throttle window', async () => {
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
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
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(0);
      await waitFor(() => {
        const delayedMessages = readSentMessages(ws);
        expect(delayedMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
      });
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

    await waitForMockSessionInstances(1);
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
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBeLessThanOrEqual(1);
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);
    }, { timeout: 220 });
  });


  it('does not rebuild an open active transport only because traffic is pong-only', async () => {
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

      expect(MockWebSocket.physicalInstances).toHaveLength(1);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(ws1.readyState).toBe(MockWebSocket.OPEN);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('input sends upstream immediately and defers head for the first pending tail refresh', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.some((item) => item.type === 'input')).toBe(true);
    expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(false);
    await waitFor(() => {
      const delayedMessages = readSentMessages(ws);
      expect(delayedMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
  });

  it('immediately catches up to a newer head after an older tail pull finishes instead of waiting for the next head tick', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
      expect(sentMessages.filter((item) => item.type === 'buffer-sync-request').length).toBeGreaterThanOrEqual(1);
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request').length).toBeGreaterThanOrEqual(1);
    }, { timeout: 220 });
  });

  it('does not replay prior explicit input after reconnect', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws1 = MockWebSocket.instances[0]!;
    ws1.triggerOpen();
    ws1.triggerMessage({
      type: 'connected',
      payload: {
        sessionId: 'session-1',
      },
    });

    ws1.close();
    fireEvent.click(screen.getByText('send-input'));
    fireEvent.click(screen.getByText('reconnect-session'));

    await waitForAtLeastMockSessionInstances(2);
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
      expect(sentMessages.some((item) => item.type === 'input')).toBe(false);
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
    });
  });

  it('does not queue explicit input before first connect completes for a switched tab', async () => {
    MockWebSocket.autoOpenChannelReplies = false;
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);

      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;

      ws1.triggerOpen();
      const session1Connect = readSentMessages(ws1).find((item) => item.type === 'connect');
      expect(typeof session1Connect?.payload?.channelId).toBe('string');
      ws1.triggerChannelOpened(session1Connect.payload.channelId, 'zterm_mirror_lab');
      ws1.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

      fireEvent.click(screen.getByText('send-second-input'));
      expect(readSentMessages(ws2).some((item) => item.type === 'input')).toBe(false);

      const session2Connect = readSentMessages(ws2).find((item) => item.type === 'connect');
      expect(typeof session2Connect?.payload?.channelId).toBe('string');
      ws2.triggerChannelOpened(session2Connect.payload.channelId, 'zterm_mirror_lab_2');
      ws2.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-2',
        },
      });

      await waitFor(() => {
        const sentMessages = readSentMessages(ws2);
        expect(sentMessages.some((item) => item.type === 'input' && item.payload === 'typed-on-second\r')).toBe(false);
        expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(true);
      });
    } finally {
      MockWebSocket.autoOpenChannelReplies = true;
    }
  });



  it('does not let an in-flight reading repair block latest tail refresh while renderer stays in reading', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws"> 
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
          && item.payload?.requestStartIndex === 56
          && item.payload?.requestEndIndex === 80,
      );
      expect(readingRepair).toBeDefined();
      const firstMissingRange = readingRepair?.payload?.missingRanges?.[0];
      expect(firstMissingRange?.endIndex).toBe(80);
      expect(firstMissingRange?.startIndex).toBe(56);
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

    await waitForMockSessionInstances(1);
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
      expect(sentMessages.some((item) => item.type === 'buffer-head-request')).toBe(false);
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

    await waitForMockSessionInstances(1);
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
          && item.payload?.requestStartIndex === 56
          && item.payload?.requestEndIndex === 80,
      );
      expect(readingRepair).toBeDefined();
      const firstMissingRange = readingRepair?.payload?.missingRanges?.[0];
      expect(firstMissingRange?.endIndex).toBe(80);
      expect(firstMissingRange?.startIndex).toBe(56);
    });
  });

  it('does not issue reading-repair requests for follow viewport updates', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    fireEvent.click(screen.getByText('viewport-follow'));

    await new Promise((resolve) => setTimeout(resolve, 80));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);
  });


  it('does not issue duplicate reading-repair requests while the local snapshot is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    ws1.readyState = MockWebSocket.CLOSED;
    fireEvent.click(screen.getByText('reconnect-session'));
    await waitForMockSessionInstances(2);
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
      const sentMessages = readSentMessages(ws2);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws1.readyState = MockWebSocket.CLOSED;
    ws2.readyState = MockWebSocket.CLOSED;
    fireEvent.click(screen.getByText('reconnect-all'));

    await waitForMockPhysicalInstances(2);
    const reconnectRoot = MockWebSocket.physicalInstances[1]!;
    reconnectRoot.triggerOpen();

    await waitFor(() => {
      const channelOpens = readMuxChannelOpenMessages(reconnectRoot);
      expect(channelOpens.map((item) => item.payload?.sessionName)).toEqual([
        'zterm_mirror_lab_2',
        'zterm_mirror_lab',
      ]);
    });
    expect(MockWebSocket.physicalInstances).toHaveLength(2);
  });

  it('uses a terminal channel id for each connect handshake instead of reusing sessionId truth', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    let initialChannelId = '';
    await waitFor(() => {
      const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
      expect(typeof connectMessage?.payload?.channelId).toBe('string');
      expect(connectMessage?.payload?.channelId).not.toBe('session-1');
      expect(connectMessage?.payload?.sessionName).toBe('zterm_mirror_lab');
      initialChannelId = connectMessage?.payload?.channelId || '';
    });

    ws.readyState = MockWebSocket.CLOSED;
    fireEvent.click(screen.getByText('reconnect-session'));

    await waitForMockSessionInstances(2);
    const reconnectWs = MockWebSocket.instances[1]!;
    reconnectWs.triggerOpen();

    await waitFor(() => {
      const reconnectMessage = readSentMessages(reconnectWs).find((item) => item.type === 'connect');
      expect(typeof reconnectMessage?.payload?.channelId).toBe('string');
      expect(reconnectMessage?.payload?.channelId || initialChannelId).toBeTruthy();
      expect(reconnectMessage?.payload?.sessionName).toBe('zterm_mirror_lab');
    });
  });

  it('keeps the current open transport during repeated resume after stale activity', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

      await resumeSingleSessionAcrossStaleActivity(ws, (timestamp) => {
        now = new Date(timestamp).getTime();
      });

      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not create a superseded transport after repeated resume on the same open socket', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

      await resumeSingleSessionAcrossStaleActivity(ws, (timestamp) => {
        now = new Date(timestamp).getTime();
      });

      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps repeated resume on an open socket from creating late superseded transport events', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      });

      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));

      await resumeSingleSessionAcrossStaleActivity(ws, (timestamp) => {
        now = new Date(timestamp).getTime();
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getByTestId('session-state').textContent).toBe('connected');
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not request adaptive-phone cols in connect handshakes until explicit resize truth exists', async () => {
    const originalInnerHeight = window.innerHeight;
    try {
      render(
        <SessionProvider
          wsUrl="ws://127.0.0.1:3333/ws"
          bridgeSettings={{ terminalWidthMode: 'adaptive-phone' } as any}
        >
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      const resizeMessage = readSentMessages(ws).find((item) => item.type === 'resize');
      expect(resizeMessage).toBeUndefined();

      await waitFor(() => {
        const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
        expect(typeof connectMessage?.payload?.channelId).toBe('string');
        expect(connectMessage?.payload?.channelId).not.toBe('session-1');
        expect(connectMessage?.payload?.widthMode).toBe('mirror-fixed');
        expect(connectMessage?.payload?.cols).toBeUndefined();
        expect(connectMessage?.payload?.rows).toBeUndefined();
      });

      act(() => {
        fireEvent.click(screen.getByText('resize-adaptive'));
      });

      await waitFor(() => {
        const resizeMessageAfterExplicitWrite = readSentMessages(ws).find((item) => item.type === 'resize');
        expect(resizeMessageAfterExplicitWrite?.payload?.widthMode).toBe('adaptive-phone');
        expect(resizeMessageAfterExplicitWrite?.payload?.cols).toBe(91);
        expect(resizeMessageAfterExplicitWrite?.payload?.rows).toBeUndefined();
      });

      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: Math.max(320, originalInnerHeight - 240),
      });

      ws.readyState = MockWebSocket.CLOSED;
      fireEvent.click(screen.getByText('reconnect-session'));

      await waitForMockSessionInstances(2);
      const reconnectWs = MockWebSocket.instances[1]!;
      reconnectWs.triggerOpen();

      await waitFor(() => {
        const reconnectMessage = readSentMessages(reconnectWs).find((item) => item.type === 'connect');
        expect(typeof reconnectMessage?.payload?.channelId).toBe('string');
        expect(reconnectMessage?.payload?.channelId).not.toBe('session-1');
        expect(reconnectMessage?.payload?.widthMode).toBe('adaptive-phone');
        expect(reconnectMessage?.payload?.cols).toBe(91);
        expect(reconnectMessage?.payload?.rows).toBeUndefined();
      });
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('keeps mirror-fixed connect handshake free of client cols/rows even after resize writes', async () => {
    render(
      <SessionProvider
        wsUrl="ws://127.0.0.1:3333/ws"
        bridgeSettings={{ terminalWidthMode: 'mirror-fixed' } as any}
      >
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
      expect(connectMessage?.payload?.widthMode).toBe('mirror-fixed');
      expect(connectMessage?.payload?.cols).toBeUndefined();
      expect(connectMessage?.payload?.rows).toBeUndefined();
    });
  });

  it('does not synthesize adaptive reconnect geometry from settings without explicit adaptive cols', async () => {
    function WidthModeHarness() {
      const [terminalWidthMode, setTerminalWidthMode] = useState<'adaptive-phone' | 'mirror-fixed'>('mirror-fixed');
      return (
        <div>
          <button type="button" onClick={() => setTerminalWidthMode('adaptive-phone')}>
            set-adaptive
          </button>
          <SessionProvider
            wsUrl="ws://127.0.0.1:3333/ws"
            bridgeSettings={{ terminalWidthMode } as any}
          >
            <SessionHarness />
          </SessionProvider>
        </div>
      );
    }

    render(<WidthModeHarness />);

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const connectMessage = readSentMessages(ws).find((item) => item.type === 'connect');
      expect(connectMessage?.payload?.widthMode).toBe('mirror-fixed');
    });

    fireEvent.click(screen.getByText('resize-fixed'));
    await waitFor(() => {
      const resizeMessage = readSentMessages(ws).find((item) => item.type === 'resize');
      expect(resizeMessage?.payload?.widthMode).toBe('mirror-fixed');
      expect(resizeMessage?.payload?.cols).toBeUndefined();
    });

    fireEvent.click(screen.getByText('set-adaptive'));

    ws.readyState = MockWebSocket.CLOSED;
    fireEvent.click(screen.getByText('reconnect-session'));

    await waitForMockSessionInstances(2);
    const reconnectWs = MockWebSocket.instances[1]!;
    reconnectWs.triggerOpen();

    await waitFor(() => {
      const reconnectMessage = readSentMessages(reconnectWs).find((item) => item.type === 'connect');
      expect(reconnectMessage?.payload?.widthMode).toBe('mirror-fixed');
      expect(reconnectMessage?.payload?.cols).toBeUndefined();
      expect(reconnectMessage?.payload?.rows).toBeUndefined();
    });
  });

  it('keeps the inactive tab transport open when switching active tabs', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
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

      await waitForMockSessionInstances(2);
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
      ws1.readyState = MockWebSocket.CLOSED;
      ws2.readyState = MockWebSocket.CLOSED;
      fireEvent.click(screen.getByText('reconnect-all'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(MockWebSocket.physicalInstances).toHaveLength(2);
      const reconnectRoot = MockWebSocket.physicalInstances[1]!;
      reconnectRoot.triggerOpen();
      const channelOpens = readMuxChannelOpenMessages(reconnectRoot);
      expect(channelOpens.map((item) => item.payload?.sessionName)).toEqual([
        'zterm_mirror_lab_2',
        'zterm_mirror_lab',
      ]);
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

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      vi.useFakeTimers();
      ws1.readyState = MockWebSocket.CLOSED;
      ws2.readyState = MockWebSocket.CLOSED;
      fireEvent.click(screen.getByText('reconnect-all'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });

      expect(MockWebSocket.physicalInstances).toHaveLength(2);
      const reconnectRoot = MockWebSocket.physicalInstances[1]!;
      reconnectRoot.triggerOpen();

      const channelOpens = readMuxChannelOpenMessages(reconnectRoot);
      expect(channelOpens).toHaveLength(2);
      const [connect1, connect2] = channelOpens;
      expect(typeof connect1?.payload?.channelId).toBe('string');
      expect(typeof connect2?.payload?.channelId).toBe('string');
      expect(connect1?.payload?.channelId).not.toBe(connect2?.payload?.channelId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests latest head when switching back to a connected tab with a continuous local tail', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tail-row-001', 'tail-row-002', 'tail-row-003'], 3, 6),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('6'));

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });
  });

  it('accepts bootstrap buffer-sync for an empty inactive tab and switches back without forcing a redundant head-first rebuild', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['inactive-tail-001', 'inactive-tail-002', 'inactive-tail-003'], 3, 6),
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-session').textContent).toBe('session-1');
      expect(screen.getByTestId('session-2-revision').textContent).toBe('6');
    });

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('6'));
  });

  it('requests latest head when switching to a connected tab without local lines', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });
  });

  it('accepts immediate post-switch buffer-sync for the newly active tab before live pane ids settle', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['switched-tail-001', 'switched-tail-002'], 2, 4),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-2-revision').textContent).toBe('4');
    });
  });

  it('repairs local gaps after the newly active renderer declares its visible range when switching to a connected tab whose local buffer misses the visible window', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
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
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 80,
        availableStartIndex: 0,
        availableEndIndex: 80,
      },
    });

    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });
  });

  it('repairs local visible gaps after the newly active renderer declares its visible range when switching to a connected tab whose local tail window still has visible gaps', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
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
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(false);
    });

    ws2.triggerMessage({
      type: 'buffer-head',
      payload: {
        sessionId: 'session-2',
        revision: 6,
        latestEndIndex: 80,
        availableStartIndex: 0,
        availableEndIndex: 80,
      },
    });

    await waitFor(() => {
      const sent2 = readSentMessages(ws2);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(true);
    });
  });

  it('head metadata alone does not force reconnect when no newer tail exists', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: linesToPayload(['tail-row-001', 'tail-row-002', 'tail-row-003'], 3, 6),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('6'));

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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
        revision: 3,
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
        revision: 2,
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

  it('refreshes the full follow request window when revision advances at the same head end without tail growth', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

  it('applies changed existing rows after same-end head revision advance without requiring tail growth', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 0,
        endIndex: 240,
        revision: 3,
        lines: Array.from({ length: 240 }, (_, index) => [index, `row-${String(index).padStart(3, '0')}`] as const),
      }),
    });
    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('3'));
    expect(screen.getByTestId('session-lines').textContent).toContain('row-220');
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

    await waitFor(() => {
      const tailRefresh = readSentMessages(ws).find((item) => item.type === 'buffer-sync-request');
      expect(tailRefresh).toMatchObject({
        type: 'buffer-sync-request',
        payload: {
          requestStartIndex: 216,
          requestEndIndex: 240,
        },
      });
    });

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 216,
        endIndex: 240,
        revision: 4,
        lines: Array.from({ length: 24 }, (_, offset) => {
          const index = 216 + offset;
          return [index, index === 220 ? 'ROW-220-UPDATED' : `row-${String(index).padStart(3, '0')}`] as const;
        }),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('4'));
    expect(screen.getByTestId('session-lines').textContent).toContain('ROW-220-UPDATED');
  });

  it('clears in-flight tail-refresh state when daemon completes the request with an empty buffer-sync payload', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

  it('jumps directly to the latest visible tail when daemon head is far ahead of the local buffer', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <FarBehindFollowHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
          requestStartIndex: 476,
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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
          requestStartIndex: 172108,
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

    await waitForMockSessionInstances(1);
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

  it('does not pull body when daemon head truth is unchanged and renderer has not declared a new visible demand', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <NearHeadGapFollowHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
    expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
  });

  it('refreshes the current follow tail window when daemon revision changes even if endIndex is unchanged', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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
          requestStartIndex: 187531,
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
          requestStartIndex: 187553,
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

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
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

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
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

  it('refreshes only the visible tail window on re-entry same-end revision advance', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.triggerMessage({
      type: 'buffer-sync',
      payload: indexedPayload({
        startIndex: 8,
        endIndex: 80,
        revision: 5,
        lines: Array.from({ length: 72 }, (_, offset) => [8 + offset, `row-${String(8 + offset).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe('5'));
    ws2.sent.length = 0;

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
        latestEndIndex: 80,
        availableStartIndex: 0,
        availableEndIndex: 80,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 56,
          requestEndIndex: 80,
        }),
      });
    });
  });

  it('clears stale pending input tail refresh on tab switch so the first input after re-entry immediately requests head', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

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

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('send-second-input'));
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'input',
        payload: 'typed-on-second\r',
      });
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });

    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('send-second-input'));
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'input',
        payload: 'typed-on-second\r',
      });
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });
  });


  it('reissues a fresh head request after tab re-entry even when the previous input-driven head never produced a usable refresh', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

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

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('send-second-input'));
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'input',
        payload: 'typed-on-second\r',
      });
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    });

    // simulate field case: no usable head/sync ever comes back for the first input-driven probe
    fireEvent.click(screen.getByText('switch-first'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));

    ws2.sent.length = 0;
    fireEvent.click(screen.getByText('send-second-input'));
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws2);
      expect(sentMessages).toContainEqual({
        type: 'input',
        payload: 'typed-on-second\r',
      });
      expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
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

      await waitForMockSessionInstances(1);
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

  it('reissues a same-window tail-refresh when a newer head arrives while an older in-flight request is still tracked', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
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
      now = new Date('2026-04-27T00:00:00.180Z').getTime();
      ws.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'session-1',
          revision: 7,
          latestEndIndex: 122,
          availableStartIndex: 0,
          availableEndIndex: 122,
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
            requestEndIndex: 122,
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

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));
      ws2.sent.length = 0;

      now = new Date('2026-04-27T00:00:02.600Z').getTime();
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

  it('keeps the stale-open active transport when its explicit probe receives server activity', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      ws2.sent.length = 0;
      now = new Date('2026-04-27T00:00:02.600Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);

      now = new Date('2026-04-27T00:00:02.700Z').getTime();
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: {
          sessionId: 'session-2',
          revision: 2,
          latestEndIndex: 122,
          availableStartIndex: 0,
          availableEndIndex: 122,
        },
      });

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      now = new Date('2026-04-27T00:00:03.900Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps a stale-open transport on tab reentry and only requests head', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      ws2.sent.length = 0;
      now = new Date('2026-04-27T00:00:02.600Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      now = new Date('2026-04-27T00:00:03.900Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);
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

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws2.sent.length = 0;

      now = new Date('2026-04-27T00:00:02.600Z').getTime();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);

      now = new Date('2026-04-27T00:00:02.800Z').getTime();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      expect(ws2.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('issues a low-frequency head probe for an active open transport before stale reconnect threshold when live push stays silent', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);
      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
      ws2.triggerMessage({
        type: 'buffer-head',
        payload: { sessionId: 'session-2', revision: 1, latestEndIndex: 0, availableStartIndex: 0, availableEndIndex: 0 },
      });
      ws2.sent.length = 0;

      now = new Date('2026-04-27T00:00:00.600Z').getTime();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);
      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
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

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

    ws2.triggerChannelClosed('inactive channel closed', 'channel_closed');

    await waitFor(() => {
      expect(screen.getByTestId('session-2-state').textContent).toBe('idle');
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
  });

  it('reopens a closed inactive mux channel on the same physical socket when switching back', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const rootSocket = MockWebSocket.physicalInstances[0]!;
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

    const sentBeforeClose = rootSocket.sent.length;
    const secondChannelId = ws2.channelId;
    ws2.triggerChannelClosed('inactive channel closed', 'channel_closed');

    await waitFor(() => {
      expect(screen.getByTestId('session-2-state').textContent).toBe('idle');
    });

    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      expect(readMuxChannelOpenMessages(rootSocket, sentBeforeClose).some((item) => (
        item.payload?.channelId === secondChannelId
      ))).toBe(true);
    });
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('reopens a closed inactive mux channel when preview adds it to the live set', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const rootSocket = MockWebSocket.physicalInstances[0]!;
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

    const sentBeforeClose = rootSocket.sent.length;
    const secondChannelId = ws2.channelId;
    ws2.triggerChannelClosed('inactive channel closed', 'channel_closed');
    await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('idle'));

    fireEvent.click(screen.getByText('live-both'));

    await waitFor(() => {
      expect(readMuxChannelOpenMessages(rootSocket, sentBeforeClose).some((item) => (
        item.payload?.channelId === secondChannelId
        && item.payload?.bodySubscribed === true
      ))).toBe(true);
    });
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
    expect(screen.getByTestId('active-session').textContent).toBe('session-1');
  });

  it('lets the second tab continue scrolling deeper while an older reading repair is still in flight', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));
    await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
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
          requestStartIndex: 86,
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
          requestStartIndex: 72,
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

    await waitForMockSessionInstances(1);
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

  it('does not widen input-driven same-end refresh beyond the visible window when only the current tail screen needs repaint', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
        revision: 5,
        lines: Array.from({ length: 72 }, (_, offset) => [8 + offset, `row-${String(8 + offset).padStart(3, '0')}`] as const),
      }),
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
        latestEndIndex: 80,
        availableStartIndex: 0,
        availableEndIndex: 80,
      },
    });

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 56,
          requestEndIndex: 80,
        }),
      });
      expect(sentMessages).not.toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 8,
          requestEndIndex: 80,
        }),
      });
    });
  });

  it('requests repair for the newly exposed upper band when follow viewport expands after a narrower tail repaint', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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
        startIndex: 96,
        endIndex: 120,
        revision: 5,
        lines: Array.from({ length: 24 }, (_, offset) => [96 + offset, `row-${String(96 + offset).padStart(3, '0')}`] as const),
      }),
    });

    await waitFor(() => expect(screen.getByTestId('session-revision').textContent).toBe('5'));

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('viewport-follow'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readSentMessages(ws).filter((item) => item.type === 'buffer-sync-request')).toHaveLength(0);

    ws.sent.length = 0;
    fireEvent.click(screen.getByText('viewport-follow-expanded'));

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages).toContainEqual({
        type: 'buffer-sync-request',
        payload: expect.objectContaining({
          requestStartIndex: 80,
          requestEndIndex: 120,
          missingRanges: [{ startIndex: 80, endIndex: 96 }],
        }),
      });
    });
  });

  it('promotes a connecting session from live buffer-head before connected arrives', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

  it('keeps one pending buffer head probe while the active session is still connecting', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    await waitFor(() => {
      const sentMessages = readSentMessages(ws);
      expect(sentMessages.some((item) => item.type === 'connect')).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const sentMessages = readSentMessages(ws);
    expect(sentMessages.filter((item) => item.type === 'buffer-head-request')).toHaveLength(1);
    expect(screen.getByTestId('session-state').textContent).toBe('connected');
  });

  it('does not force reconnect just because head polling has not produced a newer payload yet', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);
    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();
    ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });

    fireEvent.click(screen.getByText('switch-second'));

    expect(
      readSentMessages(ws2).some((item) => item.type === 'buffer-head-request'),
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

    await waitForMockSessionInstances(1);
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

    const sentMessages = readSentMessages(ws);
    const pasteMeta = sentMessages.find((item) => item.type === 'paste-image-start');

    expect(pasteMeta).toBeTruthy();
    expect(pasteMeta.payload).toMatchObject({
      name: 'proof.png',
      mimeType: 'image/png',
      byteLength: 4,
      pasteSequence: '\u0016',
    });
    expect(sentMessages.some((item) => item.type === 'binary')).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('streams remote screenshot chunks into preview payload and reports progress phases', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <SessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
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

    await waitForMockSessionInstances(1);
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

  it('shares one physical target socket across same-target sessions while keeping per-session mux channels', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);

    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();

    expect(MockWebSocket.physicalInstances).toHaveLength(1);
    expect(readSentMessages(ws1).some((item) => item.type === 'connect')).toBe(true);
    expect(readSentMessages(ws2).some((item) => item.type === 'connect')).toBe(true);
  });

  it('resubscribes an initially inactive mux channel over the existing target socket when it becomes active', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);

    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();

    await waitFor(() => {
      expect(screen.getByTestId('session-1-state').textContent).toBe('connected');
      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
    });

    expect(readSentMessages(ws2).some((item) =>
      item.type === 'body-subscription' && item.payload?.subscribed === false)).toBe(true);

    const sentBeforeSwitch = ws2.sent.length;
    fireEvent.click(screen.getByText('switch-second'));

    await waitFor(() => {
      expect(readSentMessages(ws2, sentBeforeSwitch).some((item) =>
        item.type === 'body-subscription' && item.payload?.subscribed === true)).toBe(true);
    });
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
  });

  it('keeps active mux channel render updates alive across repeated session switches', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);

    const session1 = MockWebSocket.instances[0]!;
    const session2 = MockWebSocket.instances[1]!;
    session1.triggerOpen();
    session2.triggerOpen();

    await waitFor(() => {
      expect(screen.getByTestId('session-1-state').textContent).toBe('connected');
      expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
    });

    const initialPhysicalCount = MockWebSocket.physicalInstances.length;
    const firstChannelId = session1.channelId || '';
    const secondChannelId = session2.channelId || '';

    for (let i = 1; i <= 4; i += 1) {
      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      session2.triggerBufferSync(100 + i, `second-active-${i}`, secondChannelId);
      await waitFor(() => expect(screen.getByTestId('session-2-revision').textContent).toBe(String(100 + i)));

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));
      session1.triggerBufferSync(200 + i, `first-active-${i}`, firstChannelId);
      await waitFor(() => expect(screen.getByTestId('session-1-revision').textContent).toBe(String(200 + i)));
    }

    expect(MockWebSocket.physicalInstances).toHaveLength(initialPhysicalCount);
    expect(readSentMessages(session1).filter((item) =>
      item.type === 'body-subscription' && item.payload?.subscribed === true).length).toBeGreaterThanOrEqual(4);
    expect(readSentMessages(session2).filter((item) =>
      item.type === 'body-subscription' && item.payload?.subscribed === true).length).toBeGreaterThanOrEqual(4);
  });

  it('manages tmux sessions over the existing mux target transport without opening another physical socket', async () => {
    function TmuxManagementHarness() {
      const {
        state,
        createSession,
        switchSession,
        manageTmuxSessionsOnOpenTransport,
      } = useSession();
      const [sessionsResult, setSessionsResult] = useState('pending');

      useEffect(() => {
        createSession(host, { sessionId: 'session-1' });
        switchSession('session-1');
      }, [createSession, switchSession]);

      return (
        <div>
          <div data-testid="tmux-active-session">{state.activeSessionId || 'missing'}</div>
          <div data-testid="tmux-management-result">{sessionsResult}</div>
          <button
            type="button"
            onClick={() => {
              void manageTmuxSessionsOnOpenTransport('session-1', { type: 'list-sessions' })
                .then((names) => {
                  setSessionsResult(names ? names.join(',') : 'no-open-target');
                })
                .catch((error) => {
                  setSessionsResult(error instanceof Error ? error.message : String(error));
                });
            }}
          >
            list-tmux
          </button>
        </div>
      );
    }

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <TmuxManagementHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    await waitFor(() => expect(screen.getByTestId('tmux-active-session').textContent).toBe('session-1'));
    const sentBefore = ws.sent.length;

    fireEvent.click(screen.getByText('list-tmux'));

    await waitFor(() => {
      const targetFrame = ws.sent
        .slice(sentBefore)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .find((item) => item.type === 'mux-target-message');
      expect(targetFrame).toEqual(expect.objectContaining({
        payload: expect.objectContaining({
          requestId: expect.any(String),
          message: { type: 'list-sessions' },
        }),
      }));
    });
    const targetFrame = ws.sent
      .slice(sentBefore)
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item))
      .find((item) => item.type === 'mux-target-message');
    const requestId = targetFrame.payload.requestId;
    ws.triggerMessage({
      type: 'mux-target-message',
      payload: {
        requestId,
        message: {
          type: 'sessions',
          payload: { sessions: ['zterm', 'alpha'] },
        },
      },
    });

    await waitFor(() => expect(screen.getByTestId('tmux-management-result').textContent).toBe('zterm,alpha'));
    expect(MockWebSocket.physicalInstances).toHaveLength(1);
  });

  it('reuses target-scoped mux semantics when reconnecting sessions on a shared target', async () => {
    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <MultiSessionHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(2);

    const ws1 = MockWebSocket.instances[0]!;
    const ws2 = MockWebSocket.instances[1]!;
    ws1.triggerOpen();
    ws2.triggerOpen();

    ws1.readyState = MockWebSocket.CLOSED;
    ws2.readyState = MockWebSocket.CLOSED;
    fireEvent.click(screen.getByText('reconnect-all'));

    await waitForMockPhysicalInstances(2);
    expect(MockWebSocket.physicalInstances).toHaveLength(2);
    const reconnectRoot = MockWebSocket.physicalInstances[1]!;
    reconnectRoot.triggerOpen();
    await waitFor(() => {
      expect(readMuxChannelOpenMessages(reconnectRoot)).toHaveLength(2);
    });
  });

  it('does not let shared target-socket traffic trigger reconnect for a sibling same-target session on reentry', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = new Date('2026-04-27T00:00:00.000Z').getTime();
    nowSpy.mockImplementation(() => now);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(2);

      const ws1 = MockWebSocket.instances[0]!;
      const ws2 = MockWebSocket.instances[1]!;
      ws1.triggerOpen();
      ws2.triggerOpen();
      ws1.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      ws2.triggerMessage({ type: 'connected', payload: { sessionId: 'session-2' } });
      await waitFor(() => expect(screen.getByTestId('session-2-state').textContent).toBe('connected'));

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      now = new Date('2026-04-27T00:00:40.000Z').getTime();
      ws1.triggerMessage({ type: 'pong' });

      fireEvent.click(screen.getByText('switch-second'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-2'));
      expect(readSentMessages(ws2).some((item) => item.type === 'buffer-head-request')).toBe(true);

      fireEvent.click(screen.getByText('switch-first'));
      await waitFor(() => expect(screen.getByTestId('active-session').textContent).toBe('session-1'));

      now = new Date('2026-04-27T00:00:45.000Z').getTime();
      fireEvent.click(screen.getByText('switch-second'));

      await waitFor(() => {
        expect(screen.getByTestId('active-session').textContent).toBe('session-2');
        expect(screen.getByTestId('session-2-state').textContent).toBe('connected');
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps two distinct client sessionIds as two managed sessions even when host identity overlaps', async () => {
    // Regression for the rcc<->rcc2 cross-display bug: two createSession calls
    // with overlapping host identity must NOT collapse onto one managed session
    // because they carry different client-owned sessionIds.
    function DuplicateSessionHarness() {
      const { state, createSession, switchSession } = useSession();

      useEffect(() => {
        createSession(host, { sessionId: 'session-1' });
        createSession({ ...host, id: 'host-dup' }, { sessionId: 'session-dup' });
        switchSession('session-1');
      }, [createSession, switchSession]);

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

    await waitFor(() => expect(screen.getByTestId('session-count').textContent).toBe('2'));
    expect(screen.getByTestId('active-session').textContent).toBe('session-1');
    expect(screen.getByTestId('session-ids').textContent).toBe('session-1|session-dup');
  });

  it('reuses a managed session when two createSession calls share the same client sessionId', async () => {
    function ReuseSessionHarness() {
      const { state, createSession } = useSession();

      useEffect(() => {
        createSession(host, { sessionId: 'session-shared' });
        createSession({ ...host, id: 'host-other' }, { sessionId: 'session-shared' });
      }, [createSession]);

      return (
        <div>
          <div data-testid="shared-session-count">{state.sessions.length}</div>
          <div data-testid="shared-session-ids">{state.sessions.map((session) => session.id).join('|')}</div>
        </div>
      );
    }

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <ReuseSessionHarness />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('shared-session-count').textContent).toBe('1'));
    expect(screen.getByTestId('shared-session-ids').textContent).toBe('session-shared');
  });

  it('reopens the mux channel after a plain websocket closed message instead of treating it as terminal session close', async () => {
    const statusListener = vi.fn();
    window.addEventListener('zterm:session-status', statusListener as EventListener);
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <SessionHarness />
        </SessionProvider>,
      );

      await waitForMockSessionInstances(1);
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
      const initialChannelOpenCount = readMuxChannelOpenMessages(ws).length;

      ws.triggerMessage({ type: 'closed', payload: { reason: 'tmux session closed' } });

      expect(statusListener).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(readMuxChannelOpenMessages(ws).length).toBeGreaterThan(initialChannelOpenCount);
      });
      expect(MockWebSocket.physicalInstances).toHaveLength(1);
      await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('connected'));
    } finally {
      window.removeEventListener('zterm:session-status', statusListener as EventListener);
    }
  });

  it('keeps public session action function references stable across websocket state and buffer updates', async () => {
    const snapshots: Array<{
      switchSession: unknown;
      setLiveSessionIds: unknown;
      sendInput: unknown;
      updateSessionViewport: unknown;
      resumeActiveSessionTransport: unknown;
      getSessionDebugMetrics: unknown;
      getSessionRenderBufferStore: unknown;
      requestScheduleList: unknown;
      sendMessageRaw: unknown;
      manageTmuxSessionsOnOpenTransport: unknown;
      onFileTransferMessage: unknown;
    }> = [];

    function ReferenceHarness() {
      const {
        state,
        createSession,
        switchSession,
        setLiveSessionIds,
        sendInput,
        updateSessionViewport,
        resumeActiveSessionTransport,
        getSessionDebugMetrics,
        getSessionRenderBufferStore,
        requestScheduleList,
        sendMessageRaw,
        manageTmuxSessionsOnOpenTransport,
        onFileTransferMessage,
      } = useSession();

      useEffect(() => {
        createSession(host, { sessionId: 'session-1' });
        switchSession('session-1');
      }, [createSession, switchSession]);

      useEffect(() => {
        snapshots.push({
          switchSession,
          setLiveSessionIds,
          sendInput,
          updateSessionViewport,
          resumeActiveSessionTransport,
          getSessionDebugMetrics,
          getSessionRenderBufferStore,
          requestScheduleList,
          sendMessageRaw,
          manageTmuxSessionsOnOpenTransport,
          onFileTransferMessage,
        });
      }, [
        state.sessions,
        state.activeSessionId,
        switchSession,
        setLiveSessionIds,
        sendInput,
        updateSessionViewport,
        resumeActiveSessionTransport,
        getSessionDebugMetrics,
        getSessionRenderBufferStore,
        requestScheduleList,
        sendMessageRaw,
        manageTmuxSessionsOnOpenTransport,
        onFileTransferMessage,
      ]);

      return <div data-testid="ref-active-session">{state.activeSessionId || 'missing'}</div>;
    }

    render(
      <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
        <ReferenceHarness />
      </SessionProvider>,
    );

    await waitForMockSessionInstances(1);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connected', payload: { sessionId: 'session-1' } });
    await waitFor(() => expect(screen.getByTestId('ref-active-session').textContent).toBe('session-1'));

    ws.triggerMessage({
      type: 'buffer-sync',
      payload: compactPayload({
        startIndex: 0,
        endIndex: 2,
        revision: 1,
        lines: [[0, 'hello'], [1, 'world']],
      }),
    });

    await waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(2));
    const first = snapshots[0]!;
    const last = snapshots[snapshots.length - 1]!;
    expect(last.switchSession).toBe(first.switchSession);
    expect(last.setLiveSessionIds).toBe(first.setLiveSessionIds);
    expect(last.sendInput).toBe(first.sendInput);
    expect(last.updateSessionViewport).toBe(first.updateSessionViewport);
    expect(last.resumeActiveSessionTransport).toBe(first.resumeActiveSessionTransport);
    expect(last.getSessionDebugMetrics).toBe(first.getSessionDebugMetrics);
    expect(last.getSessionRenderBufferStore).toBe(first.getSessionRenderBufferStore);
    expect(last.requestScheduleList).toBe(first.requestScheduleList);
    expect(last.sendMessageRaw).toBe(first.sendMessageRaw);
    expect(last.manageTmuxSessionsOnOpenTransport).toBe(first.manageTmuxSessionsOnOpenTransport);
    expect(last.onFileTransferMessage).toBe(first.onFileTransferMessage);
  });
});
