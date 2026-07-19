import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWindowMessageRuntime,
  isRemoteWindowControlMessage,
} from './remote-window-message-runtime';
import type { ServerMessage } from './types';

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
}

describe('remote window message runtime', () => {
  it('sends a catalog request and resolves the matching response', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 42,
      setTimeoutFn: vi.fn(() => 7) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      sendSocketPayload,
    });
    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent).toMatchObject({
      type: 'remote-window-targets-request',
      payload: {
        requestId: expect.stringMatching(/^rw-42-/),
        includeAppWindows: true,
        includeIterm2: true,
      },
    });

    runtime.handleTargetsResponse({
      requestId: sent.payload.requestId,
      targets: [],
      errors: [{
        requestId: sent.payload.requestId,
        code: 'iterm2_api_unavailable',
        message: 'iTerm2 API unavailable',
      }],
    });

    await expect(request).resolves.toMatchObject({
      requestId: sent.payload.requestId,
      targets: [],
      errors: [{ code: 'iterm2_api_unavailable' }],
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('rejects explicit daemon catalog errors', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 43,
      setTimeoutFn: vi.fn(() => 8) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      request: { includeAppWindows: false, includeIterm2: true },
      sendSocketPayload,
    });
    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent.payload.includeAppWindows).toBe(false);

    runtime.handleError({
      requestId: sent.payload.requestId,
      code: 'screen_recording_permission_missing',
      message: 'Screen Recording permission missing',
    });

    await expect(request).rejects.toMatchObject({
      name: 'screen_recording_permission_missing',
      message: 'Screen Recording permission missing',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('times out requests without pretending an empty catalog is success', async () => {
    const timeoutHandlers: Array<() => void> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 44,
      setTimeoutFn: vi.fn((handler) => {
        timeoutHandlers.push(handler as () => void);
        return 9;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      sendSocketPayload: vi.fn(),
    });

    timeoutHandlers[0]?.();

    await expect(request).rejects.toThrow('Remote window target catalog timed out');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('classifies only remote window control messages', () => {
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-error',
      payload: { requestId: 'rw-1', code: 'x', message: 'x' },
    } as ServerMessage)).toBe(true);
    expect(isRemoteWindowControlMessage({
      type: 'remote-screenshot-status',
      payload: { requestId: 'rs-1', phase: 'capturing' },
    } as ServerMessage)).toBe(false);
  });
});
