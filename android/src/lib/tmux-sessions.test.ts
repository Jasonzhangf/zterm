// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTerminalMuxReady,
  buildTerminalMuxServerTargetMessage,
  isTerminalMuxClientFrame,
} from '@zterm/shared/protocol';
import type { BridgeSettings } from './bridge-settings';

const traversalHarness = vi.hoisted(() => {
  class MockTraversalSocket {
    static instances: MockTraversalSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
    readyState = MockTraversalSocket.CONNECTING;
    sent: string[] = [];
    closeCalls = 0;
    readonly diagnostics = { reason: 'mock transport error' };

    constructor(
      readonly target: unknown,
      readonly settings: unknown,
      readonly options: unknown,
    ) {
      MockTraversalSocket.instances.push(this);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = MockTraversalSocket.CLOSED;
      this.onclose?.();
    }

    getDiagnostics() {
      return this.diagnostics;
    }

    triggerOpen() {
      this.readyState = MockTraversalSocket.OPEN;
      this.onopen?.();
    }

    triggerMuxReady() {
      this.onmessage?.({ data: JSON.stringify(buildTerminalMuxReady()) });
    }

    triggerSessions(sessions: string[], requestId = this.latestRequestId()) {
      this.onmessage?.({
        data: JSON.stringify(buildTerminalMuxServerTargetMessage({ type: 'sessions', payload: { sessions } }, requestId)),
      });
    }

    triggerSessionActivity(requestId = this.latestRequestId()) {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'mux-target-message',
          payload: {
            requestId,
            message: {
              type: 'session-activity',
              payload: { sessions: [] },
            },
          },
        }),
      });
    }

    triggerError(message: string, requestId = this.latestRequestId()) {
      this.onmessage?.({
        data: JSON.stringify(buildTerminalMuxServerTargetMessage({ type: 'error', payload: { message } }, requestId)),
      });
    }

    latestRequestId() {
      const frame = JSON.parse(this.sent[this.sent.length - 1] || 'null') as unknown;
      if (!isTerminalMuxClientFrame(frame) || frame.type !== 'mux-target-message') {
        throw new Error('latest mock frame is not a mux target request');
      }
      return frame.payload.requestId;
    }

    triggerTransportError() {
      this.readyState = MockTraversalSocket.CLOSED;
      this.onerror?.();
    }

    triggerClose(reason?: string) {
      this.readyState = MockTraversalSocket.CLOSED;
      this.onclose?.({ code: 1006, reason });
    }

    static latest() {
      const instance = MockTraversalSocket.instances[MockTraversalSocket.instances.length - 1];
      if (!instance) {
        throw new Error('no traversal socket instance');
      }
      return instance;
    }

    static reset() {
      MockTraversalSocket.instances = [];
    }
  }

  return { MockTraversalSocket };
});

vi.mock('./traversal/socket', () => ({
  TraversalSocket: traversalHarness.MockTraversalSocket,
}));

const bridgeSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'> = {
  signalUrl: 'https://signal.example.com',
  turnServerUrl: 'turn:relay.example.com',
  turnUsername: 'turn-user',
  turnCredential: 'turn-pass',
  transportMode: 'auto',
  traversalRelay: undefined,
};

const target = {
  bridgeHost: '100.64.0.10',
  bridgePort: 3333,
  authToken: 'token-a',
};

async function loadTmuxSessionsModule() {
  const module = await import('./tmux-sessions');
  module.resetTmuxSessionTransportPoolForTests();
  return module;
}

