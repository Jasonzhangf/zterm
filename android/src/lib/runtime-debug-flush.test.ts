// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { flushRuntimeDebugLogsToSessionTransport } from './runtime-debug-flush';
import {
  drainRuntimeDebugEntries,
  resetRuntimeDebugStateForTests,
  runtimeDebugPrechecked,
  runtimeDebug,
  setRuntimeDebugEnabled,
} from './runtime-debug';
import { resetRuntimeDebugTransportFlushStateForTests } from './runtime-debug-flush';

describe('runtime-debug-flush', () => {
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
    resetRuntimeDebugTransportFlushStateForTests();
  });

  it('flushes queued runtime debug entries into the active session transport', () => {
    setRuntimeDebugEnabled(true);
    runtimeDebug('session.input.send', { sessionId: 's1' });

    const sent: string[] = [];
    const flushed = flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: 's1',
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(String(data));
      },
    });

    expect(flushed).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.some((frame) => frame.includes('"type":"debug-log"'))).toBe(true);
    expect(sent.some((frame) => frame.includes('"scope":"session.input.send"'))).toBe(true);
  });

  it('also flushes a client snapshot through the active session transport when debug is enabled', () => {
    setRuntimeDebugEnabled(true);

    const sent: string[] = [];
    const flushed = flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: 's1',
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(String(data));
      },
    });

    expect(flushed).toBe(true);
    expect(sent.some((frame) => frame.includes('\"type\":\"debug-snapshot\"'))).toBe(true);
    expect(sent.some((frame) => frame.includes('\"source\":\"session-transport-runtime-debug\"'))).toBe(true);
  });

  it('does not upload queued performance trace metadata when runtime debug is disabled', () => {
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

    const sent: string[] = [];
    const flushed = flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: 's1',
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(String(data));
      },
    });

    expect(flushed).toBe(false);
    expect(sent).toEqual([]);
  });

  it('flushes performance trace metadata only while temporary runtime debug is enabled', () => {
    setRuntimeDebugEnabled(true);
    runtimeDebugPrechecked('terminal.performance.trace', {
      sessionId: 's1',
      traceId: 's1:7',
      mirrorRevision: 7,
      subscriberId: 's1',
      stage: 'client-rx',
      at: 100,
      lineCount: 1,
    });

    const sent: string[] = [];
    const flushed = flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: 's1',
      readSessionTransportSocket: () => ({ readyState: WebSocket.OPEN } as any),
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(String(data));
      },
    });

    expect(flushed).toBe(true);
    expect(sent.some((frame) => frame.includes('"type":"debug-log"'))).toBe(true);
    expect(sent.some((frame) => frame.includes('"scope":"terminal.performance.trace"'))).toBe(true);
  });
});
