import { describe, expect, it, vi } from 'vitest';
import {
  handleTargetMuxTransportFailureRuntime,
  notifyTargetNetworkSignalRuntime,
  routeTargetSocketFailureRuntime,
} from './session-context-transport-orchestration-runtime';
import { createSessionTargetNetworkProbeRuntime } from './session-context-target-network-probe-runtime';
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

describe('notifyTargetNetworkSignalRuntime', () => {
  it('probes every physical daemon target once and does not multiply by logical channels', () => {
    const targetA = makeFailedSocket(WebSocket.OPEN);
    const targetB = makeFailedSocket(WebSocket.OPEN);
    const targetNetworkProbeRuntime = createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 2_500,
      now: () => 1_000,
    });
    const sendTargetProbe = vi.fn();
    const submitTargetSocketFailure = vi.fn();
    const runtimeDebug = vi.fn();
    const options = {
      signal: { connected: true, connectionType: 'wifi', source: 'capacitor' as const },
      targetRuntimes: [
        { key: 'daemon-a', sessionIds: ['session-a1', 'session-a2'], terminalTransport: targetA },
        { key: 'daemon-b', sessionIds: ['session-b1'], terminalTransport: targetB },
      ],
      targetNetworkProbeRuntime,
      sendTargetProbe,
      submitTargetSocketFailure,
      runtimeDebug,
    };

    expect(notifyTargetNetworkSignalRuntime(options)).toEqual([
      { targetKey: 'daemon-a', result: 'started' },
      { targetKey: 'daemon-b', result: 'started' },
    ]);
    expect(sendTargetProbe).toHaveBeenCalledTimes(2);
    expect(sendTargetProbe).toHaveBeenCalledWith('daemon-a', targetA, 1_000);
    expect(sendTargetProbe).toHaveBeenCalledWith('daemon-b', targetB, 1_000);

    expect(notifyTargetNetworkSignalRuntime(options).map((outcome) => outcome.result)).toEqual([
      'deduped',
      'deduped',
    ]);
    expect(sendTargetProbe).toHaveBeenCalledTimes(2);
    expect(submitTargetSocketFailure).not.toHaveBeenCalled();
    targetNetworkProbeRuntime.dispose();
  });

  it('probes a retained physical target even when it has no logical session', () => {
    const socket = makeFailedSocket(WebSocket.OPEN);
    const targetNetworkProbeRuntime = createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 2_500,
      now: () => 1_000,
    });
    const sendTargetProbe = vi.fn();

    expect(notifyTargetNetworkSignalRuntime({
      signal: { connected: true, connectionType: 'wifi', source: 'capacitor' },
      targetRuntimes: [{ key: 'daemon-idle', sessionIds: [], terminalTransport: socket }],
      targetNetworkProbeRuntime,
      sendTargetProbe,
      submitTargetSocketFailure: vi.fn(),
      runtimeDebug: vi.fn(),
    })).toEqual([{ targetKey: 'daemon-idle', result: 'started' }]);
    expect(sendTargetProbe).toHaveBeenCalledWith('daemon-idle', socket, 1_000);
    targetNetworkProbeRuntime.dispose();
  });

  it('projects probe send failure explicitly into the one target failure owner', () => {
    const socket = makeFailedSocket(WebSocket.OPEN);
    const targetNetworkProbeRuntime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });
    const submitTargetSocketFailure = vi.fn();

    expect(notifyTargetNetworkSignalRuntime({
      signal: { connected: false, connectionType: 'none', source: 'capacitor' },
      targetRuntimes: [
        { key: 'daemon-a', sessionIds: ['session-a1'], terminalTransport: socket },
      ],
      targetNetworkProbeRuntime,
      sendTargetProbe: () => {
        throw new Error('send failed');
      },
      submitTargetSocketFailure,
      runtimeDebug: vi.fn(),
    })).toEqual([
      { targetKey: 'daemon-a', result: 'send-failed' },
    ]);
    expect(submitTargetSocketFailure).toHaveBeenCalledWith(
      'daemon-a',
      socket,
      'network generation target probe send failed',
    );
    targetNetworkProbeRuntime.dispose();
  });

  it('projects probe timeout explicitly into the one target failure owner', () => {
    vi.useFakeTimers();
    const socket = makeFailedSocket(WebSocket.OPEN);
    const targetNetworkProbeRuntime = createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 2_500,
      now: () => 1_000,
    });
    const submitTargetSocketFailure = vi.fn();

    expect(notifyTargetNetworkSignalRuntime({
      signal: { source: 'foreground-resume' },
      targetRuntimes: [
        { key: 'daemon-a', sessionIds: ['session-a1'], terminalTransport: socket },
      ],
      targetNetworkProbeRuntime,
      sendTargetProbe: vi.fn(),
      submitTargetSocketFailure,
      runtimeDebug: vi.fn(),
    })).toEqual([
      { targetKey: 'daemon-a', result: 'started' },
    ]);

    vi.advanceTimersByTime(2_500);
    expect(submitTargetSocketFailure).toHaveBeenCalledWith(
      'daemon-a',
      socket,
      'network generation target probe timeout',
    );
    targetNetworkProbeRuntime.dispose();
    vi.useRealTimers();
  });
});

