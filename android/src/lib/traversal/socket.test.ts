import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraversalSocket } from './socket';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  binaryType: BinaryType = 'blob';
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  triggerClose(code = 1006, reason = 'mock closed') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

const target = {
  bridgeHost: '203.0.113.10',
  bridgePort: 3333,
  authToken: 'token',
  ipv6Host: '240e:1234::10',
  ipv4Host: '203.0.113.10',
  transportMode: 'websocket' as const,
};

const settings = {
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'websocket' as const,
};

async function flushMicrotasks() {
  await Promise.resolve();
}

describe('TraversalSocket reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects quickly after an opened traversal backend closes', async () => {
    const socket = new TraversalSocket(target, settings);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, 'relay transport closed');

    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'relay transport closed',
    });
  });

  it('does not reconnect after the client closes the traversal socket', async () => {
    const socket = new TraversalSocket(target, settings);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    socket.close(1000, 'client close');

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('backs off repeated reconnect attempts and resets candidate order from the first path', async () => {
    const socket = new TraversalSocket(target, settings);
    await flushMicrotasks();

    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, 'first close');

    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('240e:1234::10');

    MockWebSocket.instances[1].triggerOpen();
    MockWebSocket.instances[1].triggerClose(1006, 'second close');
    await vi.advanceTimersByTimeAsync(299);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(3);
    expect(MockWebSocket.instances[2].url).toContain('240e:1234::10');
    const attempts = socket.getDiagnostics().attempts;
    expect(attempts[attempts.length - 1]).toMatchObject({
      stage: 'connecting',
      path: 'ipv6',
    });
  });
});
