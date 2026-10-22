import wrtc from '@roamhq/wrtc';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedAccount } from './account-client.js';
import { createApplicationConnection } from './application-connection.js';
import type {
  SessionConnectionEvent,
  SessionConnectionFrame,
} from './connection.js';
import type { RelayAccountDirectory } from '../../shared/src/connection/relay-directory.js';
import type { TerminalMuxServerFrame } from '../../shared/src/connection/protocol.js';

interface FixtureSocket {
  send(data: string): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  terminate(): void;
}

interface FixtureSocketServer {
  once(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (socket: FixtureSocket) => void): void;
  address(): { port: number } | string | null;
  close(callback: () => void): void;
}

const require = createRequire(import.meta.url);
const wsModule = require('ws') as {
  WebSocket: new (url: string) => unknown;
  WebSocketServer: new (options: { host: string; port: number }) => FixtureSocketServer;
};

function readyFrame(): TerminalMuxServerFrame {
  return {
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
  };
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
        version: '1.0.0',
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
          authRequired: false,
          lastSeenAt: '2026-10-20T00:00:00.000Z',
        }],
        sessions: [],
        lastPublishedAt: '2026-10-20T00:00:00.000Z',
      },
    }],
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  return {
    relayBaseUrl: 'https://relay.example.test/zterm/',
    accessToken: 'account-access-secret',
    user: {
      id: 'account-1',
      username: 'jason',
    },
    directory,
  };
}

