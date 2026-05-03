// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { flushRuntimeDebugLogsToSessionTransport } from './runtime-debug-flush';
import { drainRuntimeDebugEntries, runtimeDebug, setRuntimeDebugEnabled } from './runtime-debug';

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
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"type":"debug-log"');
    expect(sent[0]).toContain('"scope":"session.input.send"');
  });
});
