import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraversalSocket } from './socket';
import { clearTraversalPlanCache } from './config';
import { defaultTraversalRouteHealthCache, TraversalRouteHealthCache } from './route-health-cache';

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

  triggerOpen() {
    this.readyState = 'open';
    this.onopen?.();
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

type MockRtcStatsCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  static statsCandidates: {
    local: {
      candidateType: MockRtcStatsCandidateType;
      address?: string;
      port?: number;
      protocol?: string;
      networkType?: string;
      relayProtocol?: string;
      url?: string;
    };
    remote: {
      candidateType: MockRtcStatsCandidateType;
      address?: string;
      port?: number;
      protocol?: string;
      networkType?: string;
      relayProtocol?: string;
      url?: string;
    };
    currentRoundTripTime?: number;
  } | null = null;
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
    if (!MockRTCPeerConnection.statsCandidates) {
      return new Map();
    }
    return new Map<string, Record<string, unknown>>([
      ['pair-1', {
        id: 'pair-1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
        currentRoundTripTime: MockRTCPeerConnection.statsCandidates.currentRoundTripTime,
      }],
      ['local-1', {
        id: 'local-1',
        type: 'local-candidate',
        ...MockRTCPeerConnection.statsCandidates.local,
      }],
      ['remote-1', {
        id: 'remote-1',
        type: 'remote-candidate',
        ...MockRTCPeerConnection.statsCandidates.remote,
      }],
    ]);
  }

  close() {
    this.connectionState = 'closed';
    this.channel.close();
  }

  static reset() {
    MockRTCPeerConnection.instances = [];
    MockRTCPeerConnection.statsCandidates = null;
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

function createRelayRtcSocket() {
  return new TraversalSocket(
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
}

describe('TraversalSocket reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    clearTraversalPlanCache();
    defaultTraversalRouteHealthCache.clear();
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

  it('opens Tailscale before non-LAN IPv4 when no relay account settings are present', async () => {
    new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: {
        accountId: 'logged-out',
        daemonHostId: 'daemon-1',
      },
    });
    await flushMicrotasks();

    // ws candidates race in parallel; the Tailscale candidate is one of them.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(MockWebSocket.instances.some((ws) => ws.url.includes('100.66.1.82'))).toBe(true);
  });

  it('reconnects quickly after an opened traversal backend closes', async () => {
    const socket = createSocket({}, { autoReconnect: true });
    await flushMicrotasks();

    // ws candidates race: both are attempted in the first batch.
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, 'relay transport closed');

    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Reconnect batch: ipv6 is quarantined (failure) so only ipv4 is selectable.
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'relay transport closed',
    });
  });

  it('does not reconnect after the client closes the traversal socket', async () => {
    const socket = createSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[0].triggerOpen();
    socket.close(1000, 'client close');

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('does not send rtc-close on normal relay RTC socket close so relay can keep the client peer lease idle', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();

    socket.close(1000, 'client close');

    expect(MockWebSocket.instances[0].sent.map((item) => JSON.parse(String(item)).type)).not.toContain('rtc-close');
  });

  it('disposes an RTC candidate that is still connecting when the traversal socket closes', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].connectionState).toBe('new');

    socket.close(4000, 'client network generation changed');

    expect(MockRTCPeerConnection.instances[0].connectionState).toBe('closed');
    expect(MockRTCPeerConnection.instances[0].channel.readyState).toBe('closed');
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('retries after all traversal candidates are exhausted before open', async () => {
    const socket = createSocket({
      traversalPathPriority: ['ipv4'],
    });
    await flushMicrotasks();

    // Both ws candidates race in the same batch.
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[0].triggerClose(1006, 'candidate failed before open');

    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: 'candidate failed before open',
    });

    // The batch is not exhausted: the other ws candidate keeps trying.
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
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

    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[0].triggerClose(1006, 'candidate failed before open');

    // The batch is not exhausted yet: the other ws candidate is still trying.
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

  it('backs off repeated reconnect attempts and skips the just-failed open route first', async () => {
    const socket = createSocket({}, { autoReconnect: true });
    await flushMicrotasks();

    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, 'first close');

    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    // Reconnect batch: ipv6 is quarantined (failure) so only ipv4 is selectable.
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(MockWebSocket.instances[2].url).toContain('203.0.113.10');

    MockWebSocket.instances[2].triggerOpen();
    MockWebSocket.instances[2].triggerClose(1006, 'second close');
    await vi.advanceTimersByTimeAsync(299);
    expect(MockWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Backoff restarts after a successful open: 300ms -> next reconnect batch
    // races the fallback pool (both candidates are now quarantined).
    expect(MockWebSocket.instances).toHaveLength(5);
    const attempts = socket.getDiagnostics().attempts;
    expect(attempts[attempts.length - 1]).toMatchObject({
      stage: 'connecting',
    });
  });

  it('records an opened route close as route failure so the next socket can choose the healthier path', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    const scope = {
      accountId: 'user-1',
      daemonHostId: 'daemon-1',
    };
    const firstSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: scope,
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, 'heartbeat server activity timeout');

    expect(routeHealthCache.get(scope, {
      id: 'direct:ipv6:240e:1234::10:3333',
      path: 'ipv6',
      endpoint: '240e:1234::10:3333',
    })).toMatchObject({
      status: 'failure',
      error: 'heartbeat server activity timeout',
    });

    const secondSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: scope,
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[1].url).toContain('203.0.113.10');
    firstSocket.close(1000, 'test cleanup');
    secondSocket.close(1000, 'test cleanup');
  });

  it('records an explicit heartbeat route failure before client close so the next socket avoids the stale path', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    const scope = {
      accountId: 'user-1',
      daemonHostId: 'daemon-1',
    };
    const firstSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: scope,
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');
    MockWebSocket.instances[0].triggerOpen();
    firstSocket.reportFailure('heartbeat server activity timeout');
    firstSocket.close(4000, 'heartbeat server activity timeout');

    expect(routeHealthCache.get(scope, {
      id: 'direct:ipv6:240e:1234::10:3333',
      path: 'ipv6',
      endpoint: '240e:1234::10:3333',
    })).toMatchObject({
      status: 'failure',
      error: 'heartbeat server activity timeout',
    });

    const secondSocket = createSocket({}, {
      routeHealthCache,
      routeHealthScope: scope,
    });
    await flushMicrotasks();

    expect(MockWebSocket.instances[1].url).toContain('203.0.113.10');
    secondSocket.close(1000, 'test cleanup');
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

  it('uses WebRTC direct first with ICE all and no TURN credentials', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].config).toMatchObject({
      iceTransportPolicy: 'all',
      iceServers: [{ urls: 'stun:relay.example.test:3478' }],
    });
    expect(JSON.stringify(MockRTCPeerConnection.instances[0].config)).not.toContain('turn-secret');
    const sentMessages = MockWebSocket.instances[0].sent.map((item) => JSON.parse(String(item)));
    expect(sentMessages.map((item) => item.type)).toEqual([
      'rtc-init',
      'rtc-offer',
    ]);
    expect(sentMessages[0]).toMatchObject({
      type: 'rtc-init',
      payload: {
        iceTransportPolicy: 'all',
      },
    });

    socket.close();
  });

  it('uses TURN-only ICE only after WebRTC direct fails', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    const directSignalSocket = MockWebSocket.instances[0];
    directSignalSocket.triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].config).toMatchObject({
      iceTransportPolicy: 'all',
    });

    directSignalSocket.onmessage?.({
      data: JSON.stringify({
        type: 'rtc-error',
        payload: { message: 'direct ICE failed' },
      }),
    } as MessageEvent);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
    const relaySignalSocket = MockWebSocket.instances[1];
    relaySignalSocket.triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockRTCPeerConnection.instances).toHaveLength(2);
    expect(MockRTCPeerConnection.instances[1].config).toMatchObject({
      iceTransportPolicy: 'relay',
      iceServers: [{
        urls: 'turn:relay.example.test:3478?transport=udp',
        username: 'turn-user',
        credential: 'turn-secret',
      }],
    });

    socket.close();
  });

  it('disposes the failed rtc-direct generation before Auto starts TURN', async () => {
    const socket = createRelayRtcSocket();
    const onopen = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onclose = onclose;
    await flushMicrotasks();

    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();

    expect(onopen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    MockRTCPeerConnection.instances[0].channel.close();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onclose).not.toHaveBeenCalled();
    expect(MockRTCPeerConnection.instances[0].connectionState).toBe('closed');
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket.getDiagnostics().attempts[0]).toMatchObject({
      path: 'rtc-direct',
      stage: 'closed',
      ok: false,
      reason: 'rtc data channel closed',
    });

    MockWebSocket.instances[1].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[1].channel.triggerOpen();
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'rtc-relay',
      resolvedEndpoint: 'relay:daemon-host-a',
    });

    socket.close();
  });

  it('keeps rtc-direct long enough for P2P before falling through to the next route', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
    const signalSocket = MockWebSocket.instances[0];
    signalSocket.triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'connecting',
      reason: expect.stringContaining('connect timeout'),
    });

    socket.close();
  });

  it('allows rtc-direct to publish open after the data channel opens near the candidate deadline', async () => {
    const socket = createRelayRtcSocket();
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(4999);
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();
    expect(socket.readyState).toBe(WebSocket.CONNECTING);

    await vi.advanceTimersByTimeAsync(999);
    expect(onopen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'rtc-direct',
    });

    socket.close();
  });

  it('closes a failed rtc signaling attempt and does not send later ICE candidates to a closed socket', async () => {
    const socket = createRelayRtcSocket();
    await flushMicrotasks();

    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    const signalSocket = MockWebSocket.instances[0];
    expect(signalSocket.sent.map((item) => JSON.parse(String(item)).type)).toEqual([
      'rtc-init',
      'rtc-offer',
    ]);

    signalSocket.onmessage?.({
      data: JSON.stringify({
        type: 'rtc-error',
        payload: { message: 'host daemon-host-a is offline' },
      }),
    } as MessageEvent);
    await flushMicrotasks();

    expect(signalSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(MockRTCPeerConnection.instances[0].connectionState).toBe('closed');
    const sentCountAfterError = signalSocket.sent.length;
    MockRTCPeerConnection.instances[0].onicecandidate?.({
      candidate: {
        toJSON: () => ({ candidate: 'candidate:relay-after-close typ relay' }),
      },
    } as RTCPeerConnectionIceEvent);

    expect(signalSocket.sent).toHaveLength(sentCountAfterError);
    expect(socket.getDiagnostics().attempts[0]).toMatchObject({
      path: 'rtc-direct',
      stage: 'closed',
      ok: false,
      reason: 'host daemon-host-a is offline',
    });
  });

  it('marks TURN relay diagnostics only after the direct RTC candidate fails', async () => {
    MockRTCPeerConnection.statsCandidates = {
      local: {
        candidateType: 'relay',
        address: '159.75.134.56',
        port: 49152,
        protocol: 'udp',
        relayProtocol: 'udp',
      },
      remote: {
        candidateType: 'srflx',
        address: '120.229.11.244',
        port: 52000,
        protocol: 'udp',
      },
      currentRoundTripTime: 0.091,
    };
    const socket = createRelayRtcSocket();
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    const directSignalSocket = MockWebSocket.instances[0];
    directSignalSocket.triggerOpen();
    await flushMicrotasks();
    directSignalSocket.onmessage?.({
      data: JSON.stringify({
        type: 'rtc-error',
        payload: { message: 'direct ICE failed' },
      }),
    } as MessageEvent);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].triggerOpen();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[1].channel.triggerOpen();
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'rtc-relay',
      resolvedRelayTransport: 'turn',
      resolvedEndpoint: 'relay:daemon-host-a',
      selectedIcePair: {
        local: {
          candidateType: 'relay',
          address: '159.75.134.56',
          port: 49152,
          protocol: 'udp',
          relayProtocol: 'udp',
        },
        remote: {
          candidateType: 'srflx',
          address: '120.229.11.244',
          port: 52000,
          protocol: 'udp',
        },
        roundTripTimeMs: 91,
      },
    });

    socket.close();
  });

  it('marks WebRTC direct diagnostics as direct when the selected ICE candidate pair is direct', async () => {
    MockRTCPeerConnection.statsCandidates = {
      local: {
        candidateType: 'host',
        address: '192.168.0.28',
        port: 42300,
        protocol: 'udp',
        networkType: 'wifi',
      },
      remote: {
        candidateType: 'host',
        address: '192.168.0.6',
        port: 53551,
        protocol: 'udp',
        networkType: 'wifi',
      },
      currentRoundTripTime: 0.012,
    };
    const socket = createRelayRtcSocket();
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'rtc-direct',
      resolvedRelayTransport: 'direct',
      resolvedEndpoint: 'rtc-direct:daemon-host-a',
      selectedIcePair: {
        local: {
          candidateType: 'host',
          address: '192.168.0.28',
          port: 42300,
          protocol: 'udp',
          networkType: 'wifi',
        },
        remote: {
          candidateType: 'host',
          address: '192.168.0.6',
          port: 53551,
          protocol: 'udp',
          networkType: 'wifi',
        },
        roundTripTimeMs: 12,
      },
    });

    socket.close();
  });

  it('keeps an opened WebRTC transport alive through transient ICE disconnected state', async () => {
    const socket = createRelayRtcSocket();
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    MockRTCPeerConnection.instances[0].connectionState = 'disconnected';
    MockRTCPeerConnection.instances[0].onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(onclose).not.toHaveBeenCalled();
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'rtc-direct',
    });

    MockRTCPeerConnection.instances[0].connectionState = 'connected';
    MockRTCPeerConnection.instances[0].onconnectionstatechange?.();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);

    expect(onclose).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    socket.close();
  });

  it('closes an opened WebRTC transport when ICE disconnected does not recover within the grace window', async () => {
    const socket = createRelayRtcSocket();
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    MockRTCPeerConnection.instances[0].channel.triggerOpen();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    MockRTCPeerConnection.instances[0].connectionState = 'disconnected';
    MockRTCPeerConnection.instances[0].onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(onclose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'rtc peer disconnected',
    });
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'error',
      reason: 'rtc peer disconnected',
    });
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

    // Every candidate is quarantined: the fallback pool probes all of them in
    // parallel (both ws candidates race in the same batch).
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0].url).toContain('240e:1234::10');

    MockWebSocket.instances[0].triggerOpen();
    expect(socket.getDiagnostics()).toMatchObject({
      stage: 'open',
      resolvedPath: 'ipv6',
      resolvedEndpoint: '240e:1234::10:3333',
    });
  });

  it('starts ws candidates in parallel and settles on the fastest open, closing superseded ones', async () => {
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: { accountId: 'logged-out', daemonHostId: 'daemon-1' },
    });
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    // ws candidates race instead of running serially.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    // The second instance opens first and wins; the first is closed as superseded.
    MockWebSocket.instances[1].triggerOpen();
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics().stage).toBe('open');
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);

    socket.close();
  });

  it('settles exactly one winner when two candidates open in the same tick', async () => {
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: { accountId: 'logged-out', daemonHostId: 'daemon-1' },
    });
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    // Both candidates open back-to-back in the same synchronous tick.
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[1].triggerOpen();
    await flushMicrotasks();

    // Only the first is the winner; the second must not re-fire onopen.
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics().stage).toBe('open');
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    const openAttempts = socket.getDiagnostics().attempts.filter((item) => item.stage === 'open');
    expect(openAttempts).toHaveLength(1);

    socket.close();
  });

  it('does not pollute health or records when a superseded candidate errors late', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    const scope = { accountId: 'logged-out', daemonHostId: 'daemon-1' };
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache,
      routeHealthScope: scope,
    });
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    // The first candidate opens and wins; the other is closed as superseded.
    MockWebSocket.instances[0].triggerOpen();
    await flushMicrotasks();
    expect(onopen).toHaveBeenCalledTimes(1);

    // The superseded candidate errors afterwards: it must not be recorded as a
    // failure (it was never the active attempt) nor overwrite its skipped mark.
    MockWebSocket.instances[1].triggerError();
    await flushMicrotasks();

    const supersededAttempt = socket.getDiagnostics().attempts.find((item) => item.stage === 'skipped');
    expect(supersededAttempt).toBeDefined();
    expect(supersededAttempt?.reason).toBe('superseded by faster candidate');
    expect(socket.getDiagnostics().stage).toBe('open');
    expect(socket.readyState).toBe(MockWebSocket.OPEN);

    socket.close();
  });

  it('contracts the rtc-direct candidate timeout while a recent failure is quarantined', async () => {
    const routeHealthCache = new TraversalRouteHealthCache();
    const scope = { accountId: 'user-1', daemonHostId: 'daemon-host-a' };
    const relayTarget = {
      bridgeHost: '',
      bridgePort: 3333,
      authToken: 'token',
      relayHostId: 'daemon-host-a',
      transportMode: 'webrtc' as const,
      relayEndpointCandidates: [{
        id: 'relay-rtc:daemon-host-a',
        kind: 'relay-rtc' as const,
        relayHostId: 'daemon-host-a',
        authRequired: true,
        lastSeenAt: '2026-07-16T00:00:00.000Z',
      }],
    };
    const relaySettings = {
      signalUrl: '',
      turnServerUrl: '',
      turnUsername: '',
      turnCredential: '',
      transportMode: 'webrtc' as const,
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
    };
    const directCandidate = {
      id: 'rtc-direct:daemon-host-a',
      kind: 'rtc' as const,
      path: 'rtc-direct' as const,
      endpoint: 'rtc-direct:daemon-host-a',
      signalUrl: 'wss://relay.example.test/relay/ws/client?token=relay-access&hostId=daemon-host-a&deviceId=android-1',
      iceServers: [] as RTCIceServer[],
      iceTransportPolicy: 'all' as const,
    };
    const relayCandidate = {
      id: 'relay-rtc:daemon-host-a',
      kind: 'rtc' as const,
      path: 'rtc-relay' as const,
      endpoint: 'relay:daemon-host-a',
      signalUrl: 'wss://relay.example.test/relay/ws/client?token=relay-access&hostId=daemon-host-a&deviceId=android-1',
      iceServers: [{
        urls: 'turn:relay.example.test:3478?transport=udp',
        username: 'turn-user',
        credential: 'turn-secret',
      }],
      iceTransportPolicy: 'relay' as const,
    };

    // Both rtc candidates are quarantined as failures: the selection falls back
    // to the full pool, and the quarantined direct candidate gets a contracted
    // 3000ms budget (instead of 6000ms) before the whole plan is exhausted.
    routeHealthCache.recordFailure(scope, directCandidate, 'timeout');
    routeHealthCache.recordFailure(scope, relayCandidate, 'timeout');

    const socket = new TraversalSocket(relayTarget, relaySettings, { routeHealthCache });
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    // relay (2500ms budget) times out, then the contracted direct budget
    // (3000ms) expires -> total 5500ms -> finishFailure -> onclose.
    await vi.advanceTimersByTimeAsync(5500);
    await flushMicrotasks();

    expect(onclose).toHaveBeenCalledTimes(1);

    socket.close();
  });
});

