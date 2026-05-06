// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSettings } from './bridge-settings';

const traversalHarness = vi.hoisted(() => {
  class MockTraversalSocket {
    static instances: MockTraversalSocket[] = [];

    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: string[] = [];
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
      this.onclose?.();
    }

    getDiagnostics() {
      return this.diagnostics;
    }

    triggerOpen() {
      this.onopen?.();
    }

    triggerSessions(sessions: string[]) {
      this.onmessage?.({ data: JSON.stringify({ type: 'sessions', payload: { sessions } }) });
    }

    triggerError(message: string) {
      this.onmessage?.({ data: JSON.stringify({ type: 'error', payload: { message } }) });
    }

    triggerTransportError() {
      this.onerror?.();
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

describe('tmux-sessions transport contract', () => {
  beforeEach(() => {
    traversalHarness.MockTraversalSocket.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests tmux session list over traversal transport', async () => {
    const { fetchTmuxSessions } = await import('./tmux-sessions');
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'list-sessions' })]);

    socket.triggerSessions(['main', 'logs']);
    await expect(promise).resolves.toEqual(['main', 'logs']);
  });

  it('sends create / rename / kill tmux operations with the exact request payloads', async () => {
    const { createTmuxSession, renameTmuxSession, killTmuxSession } = await import('./tmux-sessions');

    const createPromise = createTmuxSession(target, bridgeSettings, 'new-tab');
    const createSocket = traversalHarness.MockTraversalSocket.latest();
    createSocket.triggerOpen();
    expect(createSocket.sent).toEqual([
      JSON.stringify({ type: 'tmux-create-session', payload: { sessionName: 'new-tab' } }),
    ]);
    createSocket.triggerSessions(['new-tab']);
    await expect(createPromise).resolves.toEqual(['new-tab']);

    const renamePromise = renameTmuxSession(target, bridgeSettings, 'new-tab', 'renamed-tab');
    const renameSocket = traversalHarness.MockTraversalSocket.latest();
    renameSocket.triggerOpen();
    expect(renameSocket.sent).toEqual([
      JSON.stringify({ type: 'tmux-rename-session', payload: { sessionName: 'new-tab', nextSessionName: 'renamed-tab' } }),
    ]);
    renameSocket.triggerSessions(['renamed-tab']);
    await expect(renamePromise).resolves.toEqual(['renamed-tab']);

    const killPromise = killTmuxSession(target, bridgeSettings, 'renamed-tab');
    const killSocket = traversalHarness.MockTraversalSocket.latest();
    killSocket.triggerOpen();
    expect(killSocket.sent).toEqual([
      JSON.stringify({ type: 'tmux-kill-session', payload: { sessionName: 'renamed-tab' } }),
    ]);
    killSocket.triggerSessions([]);
    await expect(killPromise).resolves.toEqual([]);
  });

  it('surfaces daemon-side tmux management errors explicitly', async () => {
    const { fetchTmuxSessions } = await import('./tmux-sessions');
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerOpen();
    socket.triggerError('cannot list tmux sessions');

    await expect(promise).rejects.toThrow('cannot list tmux sessions');
  });

  it('surfaces transport errors explicitly without silent fallback', async () => {
    const { fetchTmuxSessions } = await import('./tmux-sessions');
    const promise = fetchTmuxSessions(target, bridgeSettings);
    const socket = traversalHarness.MockTraversalSocket.latest();

    socket.triggerTransportError();

    await expect(promise).rejects.toThrow('mock transport error');
  });
});
