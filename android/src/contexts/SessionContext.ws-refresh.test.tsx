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
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
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

const host2: Host = {
  ...host,
  id: 'host-2',
  name: 'local-test-2',
  sessionName: 'zterm_mirror_lab_2',
};

function SessionHarness() {
  const { state, createSession, sendInput, sendImagePaste, reconnectSession, reconnectAllSessions } = useSession();

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
      <button type="button" onClick={() => sendInput('session-1', 'typed-from-client\r')}>
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
      <button type="button" onClick={() => reconnectSession('session-1')}>
        reconnect-session
      </button>
      <button type="button" onClick={() => reconnectAllSessions()}>
        reconnect-all
      </button>
    </div>
  );
}

function MultiSessionHarness() {
  const { state, createSession, switchSession, reconnectAllSessions } = useSession();

  useEffect(() => {
    createSession(host, { sessionId: 'session-1', activate: true });
    createSession(host2, { sessionId: 'session-2', activate: false });
  }, [createSession]);

  return (
    <div>
      <div data-testid="active-session">{state.activeSessionId || 'missing'}</div>
      <div data-testid="session-1-revision">
        {state.sessions.find((session) => session.id === 'session-1')?.buffer.revision ?? -1}
      </div>
      <div data-testid="session-2-revision">
        {state.sessions.find((session) => session.id === 'session-2')?.buffer.revision ?? -1}
      </div>
      <button type="button" onClick={() => switchSession('session-2')}>
        switch-second
      </button>
      <button type="button" onClick={() => reconnectAllSessions()}>
        reconnect-all
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

  it('does not re-send stream-mode or follow buffer requests on every incoming buffer-sync frame', async () => {
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
    expect(sentTypes).not.toContain('stream-mode');
    expect(sentTypes).not.toContain('buffer-sync-request');
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

    const sentCountBeforeInput = ws.sent.length;

    fireEvent.click(screen.getByText('send-input'));

    const sentMessages = ws.sent
      .slice(sentCountBeforeInput)
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item));
    expect(sentMessages.some((item) => item.type === 'input' && item.payload === 'typed-from-client\r')).toBe(true);
    expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(false);
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

    await waitFor(() => {
      const sentMessages = ws2.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item));
      expect(sentMessages.some((item) => item.type === 'buffer-sync-request')).toBe(true);
      const tailBootstrapRequest = [...sentMessages].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(tailBootstrapRequest?.payload).toMatchObject({
        mode: 'follow',
        knownRevision: 0,
        localStartIndex: 0,
        localEndIndex: 0,
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

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(3));
    const reconnectWs1 = MockWebSocket.instances[2]!;
    reconnectWs1.triggerOpen();

    await waitFor(() => {
      const connectMessage = reconnectWs1.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item))
        .find((item) => item.type === 'connect');
      expect(connectMessage?.payload?.sessionName).toBe('zterm_mirror_lab_2');
    });
  });

  it('requests a delta-aware follow sync when switching to a connected tab with a continuous local tail', async () => {
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
      const sent1 = ws1.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      const sent2 = ws2.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
      expect(sent1.some((item) => item.type === 'stream-mode' && item.payload?.mode === 'idle')).toBe(true);
      expect(sent2.some((item) => item.type === 'stream-mode' && item.payload?.mode === 'active')).toBe(true);
      expect(sent2.some((item) => item.type === 'buffer-sync-request')).toBe(true);
      const lastRequest = [...sent2].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(lastRequest?.payload).toMatchObject({
        mode: 'follow',
        knownRevision: 6,
        localStartIndex: 0,
        localEndIndex: 3,
      });
      expect(screen.getByTestId('active-session').textContent).toBe('session-2');
    });
  });

  it('still bootstraps when switching to a connected tab without a local tail window', async () => {
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
      const lastRequest = [...sent2].reverse().find((item) => item.type === 'buffer-sync-request');
      expect(lastRequest?.payload).toMatchObject({
        mode: 'follow',
        knownRevision: 0,
        localStartIndex: 0,
        localEndIndex: 0,
      });
    });
  });

  it('reconnects the newly activated tab when refresh request gets neither buffer-sync nor pong', async () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionProvider wsUrl="ws://127.0.0.1:3333/ws">
          <MultiSessionHarness />
        </SessionProvider>,
      );

      expect(MockWebSocket.instances).toHaveLength(2);
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
          .some((item) => item.type === 'ping'),
      ).toBe(true);

      vi.advanceTimersByTime(450);

      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
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
});
