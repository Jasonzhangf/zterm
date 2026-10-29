import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_MAX_MESSAGE_BYTES,
  AppProtocolError,
  assertAppProtocolVersion,
  encodeAppPathSegment,
  type AppClientFrame,
  type AppHelloPayload,
  type AppServerFrame,
} from '@zterm/shared/app-protocol';
import {
  assertDaemonAppHelloAdmission,
  createDaemonAppGateway,
} from './daemon-app-websocket-runtime';
import type {
  AppLink,
  DaemonAppMessagingRuntime,
} from './daemon-app-messaging-runtime';
import { createDaemonAppMessagingRuntime } from './daemon-app-messaging-runtime';

function hello(overrides: Partial<AppHelloPayload> = {}): AppHelloPayload {
  return {
    protocolVersion: assertAppProtocolVersion(1),
    requestId: `hello-${Math.random()}`,
    role: 'local',
    clientInstanceId: 'test-client',
    deviceId: 'device-b',
    daemonHostId: 'daemon-b',
    capabilities: {},
    ...overrides,
  };
}

function fakeMessaging(): DaemonAppMessagingRuntime {
  return {
    initialize: async () => undefined,
    dispose: () => undefined,
    getInitializationError: () => null,
    getCapabilities: () => ({}) as never,
    getIdentity: () => ({ deviceId: 'device-b', daemonHostId: 'daemon-b' }),
    handleFrame: async () => ({ settled: false }),
    subscribeLocal: async () => undefined,
    revokeLink: () => undefined,
  };
}

