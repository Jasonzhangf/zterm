import wrtc from '@roamhq/wrtc';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedAccount } from './account-client.js';
import {
  SessionConnection,
  buildSessionConnectionRouteContext,
  type SessionConnectionEvent,
  type SessionConnectionFrame,
  type SessionConnectionTimerPort,
  type SessionConnectionTraversalFactory,
  type SessionConnectionTraversalSocket,
} from './connection.js';
import { createNodeTraversalFactory } from './node-platform.js';
import type { RelayAccountDirectory } from '../../shared/src/connection/relay-directory.js';
import type {
  TerminalMuxClientFrame,
  TerminalMuxServerFrame,
} from '../../shared/src/connection/protocol.js';
import type {
  AttemptFailure,
  AttemptId,
  InitialAttemptEvent,
  InitialAttemptPort,
  TraversalDiagnostics,
  TraversalRtcIceTransportPolicy,
  TraversalSettingsSource,
} from '../../shared/src/connection/traversal/types.js';

interface FixtureSocket {
  send(data: string): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  terminate(): void;
}

interface FixtureSocketServer {
  once(event: 'listening', listener: () => void): void;
  on(
    event: 'connection',
    listener: (socket: FixtureSocket, request: { url?: string }) => void,
  ): void;
  address(): { port: number } | string | null;
  close(callback: () => void): void;
}

interface FixtureWebSocket {
  send(data: string): void;
}

const require = createRequire(import.meta.url);
const wsModule = require('ws') as {
  WebSocket: new (url: string) => FixtureWebSocket;
  WebSocketServer: new (options: { host: string; port: number }) => FixtureSocketServer;
};

interface Fixture {
  url: string;
  frames: SessionConnectionFrame[];
  close(): Promise<void>;
}

