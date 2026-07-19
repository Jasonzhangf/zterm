import { describe, expect, it, vi } from 'vitest';
import { requestRemoteWindowTargetsRuntime } from './session-context-remote-window-runtime';

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
}

describe('session context remote window runtime', () => {
  it('reuses the session transport owner before requesting the target catalog', async () => {
    const ws = makeSocket();
    const ensureSessionReady = vi.fn(async () => ws);
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [],
      errors: [],
    }));
    const sendSocketPayload = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: ' session-1 ',
      ensureSessionReady,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
    })).resolves.toMatchObject({ requestId: 'rw-1' });

    expect(ensureSessionReady).toHaveBeenCalledWith('session-1');
    expect(requestTargets).toHaveBeenCalledWith('session-1', {
      ws,
      sendSocketPayload,
    });
  });

  it('rejects a missing session id before touching transport state', async () => {
    const ensureSessionReady = vi.fn();
    const requestTargets = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: '   ',
      ensureSessionReady,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('No target session for remote window catalog');

    expect(ensureSessionReady).not.toHaveBeenCalled();
    expect(requestTargets).not.toHaveBeenCalled();
  });
});
