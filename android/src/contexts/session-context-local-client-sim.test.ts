// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { handleSocketServerMessageRuntime } from './session-context-socket-message-runtime';

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
});
