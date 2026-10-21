import http from 'node:http';
import net from 'node:net';
import wrtc from '@roamhq/wrtc';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  AttemptFailure,
  InitialAttemptPort,
} from '../../shared/src/connection/traversal/types';
import type { NodeTraversalSocketOptions } from './node-platform';
import { createNodeTraversalFactory } from './node-platform';
import { createNodeWebSocket } from './node-websocket';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

function listen(server: net.Server, host: string) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server | WebSocketServer) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function captureFailure(
  socket: ReturnType<typeof createNodeWebSocket>,
  observe?: (failure: AttemptFailure) => void,
) {
  const failures: AttemptFailure[] = [];
  const firstFailure = new Promise<AttemptFailure>((resolve) => {
    socket.onfailure = (failure) => {
      failures.push(failure);
      observe?.(failure);
      resolve(failure);
    };
  });
  return { failures, firstFailure };
}

async function settleEvents() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('Node WebSocket adapter', () => {
  it('keeps the bound-initial attempt port required in Node socket options', () => {
    const initialAttemptPort: InitialAttemptPort = {
      onEvent: () => {},
    };
    const options: NodeTraversalSocketOptions = {
      candidateScope: 'bound-initial',
      initialAttemptPort,
    };
    // @ts-expect-error bound-initial must carry the constructor attempt port.
    const missingPort: NodeTraversalSocketOptions = {
      candidateScope: 'bound-initial',
    };

    expect(options.initialAttemptPort).toBe(initialAttemptPort);
    expect(missingPort.candidateScope).toBe('bound-initial');
  });

  it.each([401, 403])('keeps the real HTTP %i response without reading its body', async (statusCode) => {
    const server = http.createServer((_request, response) => {
      response.statusCode = statusCode;
      response.end('credentials rejected');
    });
    const port = await listen(server, '127.0.0.1');
    cleanup.push(() => {
      server.closeAllConnections();
      return closeServer(server);
    });

    const factory = createNodeTraversalFactory({
      WebSocket,
      RTCPeerConnection: wrtc.RTCPeerConnection,
      RTCSessionDescription: wrtc.RTCSessionDescription,
      RTCIceCandidate: wrtc.RTCIceCandidate,
    });
    const socket = factory.platform.createWebSocket(`ws://127.0.0.1:${port}`);
    expect('onfailure' in socket).toBe(true);
    const events: string[] = [];
    const { failures, firstFailure } = captureFailure(socket, () => events.push('typed'));
    const legacyErrors: unknown[] = [];
    socket.onerror = (event) => {
      events.push('error');
      legacyErrors.push(event);
    };
    socket.onclose = () => events.push('close');

    const failure = await firstFailure;
    await settleEvents();

    expect(failure).toMatchObject({
      kind: 'http',
      stage: 'connect',
      status: statusCode,
    });
    expect(failure.cause).toBeInstanceOf(http.IncomingMessage);
    expect((failure.cause as http.IncomingMessage).statusCode).toBe(statusCode);
    expect((failure.cause as http.IncomingMessage).destroyed).toBe(true);
    expect(failures).toHaveLength(1);
    expect(legacyErrors).toHaveLength(1);
    expect(legacyErrors[0]).toMatchObject({
      type: 'error',
      error: expect.any(Error),
    });
    expect(events).toEqual(['typed', 'error', 'close']);
  });

  it('keeps the real ECONNREFUSED Error as the system cause', async () => {
    const reservation = net.createServer();
    const port = await listen(reservation, '127.0.0.1');
    await closeServer(reservation);

    const socket = createNodeWebSocket(new WebSocket(`ws://127.0.0.1:${port}`));
    const { failures, firstFailure } = captureFailure(socket);

    const failure = await firstFailure;
    await settleEvents();

    expect(failure).toMatchObject({
      kind: 'system',
      stage: 'connect',
      code: 'ECONNREFUSED',
    });
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(failures).toHaveLength(1);
  });

  it('keeps an Error without code as unknown instead of inferring a code', async () => {
    const server = net.createServer((connection) => {
      connection.once('data', () => {
        connection.end([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Accept: invalid',
          '',
          '',
        ].join('\r\n'));
      });
    });
    const port = await listen(server, '127.0.0.1');
    cleanup.push(() => closeServer(server));

    const nativeSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    let nativeError: Error | null = null;
    nativeSocket.on('error', (error) => {
      nativeError = error;
    });
    const socket = createNodeWebSocket(nativeSocket);
    const { failures, firstFailure } = captureFailure(socket);

    const failure = await firstFailure;
    await settleEvents();

    expect(failure.kind).toBe('unknown');
    expect(failure.stage).toBe('connect');
    expect('code' in failure).toBe(false);
    expect(failure.cause).toBe(nativeError);
    expect((failure.cause as NodeJS.ErrnoException).code).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('keeps the real close code and reason exactly once', async () => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('server did not expose a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });
    cleanup.push(() => closeServer(server));

    let serverSocket: WebSocket | null = null;
    const connected = new Promise<WebSocket>((resolve) => {
      server.once('connection', (socket) => {
        serverSocket = socket;
        resolve(socket);
      });
    });
    const socket = createNodeWebSocket(new WebSocket(`ws://127.0.0.1:${port}`));
    const { failures, firstFailure } = captureFailure(socket);

    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const accepted = await connected;
    accepted.close(4001, 'explicit close');

    const failure = await firstFailure;
    await settleEvents();

    expect(failure).toMatchObject({
      kind: 'ws-close',
      stage: 'connect',
      code: 4001,
      reason: 'explicit close',
    });
    expect(failure.cause).toMatchObject({
      type: 'close',
      code: 4001,
      reason: 'explicit close',
    });
    expect(serverSocket).toBe(accepted);
    expect(failures).toHaveLength(1);
  });
});
