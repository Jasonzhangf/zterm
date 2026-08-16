import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHostReachable } from './reconnect-host-probe';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeHostReachable', () => {
  it('defaults to an HTTP /health probe instead of a short-lived WebSocket', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const wsMock = vi.fn();
    vi.stubGlobal('WebSocket', wsMock);

    const result = await probeHostReachable('100.66.1.82', 3333);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://100.66.1.82:3333/health',
      expect.objectContaining({ method: 'GET', mode: 'no-cors' }),
    );
    expect(wsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ reachable: true, elapsedMs: expect.any(Number) });
  });

  it('falls back to a WebSocket probe only when the ws protocol is explicitly requested', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({} as Response));
    vi.stubGlobal('fetch', fetchMock);
    class MockProbeWebSocket {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public readonly url: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', MockProbeWebSocket);

    const result = await probeHostReachable('100.66.1.82', 3333, { protocol: 'ws', timeoutMs: 500 });

    expect(result.reachable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
