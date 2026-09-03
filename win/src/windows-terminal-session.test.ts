import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBufferSyncToSessionBuffer, createSessionBufferState } from '@zterm/shared';
import {
  canRequestWindowsVisibleRange,
  createWindowsSessionControl,
  projectWindowsTerminalBuffer,
  type WindowsTerminalSnapshot,
} from './windows-terminal-session';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  sessions(sessions: string[]) {
    this.onmessage?.({ data: JSON.stringify({ type: 'sessions', payload: { sessions } }) });
  }

  error(message: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'error', payload: { message } }) });
  }

  static latest() {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!socket) throw new Error('no mock websocket');
    return socket;
  }
}

describe('windows session control owner', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists, creates, and closes sessions through the daemon control protocol', async () => {
    const control = createWindowsSessionControl();
    const target = { bridgeHost: '127.0.0.1', bridgePort: 3333, authToken: 'token-a' };

    const listPromise = control.refresh(target);
    const listSocket = MockWebSocket.latest();
    expect(listSocket.url).toBe('ws://127.0.0.1:3333/?token=token-a');
    listSocket.open();
    expect(listSocket.sent).toEqual([JSON.stringify({ type: 'list-sessions' })]);
    listSocket.sessions(['default', 'alpha']);
    await expect(listPromise).resolves.toEqual(['alpha', 'default']);
    expect(control.getSnapshot().sessions).toEqual(['alpha', 'default']);

    const createPromise = control.create(target, 'logs');
    const createSocket = MockWebSocket.latest();
    createSocket.open();
    expect(createSocket.sent).toEqual([JSON.stringify({ type: 'tmux-create-session', payload: { sessionName: 'logs' } })]);
    createSocket.sessions(['logs', 'default']);
    await expect(createPromise).resolves.toEqual(['default', 'logs']);

    const closePromise = control.close(target, 'logs');
    const closeSocket = MockWebSocket.latest();
    closeSocket.open();
    expect(closeSocket.sent).toEqual([JSON.stringify({ type: 'tmux-kill-session', payload: { sessionName: 'logs' } })]);
    closeSocket.sessions(['default']);
    await expect(closePromise).resolves.toEqual(['default']);
  });

  it('surfaces daemon control errors explicitly', async () => {
    const control = createWindowsSessionControl();
    const promise = control.refresh({ bridgeHost: '127.0.0.1', bridgePort: 3333 });
    const socket = MockWebSocket.latest();
    socket.open();
    socket.error('cannot list sessions');

    await expect(promise).rejects.toThrow('cannot list sessions');
    expect(control.getSnapshot()).toMatchObject({ status: 'error', error: 'cannot list sessions' });
  });
});

describe('windows terminal session shared buffer binding', () => {
  it('projects shared sparse-buffer truth without copying renderer semantics', () => {
    const initial = createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: 3000 });
    const next = applyBufferSyncToSessionBuffer(initial, {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      availableStartIndex: 0,
      availableEndIndex: 1,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      lines: [{ i: 0, t: 'WINDOWS_SHARED_BUFFER_OK' }],
    }, 3000);

    const projection = projectWindowsTerminalBuffer(next);
    expect(projection.revision).toBe(1);
    expect(String.fromCodePoint(...projection.lines[0]!.filter((cell) => cell.width !== 0).map((cell) => cell.char))).toContain('WINDOWS_SHARED_BUFFER_OK');
    expect(projection.startIndex).toBe(0);
    expect(projection.endIndex).toBe(1);
  });
});

describe('windows terminal visible range request gate', () => {
  it('waits for the first mirror buffer before requesting a visible range', () => {
    const emptyBuffer = createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: 3000 });
    const connecting: WindowsTerminalSnapshot = { status: 'connecting', error: '', sessionId: '', buffer: emptyBuffer };
    const connectedBeforeMirror: WindowsTerminalSnapshot = { status: 'connected', error: '', sessionId: 's1', buffer: emptyBuffer };
    const connectedAfterMirror: WindowsTerminalSnapshot = {
      status: 'connected',
      error: '',
      sessionId: 's1',
      buffer: { ...emptyBuffer, revision: 1 },
    };

    expect(canRequestWindowsVisibleRange(connecting)).toBe(false);
    expect(canRequestWindowsVisibleRange(connectedBeforeMirror)).toBe(false);
    expect(canRequestWindowsVisibleRange(connectedAfterMirror)).toBe(true);
  });
});
