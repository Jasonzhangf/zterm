import { describe, expect, it, vi } from 'vitest';
import {
  handleTargetMuxTransportFailureRuntime,
} from './session-context-transport-orchestration-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface FailedSocket extends BridgeTransportSocket {
  reportFailure: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFailedSocket(readyState: number): FailedSocket {
  return {
    readyState,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    reportFailure: vi.fn(),
    close: vi.fn(),
    getDiagnostics: vi.fn(() => ({} as ReturnType<BridgeTransportSocket['getDiagnostics']>)),
  };
}

function makePendingIntent(sessionId: string): PendingSessionTransportOpenIntent {
  return {
    sessionId,
    openRequestId: `${sessionId}:open:1`,
    createdAt: 1,
    host: {
      id: 'host-1',
      createdAt: 1,
      name: 'mac-studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      sessionName: sessionId,
      authType: 'password',
      tags: [],
      pinned: false,
    },
    resolvedSessionName: sessionId,
    debugScope: 'connect',
    finalizeFailure: vi.fn(),
    onConnected: vi.fn(),
  };
}

describe('handleTargetMuxTransportFailureRuntime', () => {
  it('clears one failed physical target and replays every recoverable same-target mux channel through one rebuild', () => {
    const failedSocket = makeFailedSocket(WebSocket.OPEN);
    const pendingSession2 = makePendingIntent('session-2');
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>([
        ['session-2', pendingSession2],
      ]),
    };
    const writeSessionTerminalChannelState = vi.fn();
    const writeSessionTargetTerminalSocket = vi.fn();
    const writeSessionTargetTerminalMuxReady = vi.fn();
    const scheduleReconnect = vi.fn();
    const clearHeartbeat = vi.fn();
    const updateSessionSync = vi.fn();

    handleTargetMuxTransportFailureRuntime({
      anchorSessionId: 'session-1',
      message: 'rtc data channel error',
      failedSocket,
      readSessionTargetRuntime: () => ({ key: 'target-a', sessionIds: ['session-1', 'session-2', 'session-3'] }),
      readSessionTerminalChannel: (sessionId) => ({
        channelId: `channel-${sessionId}`,
        sessionId,
        sessionName: sessionId,
        targetKey: 'target-a',
        state: sessionId === 'session-3' ? 'closed' : 'open',
        bodySubscribed: sessionId === 'session-1',
        openedAt: 1,
        closedAt: sessionId === 'session-3' ? 2 : null,
      }),
      writeSessionTerminalChannelState,
      writeSessionTargetTerminalSocket,
      writeSessionTargetTerminalMuxReady,
      clearHeartbeat,
      clearSessionHandshakeTimeout: vi.fn(),
      pendingSessionTransportOpenIntentsRef,
      updateSessionSync,
      scheduleReconnect,
      runtimeDebug: vi.fn(),
    });

    expect(writeSessionTargetTerminalMuxReady).toHaveBeenCalledWith('session-1', false);
    expect(writeSessionTargetTerminalSocket).toHaveBeenCalledWith('session-1', null);
    expect(failedSocket.reportFailure).toHaveBeenCalledWith('rtc data channel error');
    expect(failedSocket.reportFailure).toHaveBeenCalledTimes(1);
    expect(failedSocket.close).toHaveBeenCalledWith(4000, 'terminal mux target failed');
    expect(writeSessionTargetTerminalSocket.mock.invocationCallOrder[0]).toBeLessThan(
      failedSocket.close.mock.invocationCallOrder[0],
    );
    expect(clearHeartbeat).toHaveBeenCalledWith('session-1', {
      heartbeatKey: 'target:target-a',
    });
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'closed');
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'opening');
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'closed');
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'opening');
    expect(writeSessionTerminalChannelState).not.toHaveBeenCalledWith('session-3', 'closed');
    expect(pendingSessionTransportOpenIntentsRef.current.has('session-2')).toBe(false);
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'rtc data channel error', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', expect.objectContaining({
      state: 'reconnecting',
      ws: null,
      lastError: 'rtc data channel error',
    }));
    expect(updateSessionSync).toHaveBeenCalledWith('session-2', expect.objectContaining({
      state: 'reconnecting',
      ws: null,
      lastError: 'rtc data channel error',
    }));
    expect(pendingSession2.finalizeFailure).not.toHaveBeenCalled();
  });

  it('does not schedule duplicate reconnects when multiple recoverable channels share the same failed target', () => {
    const failedSocket = makeFailedSocket(WebSocket.CLOSING);
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>(),
    };
    const writeSessionTerminalChannelState = vi.fn();
    const writeSessionTargetTerminalSocket = vi.fn();
    const writeSessionTargetTerminalMuxReady = vi.fn();
    const scheduleReconnect = vi.fn();
    const clearHeartbeat = vi.fn();
    const updateSessionSync = vi.fn();

    handleTargetMuxTransportFailureRuntime({
      anchorSessionId: 'session-1',
      message: 'terminal mux transport closed',
      failedSocket,
      readSessionTargetRuntime: () => ({ key: 'target-a', sessionIds: ['session-1', 'session-2'] }),
      readSessionTerminalChannel: (sessionId) => ({
        channelId: `channel-${sessionId}`,
        sessionId,
        sessionName: sessionId,
        targetKey: 'target-a',
        state: 'open',
        bodySubscribed: sessionId === 'session-1',
        openedAt: 1,
        closedAt: null,
      }),
      writeSessionTerminalChannelState,
      writeSessionTargetTerminalSocket,
      writeSessionTargetTerminalMuxReady,
      clearHeartbeat,
      clearSessionHandshakeTimeout: vi.fn(),
      pendingSessionTransportOpenIntentsRef,
      updateSessionSync,
      scheduleReconnect,
      runtimeDebug: vi.fn(),
    });

    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
    expect(failedSocket.reportFailure).toHaveBeenCalledWith('terminal mux transport closed');
    expect(failedSocket.reportFailure).toHaveBeenCalledTimes(1);
    expect(failedSocket.close).not.toHaveBeenCalled();
    expect(scheduleReconnect).toHaveBeenCalledWith('session-1', 'terminal mux transport closed', true, {
      immediate: true,
      resetAttempt: true,
      force: true,
    });
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'opening');
    expect(writeSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'opening');
    expect(updateSessionSync).toHaveBeenCalledWith('session-1', expect.objectContaining({ state: 'reconnecting' }));
    expect(updateSessionSync).toHaveBeenCalledWith('session-2', expect.objectContaining({ state: 'reconnecting' }));
  });
});