describe('tmux-sessions transport contract', () => {
  beforeEach(() => {
    traversalHarness.MockTraversalSocket.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests tmux session list over traversal transport', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'mux-hello' });
    socket.triggerMuxReady();
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'list-sessions' } },
    });

    socket.triggerSessions(['main', 'logs']);
    await expect(promise).resolves.toEqual(['main', 'logs']);
    expect(socket.closeCalls).toBe(0);
  });

  it('sends create / rename / kill tmux operations with the exact request payloads', async () => {
    const { createTmuxSession, renameTmuxSession, killTmuxSession } = await loadTmuxSessionsModule();

    const createPromise = createTmuxSession(target, bridgeSettings, 'new-tab');
    const createSocket = traversalHarness.MockTraversalSocket.latest();
    createSocket.triggerOpen();
    createSocket.triggerMuxReady();
    expect(JSON.parse(createSocket.sent[1]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'tmux-create-session', payload: { sessionName: 'new-tab' } } },
    });
    createSocket.triggerSessions(['new-tab']);
    await expect(createPromise).resolves.toEqual(['new-tab']);

    const createWithCwdPromise = createTmuxSession(target, bridgeSettings, 'work-api', { cwd: '~/code/api' });
    const createWithCwdSocket = traversalHarness.MockTraversalSocket.latest();
    expect(createWithCwdSocket).toBe(createSocket);
    expect(JSON.parse(createWithCwdSocket.sent[2]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'tmux-create-session', payload: { sessionName: 'work-api', cwd: '~/code/api' } } },
    });
    createWithCwdSocket.triggerSessions(['work-api']);
    await expect(createWithCwdPromise).resolves.toEqual(['work-api']);

    const renamePromise = renameTmuxSession(target, bridgeSettings, 'new-tab', 'renamed-tab');
    const renameSocket = traversalHarness.MockTraversalSocket.latest();
    expect(renameSocket).toBe(createSocket);
    expect(JSON.parse(renameSocket.sent[3]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'tmux-rename-session', payload: { sessionName: 'new-tab', nextSessionName: 'renamed-tab' } } },
    });
    renameSocket.triggerSessions(['renamed-tab']);
    await expect(renamePromise).resolves.toEqual(['renamed-tab']);

    const killPromise = killTmuxSession(target, bridgeSettings, 'renamed-tab');
    const killSocket = traversalHarness.MockTraversalSocket.latest();
    expect(killSocket).toBe(createSocket);
    expect(JSON.parse(killSocket.sent[4]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'tmux-kill-session', payload: { sessionName: 'renamed-tab' } } },
    });
    killSocket.triggerSessions([]);
    await expect(killPromise).resolves.toEqual([]);
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(1);
    expect(createSocket.closeCalls).toBe(0);
  });

  it('surfaces daemon-side tmux management errors explicitly', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.triggerError('cannot list tmux sessions');

    await expect(promise).rejects.toThrow('cannot list tmux sessions');
  });

  it('surfaces transport errors explicitly without silent fallback', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerTransportError();

    await expect(promise).rejects.toThrow('mock transport error');
  });

  it('surfaces traversal close diagnostics instead of a generic tmux management close', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();
    socket.diagnostics.reason = 'No traversal path succeeded';

    socket.triggerClose('No traversal path succeeded');

    await expect(promise).rejects.toThrow('No traversal path succeeded');
  });

  it('reuses one open traversal transport for sequential tmux session list requests on the same target', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();
    socket.triggerOpen();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'mux-hello' });
    socket.triggerMuxReady();
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'list-sessions' } },
    });
    socket.triggerSessions(['first']);
    await expect(first).resolves.toEqual(['first']);

    const second = fetchTmuxSessions(target, bridgeSettings);
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(1);
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      type: 'mux-target-message',
      payload: { message: { type: 'list-sessions' } },
    });
    socket.triggerSessions(['second']);
    await expect(second).resolves.toEqual(['second']);
    expect(socket.closeCalls).toBe(0);
  });

  it('serializes concurrent tmux management requests on one target transport', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const second = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);
    socket.triggerMuxReady();
    expect(socket.sent).toHaveLength(2);

    socket.triggerSessions(['first']);
    await expect(first).resolves.toEqual(['first']);
    expect(socket.sent).toHaveLength(3);

    socket.triggerSessions(['second']);
    await expect(second).resolves.toEqual(['second']);
  });

  it('ignores session-activity companion frames after list-sessions responses', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const second = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    const firstRequestId = socket.latestRequestId();
    socket.triggerSessions(['first'], firstRequestId);
    await expect(first).resolves.toEqual(['first']);
    expect(socket.sent).toHaveLength(3);

    socket.triggerSessionActivity(firstRequestId);
    expect(socket.closeCalls).toBe(0);

    socket.triggerSessions(['second']);
    await expect(second).resolves.toEqual(['second']);
    expect(socket.closeCalls).toBe(0);
  });

  it('opens a separate traversal transport for a different target key', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const firstSocket = traversalHarness.MockTraversalSocket.latest();
    firstSocket.triggerOpen();
    firstSocket.triggerMuxReady();
    firstSocket.triggerSessions(['first']);
    await expect(first).resolves.toEqual(['first']);

    const second = fetchTmuxSessions({ ...target, bridgeHost: '100.64.0.11' }, bridgeSettings);
    const secondSocket = traversalHarness.MockTraversalSocket.latest();
    expect(secondSocket).not.toBe(firstSocket);
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(2);
    secondSocket.triggerOpen();
    secondSocket.triggerMuxReady();
    secondSocket.triggerSessions(['second']);
    await expect(second).resolves.toEqual(['second']);
  });

  it('drops the pooled traversal transport after a physical transport error', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const firstSocket = traversalHarness.MockTraversalSocket.latest();
    firstSocket.triggerOpen();
    firstSocket.triggerTransportError();
    await expect(first).rejects.toThrow('mock transport error');

    const second = fetchTmuxSessions(target, bridgeSettings);
    const secondSocket = traversalHarness.MockTraversalSocket.latest();
    expect(secondSocket).not.toBe(firstSocket);
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(2);
    secondSocket.triggerOpen();
    secondSocket.triggerMuxReady();
    secondSocket.triggerSessions(['second']);
    await expect(second).resolves.toEqual(['second']);
  });

  it('keeps request-level daemon errors explicit while preserving the healthy transport', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();

    const first = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();
    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.triggerError('cannot list tmux sessions');
    await expect(first).rejects.toThrow('cannot list tmux sessions');

    const second = fetchTmuxSessions(target, bridgeSettings);
    expect(traversalHarness.MockTraversalSocket.instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(3);
    socket.triggerSessions(['recovered']);
    await expect(second).resolves.toEqual(['recovered']);
  });

  it('rejects a legacy unwrapped sessions response and discards the transport', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.onmessage?.({ data: JSON.stringify({ type: 'sessions', payload: { sessions: ['legacy'] } }) });

    await expect(promise).rejects.toThrow('Invalid tmux mux server frame');
    expect(socket.closeCalls).toBe(1);
  });

  it('rejects a target response whose request id does not match the active request', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.triggerSessions(['wrong'], 'different-request');

    await expect(promise).rejects.toThrow('Mismatched tmux control request id');
    expect(socket.closeCalls).toBe(1);
  });

  it('rejects channel traffic on the target-management transport', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'mux-channel-message',
        payload: { channelId: 'channel-1', message: { type: 'sessions', payload: { sessions: ['wrong-owner'] } } },
      }),
    });

    await expect(promise).rejects.toThrow('Unexpected tmux mux server frame type');
    expect(socket.closeCalls).toBe(1);
  });

  it('rejects a duplicate mux-ready after negotiation completes', async () => {
    const { fetchTmuxSessions } = await loadTmuxSessionsModule();
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerMuxReady();
    socket.triggerMuxReady();

    await expect(promise).rejects.toThrow('Unexpected duplicate tmux mux-ready');
    expect(socket.closeCalls).toBe(1);
  });
});
