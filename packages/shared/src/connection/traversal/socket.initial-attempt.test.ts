import { describe, expect, it, vi } from 'vitest';
import { TraversalSocket, classifyInitialFailure } from './socket';
import { buildTraversalPlanCached, clearTraversalPlanCache } from './config';
import { TraversalRouteHealthCache } from './route-health-cache';
import type {
  AttemptFailure,
  InitialAttemptEvent,
  InitialAttemptPort,
  TraversalIceCandidateInit,
  TraversalIceCandidateLike,
  TraversalPeerConnectionIceEventLike,
  TraversalPeerConnectionLike,
  TraversalPlatform,
  TraversalRtcConfiguration,
  TraversalSessionDescriptionInit,
  TraversalSessionDescriptionLike,
  TraversalSettingsSource,
  TraversalStatsReport,
  TraversalStatsRecord,
  TraversalTargetSource,
  TraversalTimerHandle,
  TraversalTimerPort,
  TraversalWebSocketLike,
} from './types';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class ManualTimers implements TraversalTimerPort {
  private nextId = 1;

  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: TraversalTimerHandle) {
    this.tasks.delete(Number(handle));
  }

  pendingDelays() {
    return [...this.tasks.values()].map((task) => task.delayMs);
  }

  runDelay(delayMs: number) {
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.delayMs === delayMs)
      .sort(([left], [right]) => left - right);
    for (const [id, task] of due) {
      if (!this.tasks.delete(id)) {
        continue;
      }
      task.callback();
    }
  }
}

class ControlledWebSocket implements TraversalWebSocketLike {
  static instances: ControlledWebSocket[] = [];

  readyState = CONNECTING;

  binaryType?: string;

  bufferedAmount = 0;

  onopen: ((event?: unknown) => void) | null = null;

  onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null;

  onerror: ((event?: unknown) => void) | null = null;

  onfailure: ((failure: AttemptFailure) => void) | null = null;

  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  readonly sent: Array<string | ArrayBuffer> = [];

  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly url: string) {
    ControlledWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (this.readyState !== OPEN) {
      throw new Error('controlled websocket is not open');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === CLOSED) {
      return;
    }
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  triggerOpen() {
    this.readyState = OPEN;
    this.onopen?.();
  }

  triggerMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data });
  }

  triggerFailure(failure: AttemptFailure) {
    this.onfailure?.(failure);
  }

  triggerError(event?: unknown) {
    this.onerror?.(event);
  }

  triggerClose(code?: number, reason?: string) {
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  static reset() {
    ControlledWebSocket.instances = [];
    ControlledPeerConnection.instances = [];
  }
}

class ControlledDataChannel {
  readyState = 'connecting';

  binaryType?: string;

  bufferedAmount = 0;

  onopen: (() => void) | null = null;

  onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null;

  onerror: (() => void) | null = null;

  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  readonly sent: Array<string | ArrayBuffer> = [];

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 'closed';
    this.onclose?.({ code, reason });
  }
}

class ControlledPeerConnection implements TraversalPeerConnectionLike {
  static instances: ControlledPeerConnection[] = [];

  private statsReport: TraversalStatsReport = {
    forEach: () => {},
  };

  readonly remoteDescription: unknown = null;

  connectionState: TraversalPeerConnectionLike['connectionState'] = 'new';

  onicecandidate: ((event: TraversalPeerConnectionIceEventLike) => void) | null = null;

  onconnectionstatechange: (() => void) | null = null;

  readonly channel = new ControlledDataChannel();

  constructor() {
    ControlledPeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.channel;
  }

  async createOffer(): Promise<TraversalSessionDescriptionInit> {
    return { type: 'offer', sdp: 'test-offer' };
  }

  async setLocalDescription(_description: TraversalSessionDescriptionInit) {}

  async setRemoteDescription(_description: TraversalSessionDescriptionInit) {}

  async addIceCandidate(_candidate: TraversalIceCandidateLike) {}

  async getStats(): Promise<TraversalStatsReport> {
    return this.statsReport;
  }