function upgradeRequest(url: string, authorization?: string): IncomingMessage {
  return {
    url,
    headers: authorization ? { authorization } : {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function fakeSocket() {
  const writes: string[] = [];
  let destroyed = false;
  const socket = {
    write(value: string) {
      writes.push(value);
      return true;
    },
    destroy() {
      destroyed = true;
    },
  };
  return {
    socket: socket as unknown as Duplex,
    writes,
    destroyed: () => destroyed,
  };
}

type GatewayHarness = {
  socket: FakeGatewaySocket;
  link: AppLink;
  frames: AppServerFrame[];
  handledFrames: AppClientFrame[];
  closeEvents: Array<{ code: number; reason: string }>;
  waitForMessages: (messageIds: string[], timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
};

const harnesses = new Set<GatewayHarness>();

afterEach(async () => {
  for (const harness of [...harnesses]) {
    await harness.close();
  }
  vi.restoreAllMocks();
});

class FakeGatewaySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: AppServerFrame[] = [];
  readonly closeEvents: Array<{ code: number; reason: string }> = [];

  send(raw: string, callback?: (error?: Error) => void) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.frames.push(JSON.parse(raw) as AppServerFrame);
    queueMicrotask(() => callback?.());
  }

  receive(frame: AppClientFrame) {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'), false);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.closeEvents.push({ code, reason });
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', code, reason);
    });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not observed');
}

async function openGatewayHarness(options: {
  slowConsumerGraceMs: number;
  runtime?: DaemonAppMessagingRuntime;
}): Promise<GatewayHarness> {
  const socket = new FakeGatewaySocket();
  vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation((_request, _socket, _head, callback) => {
    callback(socket as unknown as WebSocket, _request);
  });
  const frames = socket.frames;
  const handledFrames: AppClientFrame[] = [];
  const closeEvents = socket.closeEvents;
  let resolveLink!: (link: AppLink) => void;
  const linkReady = new Promise<AppLink>((resolve) => {
    resolveLink = resolve;
  });
  const baseMessaging = options.runtime ?? fakeMessaging();
  const messaging: DaemonAppMessagingRuntime = {
    ...baseMessaging,
    handleFrame: async (link, frame) => {
      handledFrames.push(frame);
      if (options.runtime) return options.runtime.handleFrame(link, frame);
      // Simulate a successful settlement for ack/consume so the gateway
      // clears pending and updates ACK progress. When a test supplies a
      // runtime that returns settled=false, the gateway must not clear.
      if (frame.type === 'app-ack' || frame.type === 'app-consume') {
        return { settled: true, messageId: frame.payload.messageId, senderDaemonHostId: frame.payload.senderDaemonHostId };
      }
      return { settled: false };
    },
    subscribeLocal: async (link) => {
      resolveLink(link);
      if (options.runtime) await options.runtime.subscribeLocal(link);
    },
  };
  const gateway = createDaemonAppGateway({
    requiredAuthToken: 'gateway-token',
    daemonHostId: 'daemon-b',
    deviceId: 'device-b',
    messaging,
    slowConsumerGraceMs: options.slowConsumerGraceMs,
  });
  const rejected = fakeSocket();
  expect(gateway.handleServerUpgrade(
    upgradeRequest('/app', 'Bearer gateway-token'),
    rejected.socket,
    Buffer.alloc(0),
  )).toBe(true);
  socket.receive({ type: 'app-hello', payload: hello() });
  await waitUntil(() => frames.some((frame) => frame.type === 'app-ready'));
  const link = await linkReady;

  let closed = false;
  const harness: GatewayHarness = {
    socket,
    link,
    frames,
    handledFrames,
    closeEvents,
    async waitForMessages(messageIds, timeoutMs = 1_500) {
      await waitUntil(
        () => messageIds.every((messageId) => frames.some(
          (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === messageId,
        )),
        timeoutMs,
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      harnesses.delete(harness);
      gateway.dispose();
    },
  };
  harnesses.add(harness);
  return harness;
}

function sendInboundMessage(harness: GatewayHarness, messageId: string, bytes = APP_MAX_MESSAGE_BYTES, senderDaemonHostId = 'daemon-a') {
  if (!harness.link.send({
    type: 'app-inbound-message',
    payload: {
      messageId,
      senderDeviceId: 'device-a',
      senderDaemonHostId,
      receiverDeviceId: 'device-b',
      receiverDaemonHostId: 'daemon-b',
      subject: 'slow consumer test',
      body: 'x'.repeat(bytes),
      state: 'received',
      receivedAt: new Date().toISOString(),
    },
  })) {
    throw new Error('inbound message was not enqueued');
  }
}

async function sendInboundMessages(harness: GatewayHarness, messageIds: string[]) {
  for (const messageId of messageIds) {
    sendInboundMessage(harness, messageId);
    await Promise.resolve();
  }
}

function sendClientFrame(harness: GatewayHarness, frame: AppClientFrame) {
  harness.socket.receive(frame);
}

describe('daemon app hello admission', () => {
  it('rejects local identity mismatch and non-loopback local role', () => {
    let mismatch: unknown;
    try {
      assertDaemonAppHelloAdmission({
        hello: hello({ deviceId: 'device-x' }),
        deviceId: 'device-b',
        daemonHostId: 'daemon-b',
        remoteLoopback: true,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(AppProtocolError);
    expect((mismatch as AppProtocolError).code).toBe('forbidden_role');

    let nonLoopback: unknown;
    try {
      assertDaemonAppHelloAdmission({
        hello: hello(),
        deviceId: 'device-b',
        daemonHostId: 'daemon-b',
        remoteLoopback: false,
      });
    } catch (error) {
      nonLoopback = error;
    }
    expect((nonLoopback as AppProtocolError).code).toBe('forbidden_role');
    expect((nonLoopback as AppProtocolError).message).toContain('loopback');
  });

  it('returns a typed missing identity error when daemon identity is unset', () => {
    let error: unknown;
    try {
      assertDaemonAppHelloAdmission({
        hello: hello({ role: 'peer' }),
        deviceId: '',
        daemonHostId: '',
        remoteLoopback: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppProtocolError);
    expect((error as AppProtocolError).code).toBe('missing_identity');
  });

  it('admits a matching local hello and a peer hello', () => {
    expect(() => assertDaemonAppHelloAdmission({
      hello: hello(),
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      remoteLoopback: true,
    })).not.toThrow();
    expect(() => assertDaemonAppHelloAdmission({
      hello: hello({ role: 'peer', deviceId: 'device-a', daemonHostId: 'daemon-a' }),
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
      remoteLoopback: false,
    })).not.toThrow();
  });
});

describe('daemon app gateway upgrade boundary', () => {
  const gateway = createDaemonAppGateway({
    requiredAuthToken: 'gateway-token',
    daemonHostId: 'daemon-b',
    deviceId: 'device-b',
    messaging: fakeMessaging(),
  });

  it('rejects /app without a matching bearer token before WebSocket upgrade', () => {
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const fake = fakeSocket();
      expect(gateway.handleServerUpgrade(upgradeRequest('/app', authorization), fake.socket, Buffer.alloc(0))).toBe(true);
      expect(fake.writes.join('')).toContain('HTTP/1.1 401 Unauthorized');
      expect(fake.destroyed()).toBe(true);
    }
  });

  it('does not claim non-/app upgrade paths', () => {
    const fake = fakeSocket();
    expect(gateway.handleServerUpgrade(upgradeRequest('/ws', 'Bearer gateway-token'), fake.socket, Buffer.alloc(0))).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it('refuses /app when the daemon has no auth token', () => {
    const noAuth = createDaemonAppGateway({
      requiredAuthToken: '',
      daemonHostId: 'daemon-b',
      deviceId: 'device-b',
      messaging: fakeMessaging(),
    });
    const fake = fakeSocket();
    expect(noAuth.handleServerUpgrade(upgradeRequest('/app'), fake.socket, Buffer.alloc(0))).toBe(true);
    expect(fake.writes.join('')).toContain('HTTP/1.1 401 Unauthorized');
  });
});

describe('daemon app initialization isolation', () => {
  it('keeps /app unavailable with a storage error while messaging init failed', async () => {
    const socket = new FakeGatewaySocket();
    vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation((_request, _socket, _head, callback) => {
      callback(socket as unknown as WebSocket, _request);
    });
    const messaging: DaemonAppMessagingRuntime = {
      ...fakeMessaging(),
      getInitializationError: () => new Error('staging recovery failed'),
    };
    const gateway = createDaemonAppGateway({
      requiredAuthToken: 'gateway-token',
      daemonHostId: 'daemon-b',
      deviceId: 'device-b',
      messaging,
    });
    try {
      const rejected = fakeSocket();
      expect(gateway.handleServerUpgrade(upgradeRequest('/app', 'Bearer gateway-token'), rejected.socket, Buffer.alloc(0))).toBe(true);
      socket.receive({ type: 'app-hello', payload: hello() });
      await waitUntil(() => socket.closeEvents.length === 1);
      const error = socket.frames.find((frame) => frame.type === 'app-error');
      expect(error).toMatchObject({ type: 'app-error', payload: { code: 'storage_error' } });
      expect(socket.frames.some((frame) => frame.type === 'app-ready')).toBe(false);
      expect(socket.closeEvents[0]).toEqual({ code: 4003, reason: 'admission rejected' });
    } finally {
      gateway.dispose();
    }
  });
});

describe('daemon app application-level slow consumer', () => {
  it('closes a drained local stream after pending bytes stay over the limit for the grace period', async () => {
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 500 });
    const messageIds = Array.from({ length: 5 }, (_, index) => `slow-${index + 1}`);

    await sendInboundMessages(harness, messageIds);

    await harness.waitForMessages(messageIds);
    expect(harness.closeEvents).toHaveLength(0);

    await waitUntil(() => harness.closeEvents.length === 1, 1_500);
    expect(harness.closeEvents[0]).toEqual({ code: 4008, reason: 'slow_consumer' });
    const slowError = harness.frames.find(
      (frame): frame is Extract<AppServerFrame, { type: 'app-error' }> =>
        frame.type === 'app-error' && frame.payload.code === 'slow_consumer',
    );
    expect(slowError).toBeDefined();
  });

  it('keeps a stream open when ACK and consume progress stay below the limit', async () => {
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 200 });
    const messageId = 'healthy';

    sendInboundMessage(harness, messageId);
    await harness.waitForMessages([messageId]);

    sendClientFrame(harness, {
      type: 'app-ack',
      payload: { requestId: 'ack-healthy', messageId },
    });
    await waitUntil(() => harness.handledFrames.some((frame) => frame.type === 'app-ack'));
    sendClientFrame(harness, {
      type: 'app-consume',
      payload: { requestId: 'consume-healthy', messageId },
    });
    await waitUntil(() => harness.handledFrames.some((frame) => frame.type === 'app-consume'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.closeEvents).toHaveLength(0);
  });

  it('resets the closure condition on ACK while pending bytes remain over the limit', async () => {
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 400 });
    const messageIds = Array.from({ length: 5 }, (_, index) => `reset-${index + 1}`);

    await sendInboundMessages(harness, messageIds);
    await harness.waitForMessages(messageIds);
    await new Promise((resolve) => setTimeout(resolve, 150));

    sendClientFrame(harness, {
      type: 'app-ack',
      payload: { requestId: 'ack-reset-1', messageId: messageIds[0]! },
    });
    await waitUntil(() => harness.handledFrames.filter((frame) => frame.type === 'app-ack').length === 1);
    sendClientFrame(harness, {
      type: 'app-ack',
      payload: { requestId: 'ack-reset-2', messageId: messageIds[0]! },
    });
    await waitUntil(() => harness.handledFrames.filter((frame) => frame.type === 'app-ack').length === 2);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.closeEvents).toHaveLength(0);

    await waitUntil(() => harness.closeEvents.length === 1, 1_000);
    expect(harness.closeEvents[0]).toEqual({ code: 4008, reason: 'slow_consumer' });
  });

  it('does not clear pending when ack or consume settlement fails', async () => {
    const rejecting: DaemonAppMessagingRuntime = {
      ...fakeMessaging(),
      handleFrame: async () => ({ settled: false }),
    };
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 300, runtime: rejecting });
    const bytes = 1_000_000;
    const messageIds = Array.from({ length: 5 }, (_, index) => `reject-${index + 1}`);

    for (const messageId of messageIds) {
      sendInboundMessage(harness, messageId, bytes);
      await Promise.resolve();
    }
    await harness.waitForMessages(messageIds);

    for (let attempt = 0; attempt < 20 && harness.closeEvents.length === 0; attempt += 1) {
      sendClientFrame(harness, {
        type: 'app-consume',
        payload: { requestId: `reject-consume-${attempt}`, messageId: messageIds[0]!, senderDaemonHostId: 'daemon-a' },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await waitUntil(() => harness.closeEvents.length === 1, 1_500);
    expect(harness.closeEvents[0]).toEqual({ code: 4008, reason: 'slow_consumer' });
  });

  it('counts pending bytes per sender so a shared messageId does not dedupe', async () => {
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 300 });
    const bytes = 1_000_000;
    const messageIds = Array.from({ length: 4 }, (_, index) => `shared-${index + 1}`);

    for (const messageId of messageIds) {
      sendInboundMessage(harness, messageId, bytes);
      await Promise.resolve();
    }
    // A second sender reuses one messageId; the composite key must keep it.
    sendInboundMessage(harness, messageIds[0]!, bytes, 'daemon-c');
    await harness.waitForMessages([...messageIds, messageIds[0]!]);

    await waitUntil(() => harness.closeEvents.length === 1, 1_500);
    expect(harness.closeEvents[0]).toEqual({ code: 4008, reason: 'slow_consumer' });
  });

  it('keeps durable records after 4008 and replays them once to a fresh stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zterm-app-gateway-'));
    const runtime = createDaemonAppMessagingRuntime({
      appRootDir: join(root, 'app'),
      deviceId: 'device-b',
      daemonHostId: 'daemon-b',
    });
    await runtime.initialize();
    const harness = await openGatewayHarness({ slowConsumerGraceMs: 200, runtime });
    const messageIds = Array.from({ length: 5 }, (_, index) => `durable-${index + 1}`);
    const peerFrames: AppServerFrame[] = [];
    const peer: AppLink = {
      id: 'peer-test',
      role: 'peer',
      deviceId: 'device-a',
      daemonHostId: 'daemon-a',
      send: (frame) => {
        peerFrames.push(frame);
        return true;
      },
      close: () => undefined,
    };

    try {
      for (const [index, messageId] of messageIds.entries()) {
        await runtime.handleFrame(peer, {
          type: 'app-send-message',
          payload: {
            requestId: `send-${index + 1}`,
            messageId,
            subject: 'durable slow consumer',
            body: 'd'.repeat(APP_MAX_MESSAGE_BYTES),
          },
        });
      }
      await harness.waitForMessages(messageIds);
      await waitUntil(() => harness.closeEvents.length === 1, 1_500);
      expect(harness.closeEvents[0]).toEqual({ code: 4008, reason: 'slow_consumer' });

      for (const messageId of messageIds) {
        const recordPath = join(
          root,
          'app/app-inbox/records',
          encodeAppPathSegment('daemon-a'),
          `${encodeAppPathSegment(messageId)}.json`,
        );
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as { messageId: string; state: string };
        expect(record).toMatchObject({ messageId, state: 'received' });
      }

      const replayed: AppServerFrame[] = [];
      const fresh: AppLink = {
        id: `fresh-${randomUUID()}`,
        role: 'local',
        deviceId: 'device-b',
        daemonHostId: 'daemon-b',
        send: (frame) => {
          replayed.push(frame);
          return true;
        },
        close: () => undefined,
      };
      await runtime.subscribeLocal(fresh);
      for (const messageId of messageIds) {
        expect(replayed.filter(
          (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === messageId,
        )).toHaveLength(1);
      }
    } finally {
      await harness.close();
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
