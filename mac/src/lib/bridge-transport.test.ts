// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridgeTransportController } from './bridge-transport';
import type { BridgeServerMessage, EditableHost } from '@zterm/shared';

const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason } as CloseEvent);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(message: BridgeServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

function makeHost(overrides: Partial<EditableHost> = {}): EditableHost {
  return {
    name: 'local-daemon',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'zterm_mirror_lab',
    authToken: '',
    authType: 'password',
    password: '',
    privateKey: '',
    autoCommand: '',
    ...overrides,
  };
}

function readSent(ws: MockWebSocket) {
  return ws.sent.map((item) => JSON.parse(item));
}

describe('Mac bridge transport connection', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
    MockWebSocket.reset();
  });

  it('opens daemon websocket, completes ticket handshake, and sends client requests on the live socket', () => {
    const controller = createBridgeTransportController();
    const serverMessages: BridgeServerMessage[] = [];

    controller.connect(makeHost(), {
      onServerMessage: (message) => serverMessages.push(message),
    });

    expect(controller.getState()).toMatchObject({
      status: 'connecting',
      connectedSessionId: '',
      activeTarget: {
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'zterm_mirror_lab',
      },
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    const sessionOpen = readSent(ws).at(-1);
    expect(sessionOpen).toMatchObject({
      type: 'session-open',
      payload: {
        sessionName: 'zterm_mirror_lab',
        cols: 80,
        rows: 24,
      },
    });
    expect(sessionOpen.payload.openRequestId).toBeTruthy();

    ws.triggerMessage({
      type: 'session-ticket',
      payload: {
        openRequestId: sessionOpen.payload.openRequestId,
        sessionTransportToken: 'ticket-1',
        sessionName: 'zterm_mirror_lab',
      },
    } as BridgeServerMessage);

    expect(readSent(ws).at(-1)).toMatchObject({
      type: 'connect',
      payload: {
        sessionName: 'zterm_mirror_lab',
        sessionTransportToken: 'ticket-1',
      },
    });

    ws.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'daemon-session-1' },
    } as BridgeServerMessage);

    expect(controller.getState()).toMatchObject({
      status: 'connected',
      connectedSessionId: 'daemon-session-1',
      error: '',
    });
    expect(readSent(ws).at(-1)).toMatchObject({
      type: 'schedule-list',
      payload: { sessionName: 'zterm_mirror_lab' },
    });

    controller.requestBufferHead();
    controller.requestBufferSync({
      knownRevision: 1,
      localStartIndex: 10,
      localEndIndex: 20,
      requestStartIndex: 10,
      requestEndIndex: 20,
    });
    controller.sendInput('printf client-ok\\r');

    const sent = readSent(ws);
    expect(sent.some((message) => message.type === 'buffer-head-request')).toBe(true);
    expect(sent.some((message) => message.type === 'buffer-sync-request'
      && message.payload.requestStartIndex === 10
      && message.payload.requestEndIndex === 20)).toBe(true);
    expect(sent.some((message) => message.type === 'input'
      && message.payload === 'printf client-ok\\r')).toBe(true);
    expect(serverMessages.map((message) => message.type)).toContain('connected');
  });

  it('does not report stale websocket messages after reconnect replaces the active socket', () => {
    const controller = createBridgeTransportController();
    controller.connect(makeHost({ name: 'first' }));
    const firstWs = MockWebSocket.instances[0]!;

    controller.connect(makeHost({ name: 'second' }));
    const secondWs = MockWebSocket.instances[1]!;
    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);

    firstWs.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'stale-session' },
    } as BridgeServerMessage);
    expect(controller.getState()).toMatchObject({
      status: 'connecting',
      connectedSessionId: '',
      activeTarget: { name: 'second' },
    });

    secondWs.triggerOpen();
    const sessionOpen = readSent(secondWs).at(-1);
    secondWs.triggerMessage({
      type: 'session-ticket',
      payload: {
        openRequestId: sessionOpen.payload.openRequestId,
        sessionTransportToken: 'ticket-2',
        sessionName: 'zterm_mirror_lab',
      },
    } as BridgeServerMessage);
    secondWs.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'fresh-session' },
    } as BridgeServerMessage);

    expect(controller.getState()).toMatchObject({
      status: 'connected',
      connectedSessionId: 'fresh-session',
      activeTarget: { name: 'second' },
    });
  });

  it('projects an unexpected live websocket close as explicit error for reconnect recovery', () => {
    const controller = createBridgeTransportController();
    controller.connect(makeHost());
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    const sessionOpen = readSent(ws).at(-1);
    ws.triggerMessage({
      type: 'session-ticket',
      payload: {
        openRequestId: sessionOpen.payload.openRequestId,
        sessionTransportToken: 'ticket-1',
        sessionName: 'zterm_mirror_lab',
      },
    } as BridgeServerMessage);
    ws.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'daemon-session-1' },
    } as BridgeServerMessage);

    ws.close(1006, 'daemon transport closed');

    expect(controller.getState()).toMatchObject({
      status: 'error',
      connectedSessionId: 'daemon-session-1',
      error: 'daemon transport closed',
    });
    expect(controller.getScheduleState()).toMatchObject({
      loading: false,
      error: 'daemon transport closed',
    });
  });

  it('does not close an open daemon websocket only because heartbeat pong is overdue', () => {
    const controller = createBridgeTransportController();
    const nowSpy = vi.spyOn(Date, 'now');
    let now = 1_000;
    nowSpy.mockImplementation(() => now);
    try {
      controller.connect(makeHost());
      const ws = MockWebSocket.instances[0]!;
      ws.triggerOpen();
      const sessionOpen = readSent(ws).at(-1);
      ws.triggerMessage({
        type: 'session-ticket',
        payload: {
          openRequestId: sessionOpen.payload.openRequestId,
          sessionTransportToken: 'ticket-1',
          sessionName: 'zterm_mirror_lab',
        },
      } as BridgeServerMessage);
      ws.triggerMessage({
        type: 'connected',
        payload: { sessionId: 'daemon-session-1' },
      } as BridgeServerMessage);

      ws.sent.length = 0;
      now += CLIENT_PONG_TIMEOUT_MS + 1;
      vi.advanceTimersByTime(CLIENT_PING_INTERVAL_MS);

      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      expect(readSent(ws)).toContainEqual({ type: 'ping' });
      expect(controller.getState()).toMatchObject({
        status: 'connected',
        connectedSessionId: 'daemon-session-1',
        error: '',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps manual disconnect as idle instead of reporting a transport error', () => {
    const controller = createBridgeTransportController();
    controller.connect(makeHost());
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    const sessionOpen = readSent(ws).at(-1);
    ws.triggerMessage({
      type: 'session-ticket',
      payload: {
        openRequestId: sessionOpen.payload.openRequestId,
        sessionTransportToken: 'ticket-1',
        sessionName: 'zterm_mirror_lab',
      },
    } as BridgeServerMessage);
    ws.triggerMessage({
      type: 'connected',
      payload: { sessionId: 'daemon-session-1' },
    } as BridgeServerMessage);

    controller.disconnect();

    expect(controller.getState()).toMatchObject({
      status: 'idle',
      connectedSessionId: '',
      error: '',
    });
  });
});