  setSelectedIcePair(
    localCandidateType: string,
    remoteCandidateType: string,
    currentRoundTripTime: number,
  ) {
    const localCandidate: TraversalStatsRecord = {
      id: 'local-candidate',
      type: 'local-candidate',
      candidateType: localCandidateType,
    };
    const remoteCandidate: TraversalStatsRecord = {
      id: 'remote-candidate',
      type: 'remote-candidate',
      candidateType: remoteCandidateType,
    };
    const selectedPair: TraversalStatsRecord = {
      id: 'selected-pair',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: localCandidate.id,
      remoteCandidateId: remoteCandidate.id,
      currentRoundTripTime,
    };
    const reports = [selectedPair, localCandidate, remoteCandidate];
    this.statsReport = {
      forEach: (callback) => {
        for (const report of reports) {
          callback(report);
        }
      },
      get: (id) => reports.find((report) => report.id === id),
    };
  }

  close() {}

  triggerConnectionState(state: TraversalPeerConnectionLike['connectionState']) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  static reset() {
    ControlledPeerConnection.instances = [];
  }
}

function createPlatform(timers: ManualTimers): TraversalPlatform {
  return {
    createWebSocket: (url) => new ControlledWebSocket(url),
    createPeerConnection: (_config: TraversalRtcConfiguration) => new ControlledPeerConnection(),
    createSessionDescription: (init: TraversalSessionDescriptionInit) =>
      init as TraversalSessionDescriptionLike,
    createIceCandidate: (init: TraversalIceCandidateInit) =>
      init as TraversalIceCandidateLike,
    timers,
  };
}

