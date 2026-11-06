// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket as ServerWebSocket } from 'ws';
import {
  buildTerminalMuxError,
  buildTerminalMuxReady,
  buildTerminalMuxServerTargetMessage,
  isTerminalMuxClientFrame,
} from '@zterm/shared/protocol';
import type { BridgeSettings } from './bridge-settings';
import { resetTmuxSessionTransportPoolForTests } from './tmux-sessions';

const bridgeSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'> = {
  signalUrl: 'wss://signal.example.com',
  turnServerUrl: 'turn:relay.example.com',
  turnUsername: 'turn-user',
  turnCredential: 'turn-pass',
  transportMode: 'websocket',
  traversalRelay: undefined,
};

const openServers: WebSocketServer[] = [];

function buildTarget(port: number) {
  return {
    bridgeHost: '127.0.0.1',
    bridgePort: port,
    authToken: 'consumer-blackbox-token',
  };
}

async function startConsumerServer(handlers: {
  onHello?: (ws: ServerWebSocket) => void;
  onTargetMessage?: (ws: ServerWebSocket, frame: unknown) => void;
}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  openServers.push(server);
  const serverCloses: ServerWebSocket[] = [];

  server.on('connection', (ws) => {
    ws.on('close', () => {
      serverCloses.push(ws);
    });
    let helloSeen = false;
    ws.on('message', (rawData: RawData) => {
      const text = rawDataToText(rawData);
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!helloSeen && isTerminalMuxClientFrame(frame) && frame.type === 'mux-hello') {
        helloSeen = true;
        handlers.onHello?.(ws);
        return;
      }
      handlers.onTargetMessage?.(ws, frame);
    });
  });

  return {
    port: (server.address() as { port: number }).port,
    serverCloses,
  };
}

function rawDataToText(rawData: RawData) {
  if (Array.isArray(rawData)) return Buffer.concat(rawData).toString('utf8');
  if (Buffer.isBuffer(rawData)) return rawData.toString('utf8');
  return Buffer.from(rawData).toString('utf8');
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

describe('tmux-sessions public consumer blackbox', () => {
  beforeEach(() => {
    resetTmuxSessionTransportPoolForTests();
  });

  afterEach(async () => {
    resetTmuxSessionTransportPoolForTests();
    while (openServers.length > 0) {
      const server = openServers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('surfaces pre-negotiation unauthorized error and closes transport once', async () => {
    const { port, serverCloses } = await startConsumerServer({
      onHello: (ws) => {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'unauthorized', message: 'Unauthorized bridge token' } }));
      },
    });
    const { fetchTmuxSessions } = await import('./tmux-sessions');

    await expect(fetchTmuxSessions(buildTarget(port), bridgeSettings)).rejects.toThrow('Unauthorized bridge token');
    await waitForCondition(() => serverCloses.length === 1);
  });

  it('surfaces pre-negotiation multiplex upgrade error with daemon message and closes once', async () => {
    const { port, serverCloses } = await startConsumerServer({
      onHello: (ws) => {
        ws.send(JSON.stringify(buildTerminalMuxError(
          'daemon_multiplex_upgrade_required',
          'daemon upgrade required for terminal multiplex transport',
        )));
      },
    });
    const { fetchTmuxSessions } = await import('./tmux-sessions');

    await expect(fetchTmuxSessions(buildTarget(port), bridgeSettings)).rejects.toThrow(
      'daemon upgrade required for terminal multiplex transport',
    );
    await waitForCondition(() => serverCloses.length === 1);
  });

  it('rejects illegal mux frame after mux-ready and closes once', async () => {
    const { port, serverCloses } = await startConsumerServer({
      onHello: (ws) => {
        ws.send(JSON.stringify(buildTerminalMuxReady()));
      },
      onTargetMessage: (ws) => {
        ws.send(JSON.stringify({ type: 'sessions', payload: { sessions: ['legacy'] } }));
      },
    });
    const { fetchTmuxSessions } = await import('./tmux-sessions');

    await expect(fetchTmuxSessions(buildTarget(port), bridgeSettings)).rejects.toThrow('Invalid tmux mux server frame');
    await waitForCondition(() => serverCloses.length === 1);
  });

  it('returns daemon-owned catalog through the public consumer', async () => {
    const { port } = await startConsumerServer({
      onHello: (ws) => {
        ws.send(JSON.stringify(buildTerminalMuxReady()));
      },
      onTargetMessage: (ws, frame) => {
        if (!isTerminalMuxClientFrame(frame) || frame.type !== 'mux-target-message') return;
        ws.send(JSON.stringify(buildTerminalMuxServerTargetMessage({
          type: 'sessions',
          payload: {
            sessions: ['zterm'],
            sessionCatalog: [{ name: 'zterm', backend: 'tmux' }],
          },
        }, frame.payload.requestId)));
      },
    });
    const { fetchTmuxSessionCatalog } = await import('./tmux-sessions');

    await expect(fetchTmuxSessionCatalog(buildTarget(port), bridgeSettings)).resolves.toEqual({
      sessionNames: ['zterm'],
      sessionCatalog: [{ name: 'zterm', backend: 'tmux' }],
    });
  });
});