describe('routeTargetSocketFailureRuntime', () => {
  it('retires an exact idle target generation without inventing a session reconnect', () => {
    const socket = makeFailedSocket(WebSocket.OPEN);
    const writeTargetTerminalSocket = vi.fn();
    const writeTargetTerminalMuxReady = vi.fn();
    const clearHeartbeat = vi.fn();
    const handleAnchoredFailure = vi.fn();

    expect(routeTargetSocketFailureRuntime({
      targetKey: 'daemon-idle',
      failedSocket: socket,
      message: 'network generation target probe timeout',
      readTargetTransportRuntime: () => ({
        key: 'daemon-idle',
        sessionIds: [],
        terminalTransport: socket,
      }),
      writeTargetTerminalSocket,
      writeTargetTerminalMuxReady,
      clearHeartbeat,
      handleAnchoredFailure,
      runtimeDebug: vi.fn(),
    })).toBe('idle-retired');

    expect(socket.reportFailure).toHaveBeenCalledWith('network generation target probe timeout');
    expect(writeTargetTerminalMuxReady).toHaveBeenCalledWith('daemon-idle', false);
    expect(writeTargetTerminalSocket).toHaveBeenCalledWith('daemon-idle', null);
    expect(clearHeartbeat).toHaveBeenCalledWith('daemon-idle', { heartbeatKey: 'target:daemon-idle' });
    expect(socket.close).toHaveBeenCalledWith(4000, 'terminal mux target failed');
    expect(handleAnchoredFailure).not.toHaveBeenCalled();
  });

  it('ignores a stale target socket generation', () => {
    const staleSocket = makeFailedSocket(WebSocket.OPEN);
    const currentSocket = makeFailedSocket(WebSocket.OPEN);
    const handleAnchoredFailure = vi.fn();

    expect(routeTargetSocketFailureRuntime({
      targetKey: 'daemon-a',
      failedSocket: staleSocket,
      message: 'late timeout',
      readTargetTransportRuntime: () => ({
        key: 'daemon-a',
        sessionIds: ['session-a'],
        terminalTransport: currentSocket,
      }),
      writeTargetTerminalSocket: vi.fn(),
      writeTargetTerminalMuxReady: vi.fn(),
      clearHeartbeat: vi.fn(),
      handleAnchoredFailure,
      runtimeDebug: vi.fn(),
    })).toBe('stale');
    expect(staleSocket.reportFailure).not.toHaveBeenCalled();
    expect(staleSocket.close).not.toHaveBeenCalled();
    expect(handleAnchoredFailure).not.toHaveBeenCalled();
  });
});

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
