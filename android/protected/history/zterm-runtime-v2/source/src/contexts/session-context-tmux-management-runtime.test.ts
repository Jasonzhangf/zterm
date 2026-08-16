import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  manageTmuxSessionsOnOpenTransportRuntime,
  queryTerminalSessionCatalogOnOpenTransportRuntime,
  settleSessionTmuxTargetRequestRuntime,
  type SessionTmuxTargetRequestStore,
} from './session-context-tmux-management-runtime';
import type { SessionTransportResource } from '../lib/session-transport-runtime';

function createResource(readyState = 1, terminalMuxReady = true): SessionTransportResource {
  const socket = { readyState };
  return {
    sessionId: 'session-1',
    runtime: null,
    targetRuntime: {
      key: 'target-1',
      daemonTargetId: 'target-1',
      routeCandidateKey: 'route-1',
      routeGeneration: 0,
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      authToken: '',
      controlTransport: null,
      terminalTransport: socket as any,
      terminalMuxReady,
      sessionIds: ['session-1'],
    },
    targetKey: 'target-1',
    host: null,
    socket: terminalMuxReady && readyState === 1 ? socket as any : null,
    socketReadyState: readyState,
    socketState: readyState === 1 ? 'open' : 'connecting',
    controlSocket: null,
    requestedTerminalGeometry: null,
    terminalSocket: socket as any,
    channel: null,
  };
}

function createHarness(resource: SessionTransportResource) {
  const pendingRequestsRef = {
    current: new Map() as SessionTmuxTargetRequestStore,
  };
  const sendSocketPayload = vi.fn();
  const request = manageTmuxSessionsOnOpenTransportRuntime({
    sessionId: 'session-1',
    message: { type: 'list-sessions' },
    pendingRequestsRef,
    readSessionTransportResource: () => resource,
    sendSocketPayload,
    timeoutMs: 50,
  });
  return {
    pendingRequestsRef,
    request,
    sendSocketPayload,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session tmux target management runtime', () => {
  it('returns no owner only when there is no open ready mux target transport', async () => {
    const resource = createResource(0, false);
    const harness = createHarness(resource);

    await expect(harness.request).resolves.toBeNull();
    expect(harness.sendSocketPayload).not.toHaveBeenCalled();
    expect(harness.pendingRequestsRef.current.size).toBe(0);
  });

  it('sends and settles a request on the existing physical mux target transport', async () => {
    const resource = createResource();
    const harness = createHarness(resource);
    const wireFrame = JSON.parse(harness.sendSocketPayload.mock.calls[0][2] as string);

    expect(wireFrame).toEqual(expect.objectContaining({
      type: 'mux-target-message',
      payload: expect.objectContaining({
        requestId: expect.any(String),
        message: { type: 'list-sessions' },
      }),
    }));

    expect(settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef: harness.pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'sessions',
        payload: { sessions: [' zterm ', 'alpha'] },
      },
    })).toBe(true);
    await expect(harness.request).resolves.toEqual(['zterm', 'alpha']);
  });

  it('reads target transport through client.daemon_connection before raw resource access', async () => {
    const resource = createResource();
    const pendingRequestsRef = {
      current: new Map() as SessionTmuxTargetRequestStore,
    };
    const readSessionTransportResource = vi.fn(() => {
      throw new Error('raw session transport resource should not be used');
    });
    const sendSocketPayload = vi.fn();

    const request = manageTmuxSessionsOnOpenTransportRuntime({
      sessionId: 'session-1',
      message: { type: 'list-sessions' },
      pendingRequestsRef,
      daemonConnection: {
        readSessionResource: vi.fn(() => resource),
        readSessionSocket: vi.fn(() => resource.socket),
        readOpenSessionSocket: vi.fn(() => resource.socket as any),
        sendSessionMessage: vi.fn(),
        sendSessionRaw: vi.fn(),
      },
      readSessionTransportResource,
      sendSocketPayload,
      timeoutMs: 50,
    });
    const wireFrame = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);

    settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'sessions',
        payload: { sessions: ['alpha'] },
      },
    });

    await expect(request).resolves.toEqual(['alpha']);
    expect(readSessionTransportResource).not.toHaveBeenCalled();
  });

  it('rejects malformed sessions truth instead of projecting it as an empty success', async () => {
    const harness = createHarness(createResource());
    const wireFrame = JSON.parse(harness.sendSocketPayload.mock.calls[0][2] as string);

    settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef: harness.pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'sessions',
        payload: { sessions: null as any },
      },
    });

    await expect(harness.request).rejects.toThrow('Malformed tmux target sessions response');
  });

  it('rejects a daemon target error without creating a second request path', async () => {
    const harness = createHarness(createResource());
    const wireFrame = JSON.parse(harness.sendSocketPayload.mock.calls[0][2] as string);

    settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef: harness.pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'error',
        payload: { message: 'tmux list failed' },
      },
    });

    await expect(harness.request).rejects.toThrow('tmux list failed');
    expect(harness.sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('rejects a target request timeout and clears the pending request', async () => {
    vi.useFakeTimers();
    const harness = createHarness(createResource());
    const timeoutExpectation = expect(harness.request).rejects.toThrow('Timed out while managing tmux sessions');

    await vi.advanceTimersByTimeAsync(50);

    await timeoutExpectation;
    expect(harness.pendingRequestsRef.current.size).toBe(0);
    expect(harness.sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('queries the daemon-owned session catalog on the existing mux target transport', async () => {
    const resource = createResource();
    const pendingRequestsRef = {
      current: new Map() as SessionTmuxTargetRequestStore,
    };
    const sendSocketPayload = vi.fn();
    const request = queryTerminalSessionCatalogOnOpenTransportRuntime({
      sessionId: 'session-1',
      message: { type: 'list-sessions' },
      pendingRequestsRef,
      readSessionTransportResource: () => resource,
      sendSocketPayload,
      timeoutMs: 50,
    });
    const wireFrame = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);

    settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'sessions',
        payload: {
          sessions: ['zterm', 'hd-codex'],
          sessionCatalog: [
            { name: 'zterm', backend: 'tmux' },
            { name: 'hd-codex', backend: 'herdr' },
          ],
        },
      },
    });

    await expect(request).resolves.toEqual({
      sessionNames: ['zterm', 'hd-codex'],
      sessionCatalog: [
        { name: 'zterm', backend: 'tmux' },
        { name: 'hd-codex', backend: 'herdr' },
      ],
    });
  });

  it('rejects a malformed catalog instead of silently dropping backend truth', async () => {
    const resource = createResource();
    const pendingRequestsRef = {
      current: new Map() as SessionTmuxTargetRequestStore,
    };
    const sendSocketPayload = vi.fn();
    const request = queryTerminalSessionCatalogOnOpenTransportRuntime({
      sessionId: 'session-1',
      message: { type: 'list-sessions' },
      pendingRequestsRef,
      readSessionTransportResource: () => resource,
      sendSocketPayload,
      timeoutMs: 50,
    });
    const wireFrame = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);

    settleSessionTmuxTargetRequestRuntime({
      pendingRequestsRef,
      requestId: wireFrame.payload.requestId,
      message: {
        type: 'sessions',
        payload: {
          sessions: ['zterm'],
          sessionCatalog: [{ name: 'zterm', backend: 'invalid' }] as any,
        },
      },
    });

    await expect(request).rejects.toThrow('Malformed tmux target session catalog');
  });
});
