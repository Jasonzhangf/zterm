import { describe, expect, it } from 'vitest';
import {
  createSessionTransportRuntimeStore,
  getSessionTransportRuntime,
  setSessionTargetTerminalMuxReady,
  setTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import { ensureSessionTerminalChannel } from '../lib/terminal-channel-mux-runtime';
import type { Host } from '../lib/types';
import { wrapSessionPayloadForTargetMuxRuntime } from './session-context-infra-facade-runtime';

function makeHost(overrides?: Partial<Host>): Host {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn',
    bridgeHost: '100.64.0.1',
    bridgePort: 3333,
    sessionName: 'alpha',
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function makeSocket(name: string) {
  return {
    name,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    close() {},
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

function createMuxStore() {
  const store = createSessionTransportRuntimeStore();
  upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
  const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
  const targetSocket = makeSocket('target-terminal');
  setTargetTerminalTransport(store, targetKey, targetSocket as any);
  ensureSessionTerminalChannel(store.terminalChannels, 'session-1', { channelId: 'channel-a' });
  setSessionTargetTerminalMuxReady(store, 'session-1', true);
  return { store, targetSocket };
}

function unwrap(data: string | ArrayBuffer) {
  expect(typeof data).toBe('string');
  return JSON.parse(data as string);
}

describe('wrapSessionPayloadForTargetMuxRuntime', () => {
  it('leaves non-target sockets unchanged', () => {
    const { store } = createMuxStore();
    const legacySocket = makeSocket('legacy-session');
    const data = JSON.stringify({ type: 'input', payload: 'pwd\r' });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: legacySocket as any,
      data,
    })).toBe(data);
  });

  it('wraps session-bound JSON messages in channel envelopes on the target mux socket', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'input', payload: 'echo alpha\r' }),
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: {
          type: 'input',
          payload: 'echo alpha\r',
        },
      },
    });
  });

  it('wraps binary chunks with the owning channel id', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: new TextEncoder().encode('image-chunk').buffer,
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'channel-a',
        dataBase64: 'aW1hZ2UtY2h1bms=',
      },
    });
  });

  it('maps target and close messages to mux target-level frames without rebuilding sockets', () => {
    const { store, targetSocket } = createMuxStore();

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'list-sessions' }),
    }))).toEqual({
      type: 'mux-target-message',
      payload: {
        message: { type: 'list-sessions' },
      },
    });

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'close' }),
    }))).toEqual({
      type: 'mux-channel-close',
      payload: {
        channelId: 'channel-a',
        reason: 'client requested channel close',
      },
    });
  });

  it('does not double-wrap existing mux frames and rejects legacy connect frames on target mux transport', () => {
    const { store, targetSocket } = createMuxStore();
    const muxHello = JSON.stringify({
      type: 'mux-hello',
      payload: { version: 1, clientInstanceId: 'session-1' },
    });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: muxHello,
    })).toBe(muxHello);

    expect(() => wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({
        type: 'connect',
        payload: {
          openRequestId: 'open-1',
          sessionTransportToken: 'token-1',
          sessionName: 'alpha',
        },
      }),
    })).toThrow(/legacy terminal message connect/);
  });
});
