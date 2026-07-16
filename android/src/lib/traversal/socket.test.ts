import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraversalSocket } from './socket';
import { TraversalRouteHealthCache } from './route-health-cache';

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

  triggerError() {
    this.onerror?.();
  }

  triggerClose(code = 1006, reason = 'mock closed') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

class MockRTCDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  readonly channel = new MockRTCDataChannel();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';

  constructor(public readonly config: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'mock-offer' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  async addIceCandidate() {
    return undefined;
  }

  async getStats() {
    return new Map();
  }

  close() {
    this.connectionState = 'closed';
    this.channel.close();
  }

  static reset() {
    MockRTCPeerConnection.instances = [];
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

function createSocket(
  customSettings: Partial<typeof settings> & { traversalPathPriority?: string[] } = {},
  options?: {
    routeHealthCache?: TraversalRouteHealthCache;
    routeHealthScope?: { accountId?: string; daemonHostId?: string };
    autoReconnect?: boolean;
  },
) {
  return new TraversalSocket(target, {
    ...settings,
    ...customSettings,
  } as typeof settings, {
    routeHealthCache: options?.routeHealthCache || new TraversalRouteHealthCache(),
    routeHealthScope: options?.routeHealthScope || {
      accountId: 'user-1',
      daemonHostId: 'daemon-1',
    },
    autoReconnect: options?.autoReconnect,
  });
}

describe('TraversalSocket reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    MockRTCPeerConnection.reset();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
    vi.stubGlobal('RTCSessionDescription', class {
      constructor(public readonly init: RTCSessionDescriptionInit) {}
    });
    vi.stubGlobal('RTCIceCandidate', class {
      constructor(public readonly init: RTCIceCandidateInit) {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects quickly after an opened traversal backend closes', async () => {
    const socket = createSocket({}, { autoReconnect: true });
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
    const socket = createSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    socket.close(1000, 'client close');

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('retries after all traversal candidates are exhausted before open', async () => {
    const socket = createSocket({
      traversalPathPriority: ['ipv4'],
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerClose(1006, 'candidate failed before open');

    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'candidate failed before open',
    });

    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'candidate failed before open',
    });
  });

  it('does not self-reconnect when an outer session runtime owns reconnect scheduling', async () => {
    const socket = createSocket({
      traversalPathPriority: ['ipv4'],
    }, {
      autoReconnect: false,
    });
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerClose(1006, 'candidate failed before open');

    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].triggerClose(1006, 'candidate failed before open');

    expect(onclose).toHaveBeenCalledWith({ code: 1006, reason: 'candidate failed before open' });
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'error',
      reason: 'candidate failed before open',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('backs off repeated reconnect attempts and resets candidate order from the first path', async () => {
    const socket = createSocket({}, { autoReconnect: true });
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

  it('records successful route health with RTT and candidate id', async () => {
    vi.setSystemTime(1_000);
    const routeHealthCache = new TraversalRouteHealthCache({ now: () => Date.now() });
    const socket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(42);
    MockWebSocket.instances[0].triggerOpen();

    const diagnostics = socket.getDiagnostics();
    expect(diagnostics).toMatchObject({
      stage: 'open',
      resolvedPath: 'ipv6',
      resolvedEndpoint: '240e:1234::10:3333',
    });
    expect(diagnostics.attempts[0]).toMatchObject({
      candidateId: 'direct:ipv6:240e:1234::10:3333',
      path: 'ipv6',
      stage: 'open',
      ok: true,
      rttMs: 42,
    });
    expect(routeHealthCache.get(
      { accountId: 'user-1', daemonHostId: 'daemon-1' },
      {
        id: 'direct:ipv6:240e:1234::10:3333',
        path: 'ipv6',
        endpoint: '240e:1234::10:3333',
      },
    )).toMatchObject({
      candidateId: 'direct:ipv6:240e:1234::10:3333',
      path: 'ipv6',
      status: 'success',
      rttMs: 42,
    });
  });

  it('uses standard ICE for relay control-plane RTC candidates and keeps TURN relay-only as a diagnostic concern', async () => {
    const socket = new TraversalSocket(
      {
        bridgeHost: '',
        bridgePort: 3333,
        authToken: 'token',
        relayHostId: 'daemon-host-a',
        transportMode: 'webrtc',
        relayEndpointCandidates: [{
          id: 'relay-rtc:daemon-host-a',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-a',
          authRequired: true,
          lastSeenAt: '2026-07-16T00:00:00.000Z',
        }],
      },
      {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'webrtc',
        traversalRelay: {
          relayBaseUrl: 'https://relay.example.test/relay/',
          accessToken: 'relay-access',
          userId: 'user-1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.test/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.test/relay/ws/host',
          wsClientUrl: 'wss://relay.example.test/relay/ws/client',
          turnUrl: 'turn:relay.example.test:3478?transport=udp',
          turnUsername: 'turn-user',
          turnCredential: 'turn-secret',
          updatedAt: 1,
        },
      },
      { routeHealthCache: new TraversalRouteHealthCache() },
    );
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].config).toMatchObject({
      iceTransportPolicy: 'all',
      iceServers: [{
        urls: 'turn:relay.example.test:3478?transport=udp',
        username: 'turn-user',
        credential: 'turn-secret',
      }],
    });
    expect(MockWebSocket.instances[0].sent.map((item) => JSON.parse(String(item)).type)).toEqual([
      'rtc-init',
      'rtc-offer',
    ]);

    socket.close();
  });

  it('skips a freshly auth-failed direct candidate and opens the next candidate', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    const socket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerClose(1008, '401 unauthorized');
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('203.0.113.10');
    MockWebSocket.instances[1].triggerOpen();

    const diagnostics = socket.getDiagnostics();
    expect(diagnostics).toMatchObject({
      stage: 'open',
      resolvedPath: 'ipv4',
      resolvedEndpoint: '203.0.113.10:3333',
    });
    expect(diagnostics.attempts.map((item) => ({
      path: item.path,
      stage: item.stage,
      ok: item.ok,
      reason: item.reason,
    }))).toEqual([
      {
        path: 'ipv6',
        stage: 'closed',
        ok: false,
        reason: '401 unauthorized',
      },
      {
        path: 'ipv4',
        stage: 'open',
        ok: true,
        reason: undefined,
      },
    ]);
  });

  it('allows a failed direct route to win again after health TTL expiry', async () => {
    let currentTime = 1_000;
    const routeHealthCache = new TraversalRouteHealthCache({
      ttlMs: 50,
      now: () => currentTime,
    });

    const firstSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();
    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerClose(1008, '401 unauthorized');
    await flushMicrotasks();
    expect(MockWebSocket.instances[1].url).toContain('203.0.113.10');
    MockWebSocket.instances[1].triggerOpen();
    firstSocket.close(1000, 'test close');

    const secondSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();
    expect(MockWebSocket.instances[2].url).toContain('203.0.113.10');
    secondSocket.close(1000, 'test close');

    currentTime = 1_051;
    const thirdSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[3].url).toContain('240e:1234::10');
    thirdSocket.close(1000, 'test close');
  });

  it('still probes a route when every candidate is currently unhealthy', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    routeHealthCache.recordFailure(
      { accountId: 'user-1', daemonHostId: 'daemon-1' },
      {
        id: 'direct:ipv6:240e:1234::10:3333',
        kind: 'ws',
        path: 'ipv6',
        endpoint: '240e:1234::10:3333',
        url: 'ws://240e:1234::10:3333',
      },
      'timeout',
    );
    routeHealthCache.recordFailure(
      { accountId: 'user-1', daemonHostId: 'daemon-1' },
      {
        id: 'direct:ipv4:203.0.113.10:3333',
        kind: 'ws',
        path: 'ipv4',
        endpoint: '203.0.113.10:3333',
        url: 'ws://203.0.113.10:3333',
      },
      'timeout',
    );

    const socket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: {
        accountId: 'user-1',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');

    MockWebSocket.instances[0].triggerOpen();
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'ipv6',
      resolvedEndpoint: '240e:1234::10:3333',
    });
  });
});