function createPort() {
  const events: InitialAttemptEvent[] = [];
  const port: InitialAttemptPort = {
    onEvent(event) {
      events.push(event);
    },
  };
  return { events, port };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

const wsTarget: TraversalTargetSource = {
  bridgeHost: '203.0.113.10',
  bridgePort: 3333,
  authToken: 'daemon-token',
  ipv6Host: '2001:db8::10',
  ipv4Host: '203.0.113.10',
  transportMode: 'websocket',
};

const wsSettings: TraversalSettingsSource = {
  transportMode: 'websocket',
};

function rtcSettings(clientInstanceId: string): TraversalSettingsSource {
  return {
    signalUrl: 'ws://signal.example.test/client',
    transportMode: 'webrtc',
    traversalRelay: {
      relayBaseUrl: 'https://relay.example.test/',
      accessToken: 'relay-account-token',
      userId: 'user-a',
      username: 'tester',
      deviceId: clientInstanceId,
      deviceName: 'CLI',
      platform: 'node',
      wsDevicesUrl: 'wss://relay.example.test/devices',
      wsHostUrl: 'wss://relay.example.test/host',
      wsClientUrl: 'wss://signal.example.test/client?region=us-west',
      turnUrl: 'turn:turn.example.test:3478?transport=udp',
      turnUsername: 'turn-user',
      turnCredential: 'turn-secret',
      updatedAt: 1,
    },
  };
}

const rtcTarget: TraversalTargetSource = {
  bridgeHost: '',
  bridgePort: 3333,
  signalUrl: 'ws://signal.example.test/client',
  relayHostId: 'daemon-a',
  transportMode: 'webrtc',
};

function boundInitialSocket(port: InitialAttemptPort, timers: ManualTimers) {
  return new TraversalSocket(wsTarget, wsSettings, {
    platform: createPlatform(timers),
    candidateScope: 'bound-initial',
    initialAttemptPort: port,
    routeHealthCache: new TraversalRouteHealthCache(),
    autoReconnect: false,
    requireOpenConfirmation: true,
  });
}

function boundInitialRtcSocket(
  settings: TraversalSettingsSource,
  port: InitialAttemptPort,
  timers: ManualTimers,
) {
  return new TraversalSocket(rtcTarget, settings, {
    platform: createPlatform(timers),
    candidateScope: 'bound-initial',
    initialAttemptPort: port,
    routeHealthCache: new TraversalRouteHealthCache(),
    autoReconnect: false,
    requireOpenConfirmation: true,
  });
}

function beginIds(events: InitialAttemptEvent[]) {
  return events
    .filter((event): event is Extract<InitialAttemptEvent, { type: 'begin' }> => event.type === 'begin')
    .map((event) => event.attemptId);
}

function withoutSignalDeviceId(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete('deviceId');
  return parsed.toString();
}

describe('classifyInitialFailure', () => {
  it.each([
    [{ stage: 'connect', kind: 'system', code: 'ECONNREFUSED' }, 'advance', undefined],
    [{ stage: 'connect', kind: 'timeout', timer: 'connect' }, 'advance', undefined],
    [{ stage: 'mux', kind: 'timeout', timer: 'confirmation' }, 'advance', undefined],
    [{ stage: 'mux', kind: 'timeout', timer: 'hello' }, 'advance', undefined],
    [{ stage: 'rtc', kind: 'rtc-state', state: 'failed' }, 'advance', undefined],
    [{ stage: 'rtc', kind: 'rtc-state', state: 'disconnected-expired' }, 'advance', undefined],
    [{ stage: 'connect', kind: 'ws-close', code: 1006 }, 'advance', undefined],
    [{ stage: 'connect', kind: 'http', status: 401 }, 'terminate', 'auth'],
    [{ stage: 'connect', kind: 'http', status: 403 }, 'terminate', 'auth'],
    [{ stage: 'connect', kind: 'ws-close', code: 4001 }, 'terminate', 'auth'],
    [{ stage: 'mux', kind: 'protocol', code: 'invalid-json' }, 'terminate', 'protocol'],
    [{ stage: 'connect', kind: 'ws-close', code: 1002 }, 'terminate', 'protocol'],
    [{ stage: 'mux', kind: 'binding', expectedDaemonHostId: 'a', actualDaemonHostId: 'b' }, 'terminate', 'binding'],
    [{ stage: 'connect', kind: 'http', status: 500 }, 'terminate', 'service'],
    [{ stage: 'rtc', kind: 'rtc-rejection', messageType: 'rtc-error' }, 'terminate', 'service'],
    [{ stage: 'mux', kind: 'mux-rejection' }, 'terminate', 'service'],
    [{ stage: 'connect', kind: 'http' }, 'terminate', 'unknown'],
    [{ stage: 'connect', kind: 'system', code: 'CERT_HAS_EXPIRED' }, 'terminate', 'unknown'],
    [{ stage: 'connect', kind: 'ws-close', code: 1000, reason: '401 unauthorized' }, 'terminate', 'unknown'],
    [{ stage: 'connect', kind: 'unknown', cause: { message: '401 forbidden' } }, 'terminate', 'unknown'],
  ] satisfies Array<[AttemptFailure, 'advance' | 'terminate', ('auth' | 'protocol' | 'binding' | 'service' | 'unknown')? ]>)(
    'classifies %j as %s %s',
    (failure, action, category) => {
      const decision = classifyInitialFailure(failure);
      expect(decision.action).toBe(action);
      expect(decision.failure).toBe(failure);
      if (decision.action === 'terminate') {
        expect(decision.category).toBe(category);
      }
    },
  );
});

describe('bound-initial attempt executor', () => {
  it('isolates RTC signaling identities per client instance and monotonic attempt', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const firstSettings = rtcSettings('client-instance-a');
    const secondSettings = rtcSettings('client-instance-b');
    const first = boundInitialRtcSocket(firstSettings, createPort().port, new ManualTimers());
    const second = boundInitialRtcSocket(secondSettings, createPort().port, new ManualTimers());
    await flushMicrotasks();

    const originalPlan = buildTraversalPlanCached(
      rtcTarget,
      firstSettings,
      undefined,
      'bound-initial',
    );
    const originalCandidate = originalPlan.candidates.find((candidate) => candidate.kind === 'rtc');
    if (!originalCandidate || originalCandidate.kind !== 'rtc') {
      throw new Error('expected the bound-initial plan to contain an RTC candidate');
    }
    const originalUrl = originalCandidate.signalUrl;

    const [firstSignal, secondSignal] = ControlledWebSocket.instances;
    const firstAttemptUrl = new URL(firstSignal.url);
    const secondAttemptUrl = new URL(secondSignal.url);
    expect(firstAttemptUrl.searchParams.get('deviceId')).toBe('cli:client-instance-a:attempt:1');
    expect(secondAttemptUrl.searchParams.get('deviceId')).toBe('cli:client-instance-b:attempt:1');
    expect(firstAttemptUrl.searchParams.get('deviceId')).not.toBe(
      secondAttemptUrl.searchParams.get('deviceId'),
    );

    expect(withoutSignalDeviceId(firstSignal.url)).toBe(withoutSignalDeviceId(originalUrl));
    expect(firstAttemptUrl.searchParams.get('token')).toBe('relay-account-token');
    expect(firstAttemptUrl.searchParams.get('hostId')).toBe('daemon-a');
    expect(buildTraversalPlanCached(
      rtcTarget,
      firstSettings,
      undefined,
      'bound-initial',
    ).candidates.find((candidate) => candidate.kind === 'rtc')?.signalUrl).toBe(originalUrl);

    firstSignal.triggerFailure({
      stage: 'connect',
      kind: 'system',
      code: 'ECONNREFUSED',
    });
    await flushMicrotasks();

    const laterAttemptUrl = new URL(ControlledWebSocket.instances[2].url);
    expect(laterAttemptUrl.searchParams.get('deviceId')).toBe('cli:client-instance-a:attempt:2');
    expect(withoutSignalDeviceId(laterAttemptUrl.toString())).toBe(withoutSignalDeviceId(originalUrl));

    second.close();
    first.close();
  });

  it('retains the selected ICE pair emitted before RTC attempt promotion', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = new TraversalSocket({
      bridgeHost: '',
      bridgePort: 3333,
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      relayHostId: 'daemon-a',
      transportMode: 'webrtc',
    }, {
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      transportMode: 'webrtc',
    }, {
      platform: createPlatform(timers),
      candidateScope: 'bound-initial',
      initialAttemptPort: port,
      routeHealthCache: new TraversalRouteHealthCache(),
      autoReconnect: false,
      requireOpenConfirmation: true,
    });
    await flushMicrotasks();

    const signaling = ControlledWebSocket.instances[0];
    signaling.triggerOpen();
    await flushMicrotasks();
    const peerConnection = ControlledPeerConnection.instances[0]!;
    peerConnection.setSelectedIcePair('host', 'host', 0.012);
    peerConnection.channel.readyState = 'open';
    peerConnection.channel.onopen?.();
    timers.runDelay(1000);
    await flushMicrotasks();

    const currentId = beginIds(events)[0];
    expect(socket.getDiagnostics().selectedIcePair).toEqual({
      local: {
        id: 'local-candidate',
        candidateType: 'host',
        address: undefined,
        port: undefined,
        protocol: undefined,
        networkType: undefined,
        relayProtocol: undefined,
        url: undefined,
      },
      remote: {
        id: 'remote-candidate',
        candidateType: 'host',
        address: undefined,
        port: undefined,
        protocol: undefined,
        networkType: undefined,
        relayProtocol: undefined,
        url: undefined,
      },
      roundTripTimeMs: 12,
    });
    expect(socket.confirmAttempt(currentId!)).toBe(true);
    socket.close();
  });

  it('applies runner-up route diagnostics only after it becomes current', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    const [first, second] = ControlledWebSocket.instances;
    first.triggerOpen();
    await flushMicrotasks();
    const firstId = beginIds(events)[0]!;
    const firstPath = socket.getDiagnostics().resolvedPath;
    expect(firstPath).toBeDefined();

    second.triggerOpen();
    await flushMicrotasks();
    expect(socket.getDiagnostics().resolvedPath).toBe(firstPath);

    expect(socket.failAttempt(firstId, {
      stage: 'mux',
      kind: 'timeout',
      timer: 'hello',
    })).toBe(true);
    await flushMicrotasks();

    const secondId = beginIds(events)[1]!;
    expect(secondId).not.toBe(firstId);
    expect(socket.getDiagnostics().resolvedPath).toBeDefined();
    expect(socket.getDiagnostics().resolvedPath).not.toBe(firstPath);
    expect(socket.confirmAttempt(secondId)).toBe(true);
    socket.close();
  });

  it('hands A to B once and isolates A stale frames and timers', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);

    await flushMicrotasks();
    expect(ControlledWebSocket.instances).toHaveLength(2);
    const [first, second] = ControlledWebSocket.instances;

    first.triggerOpen();
    await flushMicrotasks();
    const firstId = beginIds(events)[0];
    expect(firstId).toBeTypeOf('number');
    expect(timers.pendingDelays()).toContain(5000);

    second.triggerOpen();
    await flushMicrotasks();
    expect(beginIds(events)).toEqual([firstId]);

    const firstFailure: AttemptFailure = { stage: 'mux', kind: 'timeout', timer: 'hello' };
    expect(socket.failAttempt(firstId, firstFailure)).toBe(true);
    await flushMicrotasks();

    const secondId = beginIds(events)[1];
    expect(secondId).toBeTypeOf('number');
    expect(secondId).not.toBe(firstId);
    expect(events).toContainEqual({
      type: 'invalidated',
      attemptId: firstId,
      reason: 'failure',
      failure: firstFailure,
    });
    expect(first.readyState).toBe(CLOSED);
    expect(second.readyState).toBe(OPEN);
    expect(socket.sendForAttempt(firstId, 'stale-before-ready')).toBe(false);
    expect(socket.sendForAttempt(secondId, 'fresh-b-hello')).toBe(true);
    expect(second.sent).toEqual(['fresh-b-hello']);

    first.triggerMessage('stale-a');
    second.triggerMessage('fresh-b');
    first.triggerFailure({ stage: 'connect', kind: 'unknown', cause: new Error('late A') });
    await flushMicrotasks();

    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', attemptId: secondId, data: 'fresh-b' },
    ]);
    expect(socket.failAttempt(firstId, firstFailure)).toBe(false);
    expect(socket.sendForAttempt(firstId, 'stale-send')).toBe(false);
    expect(socket.confirmAttempt(firstId)).toBe(false);

    expect(socket.confirmAttempt(secondId)).toBe(true);
    expect(socket.confirmAttempt(secondId)).toBe(false);
    expect(socket.sendForAttempt(secondId, 'late-provisional-send')).toBe(false);
    expect(beginIds(events)).toEqual([firstId, secondId]);
    expect(timers.pendingDelays()).not.toContain(5000);

    second.triggerMessage('after-confirm');
    expect(events.filter((event) => event.type === 'message')).toContainEqual({
      type: 'message',
      attemptId: secondId,
      data: 'after-confirm',
    });

    second.triggerClose(1006, 'post-ready network close');
    await flushMicrotasks();
    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(events.filter((event) => event.type === 'terminal')).toEqual([{
      type: 'terminal',
      attemptId: secondId,
      failure: expect.objectContaining({
        stage: 'connect',
        kind: 'ws-close',
        code: 1006,
        reason: 'post-ready network close',
      }),
    }]);
    socket.close();
  });

  it('expires a runner-up connect timer without closing the current attempt', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    const [first, second] = ControlledWebSocket.instances;
    second.triggerOpen();
    await flushMicrotasks();
    const currentId = beginIds(events)[0];
    expect(currentId).toBe(2);

    timers.runDelay(1800);
    await flushMicrotasks();

    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(0);
    expect(beginIds(events)).toEqual([currentId]);
    expect(first.readyState).toBe(CLOSED);
    expect(second.readyState).toBe(OPEN);
    expect(socket.confirmAttempt(currentId)).toBe(true);
    second.triggerMessage('post-confirm');
    expect(events).toContainEqual({
      type: 'message',
      attemptId: currentId,
      data: 'post-confirm',
    });
    socket.close();
  });

  it('promotes an opened fallback when the provisional confirmation timer expires', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    ControlledWebSocket.instances[0].triggerOpen();
    ControlledWebSocket.instances[1].triggerOpen();
    await flushMicrotasks();
    const [firstId] = beginIds(events);

    timers.runDelay(5000);
    await flushMicrotasks();

    const secondId = beginIds(events)[1];
    expect(secondId).not.toBe(firstId);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invalidated',
      attemptId: firstId,
      reason: 'failure',
      failure: expect.objectContaining({
        kind: 'timeout',
        timer: 'confirmation',
      }),
    }));
    expect(socket.confirmAttempt(secondId)).toBe(true);
    socket.close();
  });

  it('terminal rejection from a still-valid runner-up closes the transaction', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    const [first, second] = ControlledWebSocket.instances;
    first.triggerOpen();
    second.triggerOpen();
    await flushMicrotasks();
    const firstId = beginIds(events)[0];
    const rejection: AttemptFailure = { stage: 'connect', kind: 'http', status: 401 };

    second.triggerFailure(rejection);
    await flushMicrotasks();

    expect(events).toContainEqual({
      type: 'invalidated',
      attemptId: firstId,
      reason: 'failure',
    });
    expect(events.filter((event) => event.type === 'terminal')).toEqual([{
      type: 'terminal',
      attemptId: 2,
      failure: rejection,
    }]);
    expect(beginIds(events)).toEqual([firstId]);
    expect(first.readyState).toBe(CLOSED);
    expect(second.readyState).toBe(CLOSED);
    expect(socket.confirmAttempt(firstId)).toBe(false);
    socket.close();
  });

  it('advances a network failure but terminates an unknown failure with its cause', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    const [first, second] = ControlledWebSocket.instances;
    first.triggerOpen();
    await flushMicrotasks();
    expect(beginIds(events)).toEqual([1]);
    const networkFailure: AttemptFailure = {
      stage: 'connect',
      kind: 'system',
      code: 'ECONNREFUSED',
    };
    first.triggerFailure(networkFailure);
    first.triggerClose(1006, 'close after typed network failure');
    await flushMicrotasks();
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'invalidated',
      attemptId: 1,
      reason: 'failure',
      failure: networkFailure,
    });

    second.triggerOpen();
    await flushMicrotasks();
    const secondId = beginIds(events)[1];
    expect(secondId).toBe(2);
    expect(socket.confirmAttempt(secondId)).toBe(true);
    socket.close();

    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const nextTimers = new ManualTimers();
    const next = createPort();
    const unknownSocket = boundInitialSocket(next.port, nextTimers);
    await flushMicrotasks();
    const cause = new Error('unlisted transport failure');
    ControlledWebSocket.instances[0].triggerFailure({
      stage: 'connect',
      kind: 'unknown',
      cause,
    });
    await flushMicrotasks();

    expect(next.events.filter((event) => event.type === 'terminal')).toEqual([{
      type: 'terminal',
      attemptId: 1,
      failure: {
        stage: 'connect',
        kind: 'unknown',
        cause,
      },
    }]);
    expect(ControlledWebSocket.instances[1].readyState).toBe(CLOSED);
    unknownSocket.close();
  });

  it('keeps the original RTC failure when cleanup emits stale close facts', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = new TraversalSocket({
      bridgeHost: '',
      bridgePort: 3333,
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      relayHostId: 'daemon-a',
      transportMode: 'webrtc',
    }, {
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      transportMode: 'webrtc',
    }, {
      platform: createPlatform(timers),
      candidateScope: 'bound-initial',
      initialAttemptPort: port,
      routeHealthCache: new TraversalRouteHealthCache(),
      autoReconnect: false,
      requireOpenConfirmation: true,
    });
    await flushMicrotasks();

    const signaling = ControlledWebSocket.instances[0];
    signaling.triggerOpen();
    await flushMicrotasks();
    const peerConnection = ControlledPeerConnection.instances[0]!;
    expect(peerConnection).toBeDefined();
    const peerChannel = peerConnection.channel;
    peerChannel.readyState = 'open';
    peerChannel.onopen?.();
    timers.runDelay(1000);
    await flushMicrotasks();

    expect(beginIds(events)).toEqual([1]);
    peerConnection.triggerConnectionState('disconnected');
    timers.runDelay(10000);
    await flushMicrotasks();

    expect(events.filter((event) => event.type === 'terminal')).toEqual([{
      type: 'terminal',
      attemptId: 1,
      failure: {
        stage: 'rtc',
        kind: 'rtc-state',
        state: 'disconnected-expired',
      },
    }]);
    expect(beginIds(events)).toEqual([1]);
    socket.close();
  });

  it('does not promote after cancellation from the invalidated callback', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const events: InitialAttemptEvent[] = [];
    let socket: TraversalSocket;
    const port: InitialAttemptPort = {
      onEvent(event) {
        events.push(event);
        if (event.type === 'invalidated') {
          socket.close();
        }
      },
    };
    socket = boundInitialSocket(port, timers);
    await flushMicrotasks();

    const [first, second] = ControlledWebSocket.instances;
    first.triggerOpen();
    second.triggerOpen();
    await flushMicrotasks();
    const firstId = beginIds(events)[0];

    socket.failAttempt(firstId, { stage: 'mux', kind: 'timeout', timer: 'hello' });
    await flushMicrotasks();

    expect(beginIds(events)).toEqual([firstId]);
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(0);
    expect(first.readyState).toBe(CLOSED);
    expect(second.readyState).toBe(CLOSED);
  });

  it('classifies RTC control rejection without fabricating a service code', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const { events, port } = createPort();
    const socket = new TraversalSocket({
      bridgeHost: '',
      bridgePort: 3333,
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      relayHostId: 'daemon-a',
      transportMode: 'webrtc',
    }, {
      signalUrl: 'ws://signal.example.test?deviceId=rtc-test-client',
      transportMode: 'webrtc',
    }, {
      platform: createPlatform(timers),
      candidateScope: 'bound-initial',
      initialAttemptPort: port,
      routeHealthCache: new TraversalRouteHealthCache(),
      autoReconnect: false,
      requireOpenConfirmation: true,
    });
    await flushMicrotasks();

    const signaling = ControlledWebSocket.instances[0];
    signaling.triggerOpen();
    await flushMicrotasks();
    const rejected = {
      type: 'rtc-error',
      payload: { message: 'explicit relay rejection' },
    };
    signaling.triggerMessage(JSON.stringify(rejected));
    await flushMicrotasks();

    const terminal = events.find((event) => event.type === 'terminal');
    expect(terminal).toEqual({
      type: 'terminal',
      attemptId: 1,
      failure: {
        stage: 'signal',
        kind: 'rtc-rejection',
        messageType: 'rtc-error',
        cause: rejected,
      },
    });
    expect(terminal?.type === 'terminal' ? terminal.failure : null).not.toHaveProperty('code');
    expect(signaling.closeCalls.every((call) => call.code !== 4004)).toBe(true);
    socket.close();
  });

  it('keeps the mode-default legacy callbacks and candidate behavior unchanged', async () => {
    clearTraversalPlanCache();
    ControlledWebSocket.reset();
    const timers = new ManualTimers();
    const platform = createPlatform(timers);
    const socket = new TraversalSocket({
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      authToken: 'daemon-token',
      transportMode: 'websocket',
    }, wsSettings, {
      platform,
      overrideUrl: 'ws://legacy.example.test',
      requireOpenConfirmation: true,
    });
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onclose = onclose;
    await flushMicrotasks();

    const legacy = ControlledWebSocket.instances[0];
    legacy.triggerOpen();
    legacy.triggerMessage('legacy-message');
    socket.confirmTransportReady();
    legacy.triggerClose(1006, 'legacy-close');

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith({ data: 'legacy-message' });
    expect(onclose).toHaveBeenCalledWith({ code: 1006, reason: 'legacy-close' });
    socket.close();
  });
});
