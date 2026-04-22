// @vitest-environment jsdom

import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './SessionContext';
import type { Host, ServerMessage, TerminalBufferPayload, TerminalIndexedLine } from '../lib/types';
import { cellsToLine } from '../lib/terminal-buffer';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
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

  static reset() {
    MockWebSocket.instances = [];
  }
}

function linesToPayload(lines: string[], viewportEndIndex: number, revision: number): TerminalBufferPayload {
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
    viewportEndIndex,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    lines: indexedLines,
  };
}

function indexedPayload(options: {
  startIndex: number;
  endIndex: number;
  viewportEndIndex: number;
  revision: number;
  lines: Array<[number, string]>;
}): TerminalBufferPayload {
  return {
    revision: options.revision,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    viewportEndIndex: options.viewportEndIndex,
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

function SessionHarness() {
  const { state, createSession, sendInput, reconnectSession } = useSession();

  useEffect(() => {
    createSession(host, { sessionId: 'session-1', activate: true });
  }, [createSession]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const renderedLines = activeSession?.buffer.lines.map(cellsToLine) || [];

  return (
    <div>
      <div data-testid="session-state">{activeSession?.state || 'missing'}</div>
      <div data-testid="session-revision">{activeSession?.buffer.revision ?? -1}</div>
      <div data-testid="session-lines">{renderedLines.join('|')}</div>
      <button type="button" onClick={() => sendInput('typed-from-client\r')}>
        send-input
      </button>
      <button type="button" onClick={() => reconnectSession('session-1')}>
        reconnect-session
      </button>
    </div>
  );
}

describe('SessionContext websocket dynamic refresh', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    MockWebSocket.reset();
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
      const sentTypes = ws.sent.map((item) => JSON.parse(item).type);
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

  it('sends user input upstream without locally mutating session buffer', async () => {
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

    fireEvent.click(screen.getByText('send-input'));

    const sentMessages = ws.sent.map((item) => JSON.parse(item));
    expect(sentMessages.some((item) => item.type === 'input' && item.payload === 'typed-from-client\r')).toBe(true);
    expect(screen.getByTestId('session-lines').textContent).not.toContain('typed-from-client');
    expect(screen.getByTestId('session-lines').textContent).toContain('stable-line-001');
  });

  it('ignores stale websocket buffer-sync revisions after a newer active snapshot already landed', async () => {
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

  it('rejects malformed partial websocket buffer-sync payloads instead of merging locally', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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
          [104, 'LINE-E'],
          [105, 'LINE-F'],
          [106, 'LINE-G'],
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-lines').textContent).toContain('line-a|line-b|line-c|line-d|line-e|line-f');
      expect(screen.getByTestId('session-revision').textContent).toBe('1');
      expect(errorSpy).toHaveBeenCalled();
    });

    errorSpy.mockRestore();
  });

  it('keeps latest mirror truth across reconnect and rejects stale post-reconnect snapshots', async () => {
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
});
