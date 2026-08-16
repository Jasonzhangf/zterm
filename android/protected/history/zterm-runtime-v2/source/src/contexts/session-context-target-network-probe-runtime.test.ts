import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { createSessionTargetNetworkProbeRuntime } from './session-context-target-network-probe-runtime';

function createSocket(readyState: number = WebSocket.OPEN): BridgeTransportSocket {
  return {
    readyState,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
    reportFailure: vi.fn(),
    getDiagnostics: vi.fn(() => ({} as ReturnType<BridgeTransportSocket['getDiagnostics']>)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSessionTargetNetworkProbeRuntime', () => {
  it('rejects invalid owner configuration instead of repairing it', () => {
    expect(() => createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: Number.NaN,
      now: Date.now,
    })).toThrow('target network probe timeout must be a positive safe integer');
    expect(() => createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 0,
      now: Date.now,
    })).toThrow('target network probe timeout must be a positive safe integer');
    expect(() => createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 2_500.5,
      now: Date.now,
    })).toThrow('target network probe timeout must be a positive safe integer');
    expect(() => createSessionTargetNetworkProbeRuntime({
      probeTimeoutMs: 2_500,
      now: undefined as unknown as () => number,
    })).toThrow('target network probe clock is required');
  });

  it('deduplicates multiple logical-session signals onto one exact target socket probe', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const socket = createSocket();
    const sendProbe = vi.fn();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    expect(runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe,
      onFailure,
    })).toBe('started');
    expect(runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe,
      onFailure,
    })).toBe('deduped');

    expect(sendProbe).toHaveBeenCalledTimes(1);
    expect(sendProbe).toHaveBeenCalledWith(socket, 1_000);
    vi.advanceTimersByTime(2_499);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('keeps the exact socket generation when any valid target activity arrives', () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe: vi.fn(),
      onFailure,
    });

    expect(runtime.recordTargetActivity('daemon-a', socket)).toBe(true);
    vi.advanceTimersByTime(2_500);
    expect(onFailure).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('submits one exact-generation timeout to the existing target failure owner', () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe: vi.fn(),
      onFailure,
    });
    vi.advanceTimersByTime(2_500);
    vi.advanceTimersByTime(10_000);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      type: 'TargetNetworkProbeError01GenerationTimeout',
      targetKey: 'daemon-a',
      socket,
    });
  });

  it('rejects late activity from a superseded socket generation', () => {
    vi.useFakeTimers();
    const oldSocket = createSocket();
    const newSocket = createSocket();
    const oldFailure = vi.fn();
    const newFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    runtime.probe({
      targetKey: 'daemon-a',
      socket: oldSocket,
      sendProbe: vi.fn(),
      onFailure: oldFailure,
    });
    runtime.probe({
      targetKey: 'daemon-a',
      socket: newSocket,
      sendProbe: vi.fn(),
      onFailure: newFailure,
    });

    expect(runtime.recordTargetActivity('daemon-a', oldSocket)).toBe(false);
    vi.advanceTimersByTime(2_500);
    expect(oldFailure).not.toHaveBeenCalled();
    expect(newFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps a connecting physical transport generation without probing or failing it', () => {
    const socket = createSocket(WebSocket.CONNECTING);
    const sendProbe = vi.fn();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    expect(runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe,
      onFailure,
    })).toBe('still-connecting');
    expect(sendProbe).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('submits a terminal physical transport state once to the target failure owner', () => {
    const socket = createSocket(WebSocket.CLOSED);
    const sendProbe = vi.fn();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    expect(runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe,
      onFailure,
    })).toBe('terminal-socket');
    expect(sendProbe).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      type: 'TargetNetworkProbeError03TerminalSocketState',
      targetKey: 'daemon-a',
      socket,
      readyState: WebSocket.CLOSED,
    });
  });

  it('returns an explicit failure when the target probe cannot be sent', () => {
    const socket = createSocket();
    const onFailure = vi.fn();
    const runtime = createSessionTargetNetworkProbeRuntime({ probeTimeoutMs: 2_500, now: Date.now });

    expect(runtime.probe({
      targetKey: 'daemon-a',
      socket,
      sendProbe: () => {
        throw new Error('send failed');
      },
      onFailure,
    })).toBe('send-failed');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      type: 'TargetNetworkProbeError02SendFailure',
      targetKey: 'daemon-a',
      socket,
    });
  });
});