async function startFixture(
  onFrame?: (frame: SessionConnectionFrame, socket: FixtureSocket) => void,
) {
  const server = new wsModule.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fixture did not expose a TCP address');
  }
  const sockets = new Set<FixtureSocket>();
  const frames: SessionConnectionFrame[] = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as SessionConnectionFrame;
      frames.push(frame);
      if (onFrame) {
        onFrame(frame, socket);
      } else if (frame.type === 'mux-hello') {
        socket.send(JSON.stringify(readyFrame()));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    frames,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startAuthRejectingServer(statusCode: 401 | 403) {
  const attempts: string[] = [];
  const server: Server = createServer((request, response) => {
    response.writeHead(statusCode).end();
    attempts.push(request.url || '');
  });
  server.on('upgrade', (request, socket) => {
    attempts.push(request.url || '');
    socket.end([
      `HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Forbidden'}`,
      'Connection: close',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('auth fixture did not expose a TCP address');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    attempts,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startSignalingProbe() {
  const server = new wsModule.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('signaling fixture did not expose a TCP address');
  }
  const sockets = new Set<FixtureSocket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connectionCount: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('createApplicationConnection public contract', () => {
  it('creates a distinct client identity for each application connection', async () => {
    const fixture = await startFixture();
    try {
      const account = accountFor(fixture.url);
      const server = {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
      };
      const first = await createApplicationConnection(account, server);
      const second = await createApplicationConnection(account, server);
      const clientInstanceIds = fixture.frames.flatMap((frame) =>
        frame.type === 'mux-hello' ? [frame.payload.clientInstanceId] : []);

      expect(clientInstanceIds).toHaveLength(2);
      expect(clientInstanceIds[0]).toBeTruthy();
      expect(clientInstanceIds[1]).toBeTruthy();
      expect(clientInstanceIds[0]).not.toBe(clientInstanceIds[1]);
      first.close('test-complete');
      second.close('test-complete');
    } finally {
      await fixture.close();
    }
  });

  it('uses the real Node dependencies and the exact account/server route scope', async () => {
    const fixture = await startFixture();
    try {
      const connection = await createApplicationConnection(
        accountFor(fixture.url),
        {
          deviceId: 'device-1',
          daemonHostId: 'daemon-1',
        },
      );
      expect(connection.state).toBe('ready');
      expect(fixture.frames[0]).toMatchObject({
        type: 'mux-hello',
        payload: {
          deviceId: 'device-1',
        },
      });
      connection.close('test-complete');
    } finally {
      await fixture.close();
    }
  });

  it('keeps channel data and input acknowledgements on the confirmed winner', async () => {
    const fixture = await startFixture((frame, socket) => {
      if (frame.type === 'mux-hello') {
        socket.send(JSON.stringify(readyFrame()));
        return;
      }
      if (frame.type === 'mux-channel-open') {
        socket.send(JSON.stringify({
          type: 'mux-channel-opened',
          payload: {
            channelId: frame.payload.channelId,
            sessionName: frame.payload.sessionName,
            stableId: frame.payload.expectedSessionIdentity,
          },
        }));
        socket.send(JSON.stringify({
          type: 'mux-channel-message',
          payload: {
            channelId: frame.payload.channelId,
            message: {
              type: 'input-ack',
              payload: {
                version: 1,
                seq: '4',
                accepted: true,
                bytes: 2,
              },
            },
          },
        }));
      }
    });
    try {
      const connection = await createApplicationConnection(
        accountFor(fixture.url),
        {
          deviceId: 'device-1',
          daemonHostId: 'daemon-1',
        },
      );
      const events: SessionConnectionEvent[] = [];
      const ack = new Promise<SessionConnectionEvent>((resolve) => {
        connection.onEvent((event) => {
          events.push(event);
          if (event.type === 'input-ack') resolve(event);
        });
      });
      const channel = await connection.openExisting({
        sessionName: 'work',
        backend: 'tmux',
        stableId: 'stable-1',
        bodySubscribed: true,
      });
      await expect(ack).resolves.toMatchObject({
        type: 'input-ack',
        channelId: channel.id,
        payload: { seq: '4', accepted: true, bytes: 2 },
      });
      expect(events.filter((event) => event.type === 'channel-message')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'input-ack')).toHaveLength(1);
      connection.close('test-complete');
    } finally {
      await fixture.close();
    }
  });

  it('rejects a server outside the authenticated directory before opening a socket', async () => {
    const account = accountFor('ws://127.0.0.1:1');

    await expect(createApplicationConnection(account, {
      deviceId: 'device-1',
      daemonHostId: 'other-daemon',
    })).rejects.toMatchObject({
      code: 'invalid_context',
      stage: 'resolution',
    });
  });

  it('honors an already-aborted lifecycle signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop before connect'));

    await expect(createApplicationConnection(
      accountFor('ws://127.0.0.1:1'),
      {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
      },
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('connects through the real public API with an explicit relay policy', async () => {
    const fixture = await startFixture();
    try {
      const connection = await createApplicationConnection(
        accountFor(fixture.url),
        {
          deviceId: 'device-1',
          daemonHostId: 'daemon-1',
        },
        undefined,
        { rtcIceTransportPolicy: 'relay' },
      );
      expect(connection.state).toBe('ready');
      connection.close('test-complete');
    } finally {
      await fixture.close();
    }
  });

  it.each([401, 403] as const)(
    'terminates on a real HTTP %i response without opening the next route',
    async (statusCode) => {
      const rejecting = await startAuthRejectingServer(statusCode);
      const signaling = await startSignalingProbe();
      try {
        const account = accountFor(rejecting.url);
        const daemon = account.directory.devices[0]?.daemon;
        if (!daemon) throw new Error('test directory omitted the daemon');
        daemon.endpoints.push({
          id: 'rtc-direct-probe',
          kind: 'rtc-direct',
          relayHostId: 'daemon-1',
          authRequired: false,
          lastSeenAt: '2026-10-20T00:00:00.000Z',
        });
        account.ws = { client: signaling.url };

        const error = await createApplicationConnection(account, {
          deviceId: 'device-1',
          daemonHostId: 'daemon-1',
        }).then(
          () => null,
          (failure: unknown) => failure,
        );

        expect(error).toMatchObject({
          name: 'SessionConnectionError',
          stage: 'socket-connect',
          code: 'auth_failed',
          cause: {
            stage: 'connect',
            kind: 'http',
            status: statusCode,
          },
        });
        expect(rejecting.attempts.length).toBeGreaterThanOrEqual(1);
        expect(signaling.connectionCount()).toBe(0);
      } finally {
        await signaling.close();
        await rejecting.close();
      }
    },
  );
});