async function createFixture(
  onFrame: (
    frame: SessionConnectionFrame,
    socket: FixtureSocket,
    requestUrl: string,
  ) => void,
): Promise<Fixture> {
  const server = new wsModule.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fixture did not expose a TCP address');
  }

  const frames: SessionConnectionFrame[] = [];
  const sockets = new Set<FixtureSocket>();
  server.on('connection', (socket, request) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as SessionConnectionFrame;
      frames.push(frame);
      onFrame(frame, socket, request.url || '/');
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    frames,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(socket: FixtureSocket, frame: TerminalMuxServerFrame) {
  socket.send(JSON.stringify(frame));
}

function accountFor(url: string): AuthenticatedAccount {
  const endpoint = new URL(url);
  const directory: RelayAccountDirectory = {
    schemaVersion: 1,
    user: {
      id: 'account-1',
      username: 'jason',
    },
    devices: [{
      deviceId: 'device-1',
      deviceName: 'Mac Studio',
      platform: 'darwin',
      appVersion: '1.0.0',
      client: {
        connected: true,
        lastSeenAt: '2026-10-20T00:00:00.000Z',
      },
      daemon: {
        hostId: 'daemon-1',
        version: '0.1.0',
        presence: {
          connected: true,
          lastSeenAt: '2026-10-20T00:00:00.000Z',
        },
        endpoints: [{
          id: 'lan-1',
          kind: 'lan',
          host: endpoint.hostname,
          port: Number(endpoint.port),
          wsUrl: url,
          authToken: 'daemon-endpoint-token',
          authRequired: true,
          lastSeenAt: '2026-10-20T00:00:00.000Z',
        }],
        sessions: [],
        lastPublishedAt: '2026-10-20T00:00:00.000Z',
      },
    }],
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  return {
    relayBaseUrl: 'https://relay.example.test/',
    accessToken: 'account-access-token',
    user: {
      id: 'account-1',
      username: 'jason',
    },
    directory,
    ws: {
      client: 'wss://relay.example.test/ws/client',
    },
  };
}

function createConnection(url: string, options: {
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
} = {}) {
  const factory = createNodeTraversalFactory({
    WebSocket: wsModule.WebSocket,
    RTCPeerConnection: wrtc.RTCPeerConnection,
    RTCSessionDescription: wrtc.RTCSessionDescription,
    RTCIceCandidate: wrtc.RTCIceCandidate,
  });
  return new SessionConnection({
    account: accountFor(url),
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
    },
    routeHealthScope: {
      accountId: 'account-1',
      daemonHostId: 'daemon-1',
      networkGeneration: 3,
    },
    traversalFactory: factory,
    clientInstanceId: 'cli-test-instance',
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 1000,
  });
}

describe('SessionConnection route identity', () => {
  it('keeps target and auth binding while using the client identity for relay', () => {
    const context = buildSessionConnectionRouteContext(
      accountFor('ws://127.0.0.1:1'),
      {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
      },
      {
        accountId: 'account-1',
        daemonHostId: 'daemon-1',
        networkGeneration: 3,
      },
      'client-instance-2',
    );

    expect(context.device.deviceId).toBe('device-1');
    expect(context.daemon.hostId).toBe('daemon-1');
    expect(context.target).toMatchObject({
      daemonHostId: 'daemon-1',
      relayHostId: 'daemon-1',
    });
    const { traversalRelay } = context.settings;
    expect(traversalRelay).toMatchObject({
      relayBaseUrl: 'https://relay.example.test/',
      accessToken: 'account-access-token',
      userId: 'account-1',
      username: 'jason',
      deviceId: 'client-instance-2',
    });
    expect(traversalRelay?.deviceId).not.toBe(context.device.deviceId);
  });

  it('rejects an empty client identity before building the route context', () => {
    let rejection: unknown;
    try {
      buildSessionConnectionRouteContext(
        accountFor('ws://127.0.0.1:1'),
        {
          deviceId: 'device-1',
          daemonHostId: 'daemon-1',
        },
        {
          accountId: 'account-1',
          daemonHostId: 'daemon-1',
          networkGeneration: 3,
        },
        ' ',
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      name: 'SessionConnectionError',
      stage: 'resolution',
      code: 'invalid_context',
      message: 'clientInstanceId is required',
    });
  });

  it('projects an explicit relay policy without changing target identity or transport modes', () => {
    const account = accountFor('ws://127.0.0.1:1');
    account.turn = {
      url: 'turn:turn.example.test:3478?transport=tcp',
      username: 'turn-user',
      credential: 'turn-secret',
    };
    const context = buildSessionConnectionRouteContext(
      account,
      {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
      },
      {
        accountId: 'account-1',
        daemonHostId: 'daemon-1',
        networkGeneration: 3,
      },
      'client-instance-3',
      { rtcIceTransportPolicy: 'relay' },
    );

    expect(context.settings.rtcIceTransportPolicy).toBe('relay');
    expect(context.settings.transportMode).toBe('auto');
    expect(context.target.transportMode).toBe('auto');
    expect(context.target).toMatchObject({
      daemonHostId: 'daemon-1',
      relayHostId: 'daemon-1',
    });
    expect(context.settings).toMatchObject({
      turnServerUrl: 'turn:turn.example.test:3478?transport=tcp',
      turnUsername: 'turn-user',
      turnCredential: 'turn-secret',
      traversalRelay: {
        turnUrl: 'turn:turn.example.test:3478?transport=tcp',
        turnUsername: 'turn-user',
        turnCredential: 'turn-secret',
      },
    });
  });

  it('keeps the exact prior traversal settings shape when the policy is omitted', () => {
    const account = accountFor('ws://127.0.0.1:1');
    const server = {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
    };
    const scope = {
      accountId: 'account-1',
      daemonHostId: 'daemon-1',
      networkGeneration: 3,
    };
    const baseline = buildSessionConnectionRouteContext(
      account,
      server,
      scope,
      'client-instance-4',
    );
    const omitted = buildSessionConnectionRouteContext(
      account,
      server,
      scope,
      'client-instance-4',
      {},
    );

    expect('rtcIceTransportPolicy' in baseline.settings).toBe(false);
    expect(Object.keys(baseline.settings)).toEqual([
      'signalUrl',
      'turnServerUrl',
      'turnUsername',
      'turnCredential',
      'transportMode',
      'traversalRelay',
    ]);
    expect(omitted.settings).toEqual(baseline.settings);
    expect(baseline.target.transportMode).toBe('auto');
    expect(baseline.settings.transportMode).toBe('auto');
  });
});

function readyFrame(daemonHostId = 'daemon-1'): TerminalMuxServerFrame {
  return {
    type: 'mux-ready',
    payload: {
      version: 1,
      daemonHostId,
      capabilities: {
        version: 1,
        channelEnvelope: true,
        targetMessages: true,
        boundedBodyScheduler: true,
      },
    },
  };
}

class ManualTimers implements SessionConnectionTimerPort {
  private nextHandle = 1;

  private readonly callbacks = new Map<number, () => void>();

  private readonly active = new Set<number>();

  setTimeout(callback: () => void) {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.active.add(handle);
    return handle;
  }

  clearTimeout(handle: unknown) {
    if (typeof handle === 'number') {
      this.active.delete(handle);
    }
  }

  pendingCount() {
    return this.active.size;
  }

  lastHandle() {
    return this.nextHandle - 1;
  }

  fire(handle: number) {
    if (!this.active.delete(handle)) {
      return false;
    }
    this.callbacks.get(handle)?.();
    return true;
  }

  fireStale(handle: number) {
    this.callbacks.get(handle)?.();
  }
}

class BoundInitialFixtureSocket implements SessionConnectionTraversalSocket {
  private port: InitialAttemptPort | null = null;

  private currentAttemptId: AttemptId | null = null;

  private confirmedAttemptId: AttemptId | null = null;

  syncReadyOnAttempt = false;

  readonly sends: Array<{
    method: 'attempt' | 'ready';
    attemptId?: AttemptId;
    data: string | ArrayBuffer;
  }> = [];

  readonly confirmations: AttemptId[] = [];

  readonly failures: Array<{ attemptId: AttemptId; failure: AttemptFailure }> = [];

  readonly traversalDiagnostics: TraversalDiagnostics = {
    mode: 'auto',
    stage: 'connecting',
    attempts: [],
  };

  closeCalls: Array<{ code?: number; reason?: string }> = [];

  onopen: ((event?: Event) => void) | null = null;

  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

  onerror: ((event?: Event) => void) | null = null;

  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  attach(port: InitialAttemptPort) {
    this.port = port;
  }

  emit(event: InitialAttemptEvent) {
    this.port?.onEvent(event);
  }

  begin(attemptId: AttemptId) {
    this.currentAttemptId = attemptId;
    this.emit({ type: 'begin', attemptId });
  }

  sendForAttempt(id: AttemptId, data: string | ArrayBuffer) {
    if (this.currentAttemptId !== id || this.confirmedAttemptId !== null) {
      return false;
    }
    this.sends.push({ method: 'attempt', attemptId: id, data });
    if (
      this.syncReadyOnAttempt
      && typeof data === 'string'
      && (JSON.parse(data) as { type?: string }).type === 'mux-hello'
    ) {
      this.emit({
        type: 'message',
        attemptId: id,
        data: JSON.stringify(readyFrame()),
      });
    }
    return true;
  }

  confirmAttempt(id: AttemptId) {
    if (this.currentAttemptId !== id || this.confirmedAttemptId !== null) {
      return false;
    }
    this.confirmedAttemptId = id;
    this.confirmations.push(id);
    return true;
  }

  failAttempt(id: AttemptId, failure: AttemptFailure) {
    if (this.currentAttemptId !== id || this.confirmedAttemptId !== null) {
      return false;
    }
    this.failures.push({ attemptId: id, failure });
    this.currentAttemptId = null;
    this.emit({
      type: 'invalidated',
      attemptId: id,
      reason: 'failure',
      failure,
    });
    return true;
  }

  getDiagnostics() {
    return this.traversalDiagnostics;
  }

  send(data: string | ArrayBuffer) {
    this.sends.push({
      method: 'ready',
      attemptId: this.confirmedAttemptId ?? undefined,
      data,
    });
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }

  attempts() {
    return this.sends.filter((send) => send.method === 'attempt');
  }

  readySends() {
    return this.sends.filter((send) => send.method === 'ready');
  }

  jsonFrames(method: 'attempt' | 'ready' = 'attempt') {
    return this.sends
      .filter((send) => send.method === method && typeof send.data === 'string')
      .map((send) => JSON.parse(send.data as string) as SessionConnectionFrame);
  }
}

function createBoundInitialConnection(
  socket: BoundInitialFixtureSocket,
  timers: ManualTimers,
  options: {
    handshakeTimeoutMs?: number;
    rtcIceTransportPolicy?: TraversalRtcIceTransportPolicy;
  } = {},
) {
  let socketOptions: Parameters<SessionConnectionTraversalFactory['createSocket']>[2] | undefined;
  let socketSettings: TraversalSettingsSource | undefined;
  const factory: SessionConnectionTraversalFactory = {
    createSocket(_target, settings, nextOptions) {
      socketSettings = settings;
      socketOptions = nextOptions;
      socket.attach(nextOptions.initialAttemptPort);
      return socket;
    },
  };
  const connection = new SessionConnection({
    account: accountFor('ws://127.0.0.1:1'),
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
    },
    routeHealthScope: {
      accountId: 'account-1',
      daemonHostId: 'daemon-1',
      networkGeneration: 3,
    },
    traversalFactory: factory,
    clientInstanceId: 'bound-initial-test',
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 250,
    timers,
    ...(options.rtcIceTransportPolicy === undefined
      ? {}
      : { rtcIceTransportPolicy: options.rtcIceTransportPolicy }),
  });
  return {
    connection,
    getSocketOptions: () => socketOptions,
    getSettings: () => socketSettings,
  };
}

