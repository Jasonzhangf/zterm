import { describe, expect, it, vi } from 'vitest';
import {
  requestRemoteWindowTargetsRuntime,
  resolveRemoteWindowCatalogTransport,
} from './session-context-remote-window-runtime';

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
  const baseSession = {
    id: 'session-1',
    state: 'connected',
  } as any;

  it('reuses the open session transport owner before requesting the target catalog', async () => {
    const ws = makeSocket();
    const readSessionTransportSocket = vi.fn(() => ws);
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [],
      errors: [],
    }));
    const sendSocketPayload = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: ' session-1 ',
      sessions: [baseSession],
      readSessionTransportSocket,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload,
    })).resolves.toMatchObject({ requestId: 'rw-1' });

    expect(readSessionTransportSocket).toHaveBeenCalledWith('session-1');
    expect(requestTargets).toHaveBeenCalledWith('session-1', {
      ws,
      sendSocketPayload,
    });
  });

  it('allows target catalog over an open socket while session status is still connecting', async () => {
    const ws = makeSocket();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-connecting',
      targets: [],
      errors: [],
    }));

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting' }],
      readSessionTransportSocket: () => ws,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).resolves.toMatchObject({ requestId: 'rw-connecting' });

    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing session id before touching transport state', async () => {
    const readSessionTransportSocket = vi.fn();
    const requestTargets = vi.fn();

    await expect(requestRemoteWindowTargetsRuntime({
      sessionId: '   ',
      sessions: [baseSession],
      readSessionTransportSocket,
      remoteWindowMessageRuntime: { requestTargets },
      sendSocketPayload: vi.fn(),
    })).rejects.toThrow('No target session for remote window catalog');

    expect(readSessionTransportSocket).not.toHaveBeenCalled();
    expect(requestTargets).not.toHaveBeenCalled();
  });

  it('rejects catalog requests without reusing the paste ready error when no socket is open', () => {
    expect(() => resolveRemoteWindowCatalogTransport({
      sessionId: 'session-1',
      sessions: [{ ...baseSession, state: 'connecting' }],
      readSessionTransportSocket: () => ({ ...makeSocket(), readyState: WebSocket.CLOSED }),
    })).toThrow('Remote window catalog transport is not open (session=connecting, socket=closed)');
  });
});
