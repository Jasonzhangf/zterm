import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket as WsType } from 'ws';
import { APP_PROTOCOL_VERSION, type AppServerFrame } from '../../shared/src/connection/app-protocol.js';
import { APP_CAPABILITIES } from '../../shared/src/connection/app-protocol.js';
import { AppClientConnection } from './app-connection.js';
import type { LocalAppDaemonConfig } from './app-target-resolution.js';

const config: LocalAppDaemonConfig = {
  host: '127.0.0.1',
  port: 9999,
  authToken: 'token',
  deviceId: 'device-local',
  daemonHostId: 'daemon-local',
  configPath: '/tmp/config.json',
};

class FakeWebSocket extends EventEmitter {
  readyState: number = 0;
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  terminated = false;

  constructor(private readonly autoOpen = true) {
    super();
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
    this.sent.push(frame);
    if (frame.type === 'app-hello') {
      queueMicrotask(() => this.receive({
        type: 'app-ready',
        payload: {
          requestId: frame.payload.requestId as string,
          protocolVersion: APP_PROTOCOL_VERSION,
          deviceId: 'device-local',
          daemonHostId: 'daemon-local',
          capabilities: APP_CAPABILITIES,
        },
      }));
    }
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  close() {
    this.readyState = 3;
  }

  receive(frame: AppServerFrame) {
    this.emit('message', JSON.stringify(frame), false);
  }

  receiveRaw(raw: string) {
    this.emit('message', raw, false);
  }

  dropConnection(code: number, reason: string) {
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  rejectUpgrade(statusCode: number) {
    const response = { statusCode, resumed: false, resume() { this.resumed = true; } };
    this.emit('unexpected-response', {}, response);
    return response;
  }
}

describe('AppClientConnection', () => {
  it('surfaces an unrequested app-error and the physical close as events', async () => {
    const events: AppServerFrame[] = [];
    const socket = new FakeWebSocket();
    const connection = await AppClientConnection.connect({
      config,
      onEvent: (frame) => events.push(frame),
      createWebSocket: () => socket as unknown as WsType,
    });
    socket.receive({ type: 'app-error', payload: { code: 'slow_consumer', stage: 'publish', message: 'slow consumer' } });
    socket.dropConnection(4008, 'slow_consumer');
    await Promise.resolve();

    expect(events.some((frame) => frame.type === 'app-error')).toBe(true);
    const disconnected = events.find((frame) => frame.type === 'app-connection-state');
    expect(disconnected).toMatchObject({ payload: { state: 'disconnected', code: 4008, reason: 'slow_consumer' } });
    expect(connection.ready.daemonHostId).toBe('daemon-local');
  });

  it('rejects pending requests on an invalid frame instead of silently dropping', async () => {
    const socket = new FakeWebSocket();
    const connection = await AppClientConnection.connect({
      config,
      createWebSocket: () => socket as unknown as WsType,
    });
    const pending = connection.request({ type: 'app-ping', payload: { requestId: 'ping-1', sentAt: Date.now() } });
    socket.receiveRaw('null');

    await expect(pending).rejects.toMatchObject({ code: 'invalid_frame' });
  });

  it('rejects connect on a 401 upgrade instead of hanging', async () => {
    const socket = new FakeWebSocket(false);
    const pending = AppClientConnection.connect({
      config,
      requestTimeoutMs: 5_000,
      createWebSocket: () => socket as unknown as WsType,
    });
    queueMicrotask(() => socket.rejectUpgrade(401));

    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
    expect(socket.terminated).toBe(true);
  });
});
