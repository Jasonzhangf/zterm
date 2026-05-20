// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { handleSocketServerMessageRuntime } from './session-context-socket-message-runtime';
import { bindSessionTransportSocketLifecycle } from './session-context-transport-runtime';
import { filterRestorableOpenTabsByRemoteSessionNames } from '../lib/open-tab-restore';

describe('local client simulation', () => {
  it('active tab receives buffer-sync and applies pipeline', () => {
    const settleSessionPullState = vi.fn();
    const applyIncomingBufferSync = vi.fn();
    handleSocketServerMessageRuntime({
      params: { sessionId: 's1', host: { id: 'h1' } as any, ws: { readyState: 1 } as any, debugScope: 'connect', onConnected: vi.fn(), onFailure: vi.fn(), onClosed: vi.fn() },
      msg: { type: 'buffer-sync', payload: { revision: 2, startIndex: 1, endIndex: 1, lines: ['echo hello'] } } as any,
      refs: { stateRef: { current: { activeSessionId: 's1', sessions: [{ id: 's1', state: 'connected' }], liveSessionIds: [] } }, scheduleStatesRef: { current: {} }, lastHeadRequestAtRef: { current: new Map() }, lastPongAtRef: { current: new Map() } } as any,
      settleSessionPullState,
      runtimeDebug: vi.fn(),
      isSessionTransportActive: () => true,
      shouldAcceptSessionLiveBuffer: () => true,
      summarizeBufferPayload: () => ({}),
      applyIncomingBufferSync,
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: vi.fn() as any,
      updateSessionSync: vi.fn(),
    });
    expect(settleSessionPullState).toHaveBeenCalledTimes(1);
    expect(applyIncomingBufferSync).toHaveBeenCalledTimes(1);
  });

  it('inactive tab drops when live-buffer gate is false', () => {
    const applyIncomingBufferSync = vi.fn();
    handleSocketServerMessageRuntime({
      params: { sessionId: 's1', host: { id: 'h1' } as any, ws: { readyState: 1 } as any, debugScope: 'connect', onConnected: vi.fn(), onFailure: vi.fn(), onClosed: vi.fn() },
      msg: { type: 'buffer-sync', payload: { revision: 4, startIndex: 2, endIndex: 2, lines: ['remote-line'] } } as any,
      refs: { stateRef: { current: { activeSessionId: 's2', sessions: [{ id: 's1', state: 'connected' }, { id: 's2', state: 'connected' }], liveSessionIds: [] } }, scheduleStatesRef: { current: {} }, lastHeadRequestAtRef: { current: new Map() }, lastPongAtRef: { current: new Map() } } as any,
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      isSessionTransportActive: () => false,
      shouldAcceptSessionLiveBuffer: () => false,
      summarizeBufferPayload: () => ({}),
      applyIncomingBufferSync,
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: vi.fn() as any,
      updateSessionSync: vi.fn(),
    });
    expect(applyIncomingBufferSync).not.toHaveBeenCalled();
  });

  it('reconnect path: stale socket events are ignored after lifecycle rebind', () => {
    const runtimeDebug = vi.fn();
    const socket = { readyState: 1 } as any;
    const staleSocket = { readyState: 1 } as any;
    const handleSocketServerMessage = vi.fn();

    const access = {
      value: socket,
      read() { return this.value; },
      write(v: any) { this.value = v; },
    };

    bindSessionTransportSocketLifecycle({
      sessionId: 's1',
      host: { id: 'h1' } as any,
      ws: socket,
      debugScope: 'reconnect',
      refs: { stateRef: { current: { activeSessionId: 's1' } } } as any,
      isSessionTransportActive: () => true,
      shouldAcceptSessionLiveBuffer: () => true,
      readSessionTransportSocket: () => access.read(),
      writeSessionTransportSocket: (_sid, ws) => access.write(ws),
      clearSessionTransportSocket: vi.fn(),
      cleanupSocket: vi.fn(),
      recordSessionRx: vi.fn(),
      sendSocketPayload: vi.fn(),
      runtimeDebug,
      finalizeFailure: vi.fn(),
      onConnected: vi.fn(),
      handleSocketServerMessage,
      writeSessionTransportToken: vi.fn(),
      onClosed: vi.fn(),
    } as any);

    // Simulate reconnect swap: active socket changed before stale event arrives
    access.write(staleSocket);
    if (typeof socket.onmessage === 'function') {
      socket.onmessage({ data: JSON.stringify({ type: 'buffer-sync', payload: { revision: 1, startIndex: 1, endIndex: 1, lines: ['stale'] } }) });
    }
    expect(handleSocketServerMessage).not.toHaveBeenCalled();
  });

  it('tab-restore mismatch guard: keep tab when remote owner truth is missing', () => {
    const result = filterRestorableOpenTabsByRemoteSessionNames({
      tabs: [{
        sessionId: 'tab-a',
        hostId: 'host-a',
        connectionName: 'Conn A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
        createdAt: 1,
      } as any],
      sessionNamesByTarget: new Map(),
    });
    expect(result.restorableTabs.map((t) => t.sessionId)).toEqual(['tab-a']);
    expect(result.droppedTabs).toEqual([]);
  });
});
