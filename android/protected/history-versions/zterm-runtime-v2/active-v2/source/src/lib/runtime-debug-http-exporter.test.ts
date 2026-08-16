// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushRuntimeDebugLogs,
  getDroppedRuntimeDebugObservabilityCount,
  resetRuntimeDebugExporterStateForTests,
  type DebugObservabilityHttpTransport,
} from './runtime-debug-http-exporter';
import {
  drainRuntimeDebugEntries,
  resetRuntimeDebugStateForTests,
  runtimeDebug,
  runtimeDebugPrechecked,
  setRuntimeDebugEnabled,
} from './runtime-debug';

describe('runtime debug observability exporter', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    while (drainRuntimeDebugEntries().length > 0) {
      // reset queue between tests
    }
    resetRuntimeDebugStateForTests();
    resetRuntimeDebugExporterStateForTests();
  });

  function fakeTransport() {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const transport: DebugObservabilityHttpTransport = {
      async postJson(url, body, headers) {
        calls.push({ url, body, headers });
        return { ok: true, status: 200, text: '{"ok":true}' };
      },
    };
    return { calls, transport };
  }

  it('posts queued runtime debug entries through the dedicated HTTP observability channel', async () => {
    setRuntimeDebugEnabled(true);
    runtimeDebug('session.input.send', { sessionId: 's1' });
    const { calls, transport } = fakeTransport();

    const accepted = flushRuntimeDebugLogs({
      target: {
        targetHost: '100.66.1.82',
        targetPort: 3333,
        targetAuthToken: 'token',
      },
      transport,
    });

    expect(accepted).toBe(true);
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === 'http://100.66.1.82:3333/debug/runtime/logs')).toBe(true);
    });
    const logCall = calls.find((call) => call.url.endsWith('/debug/runtime/logs'));
    expect(logCall?.body).toMatchObject({
      kind: 'logs',
      payload: {
        entries: expect.any(Array),
      },
    });
    const logPayload = (logCall?.body as { payload: Record<string, unknown> }).payload;
    expect(logPayload).not.toHaveProperty('sessionId');
    expect(logPayload).not.toHaveProperty('tmuxSessionName');
    expect(logPayload).not.toHaveProperty('requestOrigin');
    expect(JSON.stringify(logCall?.body)).toContain('session.input.send');
    expect(logCall?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-ZTerm-Token': 'token',
    });
  });

  it('posts a client snapshot only through the observability endpoint', async () => {
    setRuntimeDebugEnabled(true);
    const { calls, transport } = fakeTransport();

    const accepted = flushRuntimeDebugLogs({
      target: {
        targetHost: '127.0.0.1',
        targetPort: 3333,
      },
      transport,
    });

    expect(accepted).toBe(true);
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/debug/runtime/snapshot'))).toBe(true);
    });
    const snapshotCall = calls.find((call) => call.url.endsWith('/debug/runtime/snapshot'));
    expect(snapshotCall?.body).toMatchObject({
      kind: 'snapshot',
      payload: {
        snapshot: expect.any(Object),
      },
    });
    const snapshotPayload = (snapshotCall?.body as { payload: Record<string, unknown> }).payload;
    expect(snapshotPayload).not.toHaveProperty('sessionId');
    expect(snapshotPayload).not.toHaveProperty('tmuxSessionName');
    expect(snapshotPayload).not.toHaveProperty('requestOrigin');
    expect(JSON.stringify(snapshotCall?.body)).toContain('debug-observability-http');
  });

  it('does not upload queued metadata when runtime debug is disabled', () => {
    setRuntimeDebugEnabled(false);
    runtimeDebugPrechecked('terminal.performance.trace', {
      sessionId: 's1',
      traceId: 's1:7',
      mirrorRevision: 7,
      subscriberId: 's1',
      stage: 'client-rx',
      at: 100,
      lineCount: 1,
    });
    const { calls, transport } = fakeTransport();

    const accepted = flushRuntimeDebugLogs({
      target: {
        targetHost: '127.0.0.1',
        targetPort: 3333,
      },
      transport,
    });

    expect(accepted).toBe(false);
    expect(calls).toEqual([]);
  });

  it('drops only bounded debug batches instead of blocking the caller', async () => {
    setRuntimeDebugEnabled(true);
    const failingTransport: DebugObservabilityHttpTransport = {
      async postJson() {
        throw new Error('observability unavailable');
      },
    };

    const accepted = flushRuntimeDebugLogs({
      target: {
        targetHost: '127.0.0.1',
        targetPort: 3333,
      },
      transport: failingTransport,
    });

    expect(accepted).toBe(true);
    await vi.waitFor(() => {
      expect(getDroppedRuntimeDebugObservabilityCount().snapshots).toBeGreaterThan(0);
    });
  });
});