describe('SessionConnection public consumer', () => {
  it('handshakes, correlates target requests, and keeps daemon and account tokens separate', async () => {
    const seenRequestUrls: string[] = [];
    const fixture = await createFixture((frame, socket, requestUrl) => {
      seenRequestUrls.push(requestUrl);
      if (frame.type === 'mux-hello') {
        send(socket, {
          type: 'mux-ready',
          payload: {
            version: 1,
            daemonHostId: 'daemon-1',
            capabilities: {
              version: 1,
              channelEnvelope: true,
              targetMessages: true,
              boundedBodyScheduler: true,
            },
          },
        });
        return;
      }
      if (frame.type === 'mux-target-message') {
        const payload = frame.payload as {
          requestId?: string;
          message: { type: string };
        };
        if (payload.message.type === 'list-sessions') {
          send(socket, {
            type: 'mux-target-message',
            payload: {
              requestId: 'wrong-request',
              message: {
                type: 'sessions',
                payload: { sessions: ['wrong'] },
              },
            },
          });
          send(socket, {
            type: 'mux-target-message',
            payload: {
              requestId: payload.requestId,
              message: {
                type: 'sessions',
                payload: {
                  sessions: ['work'],
                  sessionCatalog: [{
                    name: 'work',
                    backend: 'tmux',
                    stableId: 'tmux:socket=/tmp/zterm.sock:server=1:session=$1:created=1',
                  }],
                },
              },
            },
          });
        }
      }
    });

    try {
      const connection = createConnection(fixture.url);
      await connection.ready();
      expect(connection.state).toBe('ready');

      const sessions = await connection.listSessions({ backend: 'tmux' });
      expect(sessions.sessions).toEqual(['work']);
      expect(sessions.sessionCatalog?.[0]?.stableId).toContain('session=$1');

      expect(seenRequestUrls).toHaveLength(2);
      expect(new URL(seenRequestUrls[1]!, 'ws://fixture').searchParams.get('token'))
        .toBe('daemon-endpoint-token');
      expect(seenRequestUrls[1]).not.toContain('account-access-token');
      const targetFrames = fixture.frames.filter((frame) => frame.type === 'mux-target-message');
      expect(targetFrames).toHaveLength(1);
      expect(targetFrames[0]?.payload).toMatchObject({
        message: {
          type: 'list-sessions',
          payload: { terminalBackend: 'tmux' },
        },
      });
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('preserves unavailable and failed snapshot outcomes and their request IDs', async () => {
    const unavailable = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
      if (frame.type === 'mux-target-message') {
        const payload = frame.payload as {
          requestId?: string;
          message: { type: string };
        };
        if (payload.message.type === 'terminal-snapshot-request') {
          send(socket, {
            type: 'mux-target-message',
            payload: {
              requestId: payload.requestId,
              message: {
                type: 'terminal-snapshot-result',
                payload: {
                  status: 'unavailable',
                  reason: 'mirror_not_present',
                },
              },
            },
          });
        }
      }
    });

    try {
      const connection = createConnection(unavailable.url);
      const result = await connection.readSnapshot({
        backend: 'tmux',
        stableId: 'stable-1',
        maxLines: 200,
      });
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'mirror_not_present',
      });
      connection.close();
    } finally {
      await unavailable.close();
    }

    const failed = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
      if (frame.type === 'mux-target-message') {
        const payload = frame.payload as {
          requestId?: string;
          message: { type: string };
        };
        if (payload.message.type === 'terminal-snapshot-request') {
          send(socket, {
            type: 'mux-target-message',
            payload: {
              requestId: payload.requestId,
              message: {
                type: 'terminal-snapshot-result',
                payload: {
                  status: 'failed',
                  code: 'session_identity_mismatch',
                },
              },
            },
          });
        }
      }
    });

    try {
      const connection = createConnection(failed.url);
      await expect(connection.readSnapshot({
        backend: 'tmux',
        stableId: 'stable-1',
        maxLines: 200,
      })).resolves.toEqual({
        status: 'failed',
        code: 'session_identity_mismatch',
      });
      connection.close();
    } finally {
      await failed.close();
    }
  });

  it('opens only an exact existing identity and verifies the opened stable ID', async () => {
    const fixture = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
        return;
      }
      if (frame.type === 'mux-channel-open') {
        const payload = frame.payload as { channelId: string };
        send(socket, {
          type: 'mux-channel-opened',
          payload: {
            channelId: payload.channelId,
            sessionName: 'work',
            stableId: 'different-stable-id',
          },
        });
      }
    });

    try {
      const connection = createConnection(fixture.url);
      await expect(connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
        cols: 100,
        rows: 30,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      })).rejects.toMatchObject({
        name: 'SessionConnectionError',
        stage: 'channel-open',
        code: 'identity_mismatch',
      });

      const open = fixture.frames.find((frame) => frame.type === 'mux-channel-open');
      expect(open?.payload).toMatchObject({
        sessionName: 'work',
        backend: 'tmux',
        expectedSessionIdentity: 'stable-1',
        existingOnly: true,
        cols: 100,
        rows: 30,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const close = fixture.frames.find((frame) => frame.type === 'mux-channel-close');
      expect(close?.payload).toMatchObject({
        channelId: open?.payload.channelId,
        reason: 'session_identity_mismatch',
      });
      expect(connection.channels.size).toBe(0);
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('preserves the typed server code when an exact existing identity is rejected', async () => {
    const fixture = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
        return;
      }
      if (frame.type === 'mux-channel-open') {
        send(socket, {
          type: 'mux-channel-closed',
          payload: {
            channelId: frame.payload.channelId,
            reason: 'resolved session identity differs from the request: secret-value',
            code: 'session_identity_mismatch',
          },
        });
      }
    });

    try {
      const connection = createConnection(fixture.url);
      await expect(connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
        bodySubscribed: true,
      })).rejects.toMatchObject({
        name: 'SessionConnectionError',
        stage: 'channel-open',
        code: 'channel_closed',
        serverCode: 'session_identity_mismatch',
      });
      expect(connection.channels.size).toBe(0);
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('keeps generic channel close semantics when the server omits a code', async () => {
    const fixture = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
        return;
      }
      if (frame.type === 'mux-channel-open') {
        send(socket, {
          type: 'mux-channel-closed',
          payload: {
            channelId: frame.payload.channelId,
            reason: 'closed_without_code',
          },
        });
      }
    });

    try {
      const connection = createConnection(fixture.url);
      await expect(connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
        bodySubscribed: true,
      })).rejects.toMatchObject({
        name: 'SessionConnectionError',
        stage: 'channel-open',
        code: 'channel_closed',
        serverCode: undefined,
      });
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('partitions target and channel envelopes and delivers input ACK unchanged', async () => {
    const events: SessionConnectionEvent[] = [];
    let openedChannelId = '';
    const fixture = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
        return;
      }
      if (frame.type === 'mux-channel-open') {
        openedChannelId = (frame.payload as { channelId: string }).channelId;
        send(socket, {
          type: 'mux-channel-opened',
          payload: {
            channelId: openedChannelId,
            sessionName: 'work',
            stableId: 'stable-1',
            capabilities: {
              reliableInput: { version: 1 },
            },
          },
        });
        return;
      }
      if (frame.type === 'mux-channel-message') {
        const payload = frame.payload as {
          channelId: string;
          message: { type: string };
        };
        if (payload.message.type === 'input') {
          send(socket, {
            type: 'mux-channel-message',
            payload: {
              channelId: payload.channelId,
              message: {
                type: 'input-ack',
                payload: {
                  version: 1,
                  seq: '7',
                  accepted: true,
                  bytes: 3,
                },
              },
            },
          });
        }
      }
    });

    try {
      const connection = createConnection(fixture.url);
      connection.onEvent((event) => events.push(event));
      const channel = await connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
        bodySubscribed: true,
      });
      expect(channel.capabilities).toEqual({
        reliableInput: { version: 1 },
      });

      channel.send({
        type: 'input',
        payload: {
          version: 1,
          seq: '7',
          data: 'ls\n',
          sentAt: 1,
          attempt: 0,
        },
      });
      channel.sendBinary('AAE=');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(fixture.frames.find((frame) =>
        frame.type === 'mux-channel-message'
        && frame.payload.channelId === openedChannelId)).toMatchObject({
        type: 'mux-channel-message',
        payload: {
          message: {
            type: 'input',
            payload: { seq: '7' },
          },
        },
      });
      expect(fixture.frames.find((frame) => frame.type === 'mux-channel-binary')).toMatchObject({
        type: 'mux-channel-binary',
        payload: {
          channelId: openedChannelId,
          dataBase64: 'AAE=',
        },
      });
      expect(events).toContainEqual({
        type: 'input-ack',
        channelId: openedChannelId,
        payload: {
          version: 1,
          seq: '7',
          accepted: true,
          bytes: 3,
        },
      });
      expect(events).toContainEqual({
        type: 'channel-message',
        channelId: openedChannelId,
        message: {
          type: 'input-ack',
          payload: {
            version: 1,
            seq: '7',
            accepted: true,
            bytes: 3,
          },
        },
      });
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('keeps request stage on timeout and cancellation', async () => {
    const fixture = await createFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        send(socket, {
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
    });

    try {
      const connection = createConnection(fixture.url, {
        requestTimeoutMs: 40,
      });
      await expect(connection.listSessions()).rejects.toMatchObject({
        name: 'SessionConnectionError',
        stage: 'list-sessions',
        code: 'timeout',
      });

      const controller = new AbortController();
      const pending = connection.readSnapshot({
        backend: 'tmux',
        stableId: 'stable-1',
        maxLines: 100,
      }, controller.signal);
      controller.abort('user cancellation');
      await expect(pending).rejects.toMatchObject({
        name: 'SessionConnectionError',
        stage: 'snapshot',
        code: 'cancelled',
      });
      connection.close();
    } finally {
      await fixture.close();
    }
  });

  it('closes owned sockets and isolates late messages from old channels', async () => {
    const events: SessionConnectionEvent[] = [];
    let openedFrame: TerminalMuxClientFrame | undefined;
    let serverSocket: FixtureSocket | undefined;
    const fixture = await createFixture((frame, socket) => {
      serverSocket = socket;
      if (frame.type === 'mux-hello') {
        send(socket, {
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
        return;
      }
      if (frame.type === 'mux-channel-open') {
        openedFrame = frame;
        send(socket, {
          type: 'mux-channel-opened',
          payload: {
            channelId: frame.payload.channelId,
            sessionName: 'work',
            stableId: 'stable-1',
          },
        });
      }
    });

    try {
      const connection = createConnection(fixture.url);
      connection.onEvent((event) => events.push(event));
      const channel = await connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
      });
      const channelId = channel.id;
      channel.close('local_exit');
      expect(connection.channels.size).toBe(0);

      serverSocket?.send(JSON.stringify({
        type: 'mux-channel-message',
        payload: {
          channelId,
          message: {
            type: 'input-ack',
            payload: {
              version: 1,
              seq: 'late',
              accepted: true,
              bytes: 1,
            },
          },
        },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(events.some((event) =>
        event.type === 'input-ack'
        && event.payload.seq === 'late')).toBe(false);

      connection.close('test_done');
      expect(connection.state).toBe('closed');
      expect(fixture.frames.some((frame) => frame.type === 'mux-target-message'
        && frame.payload.message.type === 'tmux-kill-session')).toBe(false);
      expect(fixture.frames.some((frame) => frame.type === 'mux-channel-message'
        && (frame.payload.message as { type: string }).type === 'close')).toBe(false);
      expect(openedFrame?.type).toBe('mux-channel-open');
    } finally {
      await fixture.close();
    }
  });
});

describe('SessionConnection bound-initial attempt handoff', () => {
  it('forwards the optional RTC policy from connection options into traversal settings', () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection, getSettings } = createBoundInitialConnection(socket, timers, {
      rtcIceTransportPolicy: 'relay',
    });

    expect(getSettings()).toMatchObject({
      transportMode: 'auto',
      rtcIceTransportPolicy: 'relay',
    });
    connection.close('test-complete');
  });

  it('reads the traversal socket diagnostics without rebuilding route state', () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);

    const diagnostics = connection.getDiagnostics();

    expect(diagnostics).toBe(socket.traversalDiagnostics);
    connection.close('test-complete');
  });

  it('accepts a synchronous ready during hello send without installing a timer', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    socket.syncReadyOnAttempt = true;
    const { connection } = createBoundInitialConnection(socket, timers);

    socket.begin(1);
    await connection.ready();

    expect(socket.confirmations).toEqual([1]);
    expect(connection.state).toBe('ready');
    expect(timers.pendingCount()).toBe(0);
    connection.close('test-complete');
  });

  it('hands an opened A over to B and ignores A ready, messages, and old timer', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection, getSocketOptions } = createBoundInitialConnection(socket, timers);
    const events: SessionConnectionEvent[] = [];
    connection.onEvent((event) => events.push(event));

    expect(getSocketOptions()).toMatchObject({
      candidateScope: 'bound-initial',
      autoReconnect: false,
      requireOpenConfirmation: true,
    });

    socket.begin(1);
    expect(socket.attempts()).toHaveLength(1);
    expect(socket.jsonFrames()[0]).toMatchObject({ type: 'mux-hello' });
    const oldHelloTimer = timers.lastHandle();

    socket.emit({
      type: 'invalidated',
      attemptId: 1,
      reason: 'failure',
      failure: {
        stage: 'mux',
        kind: 'timeout',
        timer: 'confirmation',
      },
    });
    expect(timers.pendingCount()).toBe(0);

    socket.begin(2);
    expect(socket.attempts()).toHaveLength(2);
    expect(socket.attempts()[1]?.attemptId).toBe(2);
    expect(socket.jsonFrames()[1]).toMatchObject({ type: 'mux-hello' });

    timers.fireStale(oldHelloTimer);
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(readyFrame()),
    });
    expect(socket.failures).toHaveLength(0);
    expect(socket.confirmations).toHaveLength(0);

    socket.emit({
      type: 'message',
      attemptId: 2,
      data: JSON.stringify(readyFrame()),
    });
    await connection.ready();

    expect(socket.confirmations).toEqual([2]);
    expect(connection.state).toBe('ready');
    expect(events.filter((event) => event.type === 'ready')).toHaveLength(1);
    expect(timers.pendingCount()).toBe(0);
    connection.close('test-complete');
  });

  it('reports a hello timeout to the current attempt without closing the next candidate', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);

    socket.begin(1);
    expect(timers.fire(timers.lastHandle())).toBe(true);
    expect(socket.failures).toEqual([{
      attemptId: 1,
      failure: {
        stage: 'mux',
        kind: 'timeout',
        timer: 'hello',
      },
    }]);
    expect(connection.state).toBe('socket-connecting');

    socket.begin(2);
    socket.emit({
      type: 'message',
      attemptId: 2,
      data: JSON.stringify(readyFrame()),
    });
    await connection.ready();

    expect(socket.confirmations).toEqual([2]);
    expect(connection.state).toBe('ready');
    connection.close('test-complete');
  });

  it('cancels the handoff and ignores later begin and ready events', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);
    const events: SessionConnectionEvent[] = [];
    connection.onEvent((event) => events.push(event));

    socket.begin(1);
    const ready = connection.ready();
    connection.close('handoff-cancelled');

    socket.begin(2);
    socket.emit({
      type: 'message',
      attemptId: 2,
      data: JSON.stringify(readyFrame()),
    });

    await expect(ready).rejects.toMatchObject({
      name: 'SessionConnectionError',
      code: 'closed',
    });
    expect(socket.confirmations).toEqual([]);
    expect(socket.attempts()).toHaveLength(1);
    expect(socket.closeCalls).toEqual([{
      code: 1000,
      reason: 'handoff-cancelled',
    }]);
    expect(events.filter((event) => event.type === 'ready')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
    expect(timers.pendingCount()).toBe(0);
  });

  it('rejects a mismatched daemon identity on the current attempt and accepts B', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);

    socket.begin(1);
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(readyFrame('other-daemon')),
    });
    expect(socket.failures).toMatchObject([{
      attemptId: 1,
      failure: {
        stage: 'mux',
        kind: 'binding',
        expectedDaemonHostId: 'daemon-1',
        actualDaemonHostId: 'other-daemon',
      },
    }]);
    expect(connection.state).toBe('socket-connecting');

    socket.begin(2);
    socket.emit({
      type: 'message',
      attemptId: 2,
      data: JSON.stringify(readyFrame()),
    });
    await connection.ready();
    expect(socket.confirmations).toEqual([2]);
    connection.close('test-complete');
  });

  it('keeps the confirmed winner port for channel data and confirms ready once', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);
    const events: SessionConnectionEvent[] = [];
    connection.onEvent((event) => events.push(event));

    socket.begin(1);
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(readyFrame()),
    });
    await connection.ready();

    const open = connection.openExisting({
      sessionName: 'work',
      backend: 'tmux',
      stableId: 'stable-1',
      bodySubscribed: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const openFrame = socket.jsonFrames('ready')
      .find((frame) => frame.type === 'mux-channel-open');
    expect(openFrame).toMatchObject({
      type: 'mux-channel-open',
      payload: {
        sessionName: 'work',
        expectedSessionIdentity: 'stable-1',
        existingOnly: true,
      },
    });
    const channelId = (openFrame?.payload as { channelId: string }).channelId;
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify({
        type: 'mux-channel-opened',
        payload: {
          channelId,
          sessionName: 'work',
          stableId: 'stable-1',
        },
      } satisfies TerminalMuxServerFrame),
    });
    await expect(open).resolves.toMatchObject({
      id: channelId,
      sessionName: 'work',
      stableId: 'stable-1',
    });

    const ackFrame = {
      type: 'mux-channel-message',
      payload: {
        channelId,
        message: {
          type: 'input-ack',
          payload: {
            version: 1,
            seq: '7',
            accepted: true,
            bytes: 3,
          },
        },
      },
    } satisfies TerminalMuxServerFrame;
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(ackFrame),
    });
    socket.emit({
      type: 'message',
      attemptId: 99,
      data: JSON.stringify(ackFrame),
    });

    expect(events.filter((event) =>
      event.type === 'channel-message'
      && event.channelId === channelId)).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === 'input-ack'
      && event.channelId === channelId)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'ready')).toHaveLength(1);
    expect(socket.confirmations).toEqual([1]);

    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(readyFrame()),
    });
    expect(connection.state).toBe('failed');
    expect(events.filter((event) => event.type === 'ready')).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === 'error'
      && event.error.code === 'protocol_error')).toHaveLength(1);
    connection.close('test-complete');
  });

  it('fails explicitly when the confirmed winner is invalidated after ready', async () => {
    const timers = new ManualTimers();
    const socket = new BoundInitialFixtureSocket();
    const { connection } = createBoundInitialConnection(socket, timers);
    const events: SessionConnectionEvent[] = [];
    connection.onEvent((event) => events.push(event));

    socket.begin(1);
    socket.emit({
      type: 'message',
      attemptId: 1,
      data: JSON.stringify(readyFrame()),
    });
    await connection.ready();

    const failure: AttemptFailure = {
      stage: 'mux',
      kind: 'ws-close',
      code: 1006,
      reason: 'link lost',
    };
    socket.emit({
      type: 'invalidated',
      attemptId: 1,
      reason: 'failure',
      failure,
    });

    expect(connection.state).toBe('failed');
    const error = events.find((event) =>
      event.type === 'error') as Extract<SessionConnectionEvent, { type: 'error' }> | undefined;
    expect(error?.error).toMatchObject({
      name: 'SessionConnectionError',
      stage: 'closed',
      code: 'socket_closed',
    });
    expect(error?.error.cause).toBe(failure);
    expect(events.filter((event) => event.type === 'ready')).toHaveLength(1);
    expect(socket.confirmations).toEqual([1]);
    connection.close('test-complete');
  });
});
