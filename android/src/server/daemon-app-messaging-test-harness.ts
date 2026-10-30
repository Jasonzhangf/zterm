import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import type { AppClientFrame, AppServerFrame } from '@zterm/shared/app-protocol';
import {
  createDaemonAppMessagingRuntime,
  type AppLink,
  type DaemonAppMessagingRuntime,
} from './daemon-app-messaging-runtime';

type Listener = (...args: unknown[]) => void;

/**
 * In-memory WebSocket stand-in for the peer transport. It reproduces the
 * gateway wire behaviour (frames travel as JSON text between two daemons)
 * without opening a listening socket, so these tests run in sandboxed CI.
 */
export class FakeSocket {
  readyState = 1;
  peer!: FakeSocket;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener) {
    if (event === 'open' && this.readyState === 1) {
      queueMicrotask(() => listener());
      return this;
    }
    const wrapped: Listener = (...args) => {
      this.listeners.get(event)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  send(text: string, callback?: (error?: Error) => void) {
    queueMicrotask(() => {
      this.peer.emit('message', Buffer.from(text, 'utf8'), false);
      callback?.();
    });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emit('close', code, reason);
      this.peer.readyState = 3;
      this.peer.emit('close', code, reason);
    });
  }

  terminate() {
    this.close(1006, 'terminated');
  }
}

export function socketPair(): [FakeSocket, FakeSocket] {
  const left = new FakeSocket();
  const right = new FakeSocket();
  left.peer = right;
  right.peer = left;
  left.readyState = 1;
  return [left, right];
}

export type Bridge = {
  runtime: DaemonAppMessagingRuntime;
  appRootDir: string;
  deviceId: string;
  daemonHostId: string;
};

export function captureLink(role: 'local' | 'peer', deviceId: string, daemonHostId: string) {
  const frames: AppServerFrame[] = [];
  const closes: string[] = [];
  const link: AppLink = {
    id: `link-${randomUUID()}`,
    role,
    deviceId,
    daemonHostId,
    send(frame) {
      frames.push(frame);
      return true;
    },
    close(reason) {
      closes.push(reason);
    },
  };
  return { link, frames, closes };
}

/**
 * Bridges a peer transport to a daemon runtime the same way the gateway does:
 * answer `app-hello` once, then delegate every frame to `daemon.app_messaging`.
 */
export function attachPeerTransport(bridge: Bridge, socket: FakeSocket) {
  let link: AppLink | null = null;
  socket.on('message', (raw) => {
    const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as AppClientFrame;
    if (frame.type === 'app-hello') {
      link = {
        id: `peer-${randomUUID()}`,
        role: 'peer',
        deviceId: frame.payload.deviceId,
        daemonHostId: frame.payload.daemonHostId,
        send(serverFrame) {
          socket.send(JSON.stringify(serverFrame));
          return true;
        },
        close(reason) {
          socket.close(1000, reason);
        },
      };
      socket.send(JSON.stringify({
        type: 'app-ready',
        payload: {
          requestId: frame.payload.requestId,
          protocolVersion: 1,
          deviceId: bridge.deviceId,
          daemonHostId: bridge.daemonHostId,
          capabilities: {},
        },
      }));
      return;
    }
    if (link) void bridge.runtime.handleFrame(link, frame);
  });
}

export async function createBridge(options: {
  root: string;
  deviceId: string;
  daemonHostId: string;
  maxInboxRecords?: number;
  maxInboxBytes?: number;
  retentionMs?: number;
  peerRequestTimeoutMs?: number;
  createWebSocket?: (url: string, token: string) => WebSocket;
}) {
  const runtime = createDaemonAppMessagingRuntime({
    appRootDir: join(options.root, 'app'),
    deviceId: options.deviceId,
    daemonHostId: options.daemonHostId,
    ...(options.maxInboxRecords === undefined ? {} : { maxInboxRecords: options.maxInboxRecords }),
    ...(options.maxInboxBytes === undefined ? {} : { maxInboxBytes: options.maxInboxBytes }),
    ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    peerRequestTimeoutMs: options.peerRequestTimeoutMs ?? 2_000,
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
  });
  await runtime.initialize();
  return {
    runtime,
    appRootDir: join(options.root, 'app'),
    deviceId: options.deviceId,
    daemonHostId: options.daemonHostId,
  } satisfies Bridge;
}

export function peerTarget(bridge: Bridge) {
  return {
    deviceId: bridge.deviceId,
    daemonHostId: bridge.daemonHostId,
    wsUrl: `ws://in-memory/${bridge.daemonHostId}`,
    authToken: 'test-token',
  };
}

export async function waitForFrames<T extends AppServerFrame>(
  frames: AppServerFrame[],
  predicate: (frame: AppServerFrame) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found as T;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`frame not observed: ${JSON.stringify(frames)}`);
}

export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function tempRootRegistry() {
  const roots: string[] = [];
  return {
    async root(prefix = 'zterm-app-') {
      const root = await mkdtemp(join(tmpdir(), prefix));
      roots.push(root);
      return root;
    },
    async cleanup() {
      for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