describe('tailscale candidate dynamic verification', () => {
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
  });

  it('keeps a connecting tailscale candidate alive through the generic websocket deadline', async () => {
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: { accountId: 'logged-out', daemonHostId: 'daemon-1' },
    });
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    // A Tailscale IP is not admitted from cached health. The real authenticated
    // candidate attempt remains the dynamic reachability check.
    await vi.advanceTimersByTimeAsync(900);
    await flushMicrotasks();
    expect(socket.getDiagnostics().attempts.some((item) => item.path === 'tailscale' && item.stage === 'error')).toBe(false);
    // The generic WebSocket deadline has not elapsed yet.
    expect(socket.getDiagnostics().attempts.some((item) => item.path === 'ipv4' && item.stage === 'error')).toBe(false);

    socket.close();
  });

  it('accepts a healthy tailscale candidate after 900ms and before the generic deadline', async () => {
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: { accountId: 'logged-out', daemonHostId: 'daemon-1' },
    });
    const onopen = vi.fn();
    socket.onopen = onopen;
    await flushMicrotasks();

    const tailscaleWs = MockWebSocket.instances.find((ws) => ws.url.includes('100.66.1.82'));
    expect(tailscaleWs).toBeDefined();
    await vi.advanceTimersByTimeAsync(901);
    await flushMicrotasks();
    expect(socket.getDiagnostics().attempts.some((item) => item.path === 'tailscale' && item.stage === 'error')).toBe(false);
    tailscaleWs?.triggerOpen();
    await flushMicrotasks();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(socket.getDiagnostics().stage).toBe('open');
    socket.close();
  });

  it('fails an unreachable tailscale candidate at the generic websocket deadline', async () => {
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'token',
      tailscaleHost: '100.66.1.82',
      ipv4Host: '203.0.113.10',
      transportMode: 'websocket',
    }, settings, {
      routeHealthCache: new TraversalRouteHealthCache(),
      routeHealthScope: { accountId: 'logged-out', daemonHostId: 'daemon-1' },
    });
    const onclose = vi.fn();
    socket.onclose = onclose;
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1800);
    await flushMicrotasks();

    expect(socket.getDiagnostics().attempts.filter((item) => item.stage === 'error')).toHaveLength(2);
    expect(socket.getDiagnostics().attempts.some((item) => item.path === 'tailscale' && item.stage === 'error')).toBe(true);
    expect(onclose).toHaveBeenCalledTimes(1);
    socket.close();
  });
});
