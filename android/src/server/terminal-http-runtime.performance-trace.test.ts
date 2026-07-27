import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { createTerminalPerformanceTraceStore } from '../lib/terminal-performance-trace';
import { createRuntimeDebugStore } from './runtime-debug-store';
import { createTerminalHttpRuntime } from './terminal-http-runtime';

function createResponseRecorder() {
  const headers = new Map<string, string | number | string[]>();
  let body = '';
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string | number | string[]) {
      headers.set(name, value);
    },
    end(chunk?: string) {
      body += chunk || '';
    },
  } as unknown as ServerResponse;
  return {
    response,
    readJson: () => JSON.parse(body),
    headers,
  };
}

describe('terminal http runtime performance trace summary', () => {
  it('exposes bounded daemon/client metadata trace summary on /debug/runtime', () => {
    const performanceTraceStore = createTerminalPerformanceTraceStore({ limit: 20 });
    performanceTraceStore.record({
      sessionId: 'session-1',
      traceId: 'session-1:7',
      mirrorRevision: 7,
      subscriberId: 'session-1',
      stage: 'send-done',
      at: 100,
      bytes: 900,
      lineCount: 5,
    });
    const clientRuntimeDebugStore = createRuntimeDebugStore();
    clientRuntimeDebugStore.appendBatch(
      {
        sessionId: 'session-1',
        tmuxSessionName: 'demo',
      },
      [
        {
          seq: 1,
          ts: '2026-07-13T08:00:00.000Z',
          scope: 'terminal.performance.trace',
          payload: JSON.stringify({
            traceId: 'session-1:7',
            mirrorRevision: 7,
            subscriberId: 'session-1',
            stage: 'client-rx',
            at: 112,
            bytes: 900,
            lineCount: 5,
            lines: ['must-not-leak'],
          }),
        },
        {
          seq: 2,
          ts: '2026-07-13T08:00:00.016Z',
          scope: 'terminal.performance.trace',
          payload: JSON.stringify({
            traceId: 'session-1:7',
            mirrorRevision: 7,
            subscriberId: 'session-1',
            stage: 'render-commit',
            at: 128,
          }),
        },
      ],
    );
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1',
      port: 3333,
      requiredAuthToken: '',
      updatesDir: '/tmp/zterm-updates-missing',
      appUpdateVersionCode: 0,
      appUpdateVersionName: '',
      appUpdateManifestUrl: '',
      sessions: new Map(),
      mirrors: new Map(),
      clientRuntimeDebugStore,
      daemonRuntimeDebugStore: createRuntimeDebugStore(),
      performanceTraceStore,
      resolveDebugRouteLimit: () => 200,
      broadcastRuntimeDebugControl: () => undefined,
      setDaemonRuntimeDebugEnabled: () => undefined,
      logTimePrefix: () => '2026-07-13 08:00:00.000 +00:00',
    });
    const recorder = createResponseRecorder();

    runtime.handleHttpRequest({
      method: 'GET',
      url: '/debug/runtime',
      headers: { host: '127.0.0.1:3333' },
      socket: {},
    } as IncomingMessage, recorder.response);

    const payload = recorder.readJson();
    expect(payload.performanceTrace.summary.sessions).toHaveLength(1);
    expect(payload.performanceTrace.summary.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      traceId: 'session-1:7',
      mirrorRevision: 7,
      subscriberId: 'session-1',
      sendToRxMs: 12,
      rxToRenderMs: 16,
      bytes: 1800,
      lineCount: 5,
    });
    expect(JSON.stringify(payload.performanceTrace)).not.toContain('must-not-leak');
  });

  it('correlates mux-channel daemon trace records with local client trace records', () => {
    const performanceTraceStore = createTerminalPerformanceTraceStore({ limit: 20 });
    performanceTraceStore.record({
      sessionId: 'target-1:channel:session-abc',
      traceId: 'target-1:channel:session-abc:77',
      mirrorRevision: 77,
      subscriberId: 'target-1:channel:session-abc',
      stage: 'send-done',
      at: 100,
      bytes: 900,
      lineCount: 5,
    });
    const clientRuntimeDebugStore = createRuntimeDebugStore();
    clientRuntimeDebugStore.appendBatch(
      {
        sessionId: 'session-abc',
        tmuxSessionName: 'demo',
      },
      [
        {
          seq: 1,
          ts: '2026-07-27T08:00:00.000Z',
          scope: 'terminal.performance.trace',
          payload: JSON.stringify({
            sessionId: 'session-abc',
            traceId: 'session-abc:77',
            mirrorRevision: 77,
            subscriberId: 'session-abc',
            stage: 'client-rx',
            at: 116,
            bytes: 900,
          }),
        },
        {
          seq: 2,
          ts: '2026-07-27T08:00:00.016Z',
          scope: 'terminal.performance.trace',
          payload: JSON.stringify({
            sessionId: 'session-abc',
            traceId: 'session-abc:77',
            mirrorRevision: 77,
            subscriberId: 'session-abc',
            stage: 'render-commit',
            at: 148,
          }),
        },
      ],
    );
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1',
      port: 3333,
      requiredAuthToken: '',
      updatesDir: '/tmp/zterm-updates-missing',
      appUpdateVersionCode: 0,
      appUpdateVersionName: '',
      appUpdateManifestUrl: '',
      sessions: new Map(),
      mirrors: new Map(),
      clientRuntimeDebugStore,
      daemonRuntimeDebugStore: createRuntimeDebugStore(),
      performanceTraceStore,
      resolveDebugRouteLimit: () => 200,
      broadcastRuntimeDebugControl: () => undefined,
      setDaemonRuntimeDebugEnabled: () => undefined,
      logTimePrefix: () => '2026-07-27 08:00:00.000 +00:00',
    });
    const recorder = createResponseRecorder();

    runtime.handleHttpRequest({
      method: 'GET',
      url: '/debug/runtime',
      headers: { host: '127.0.0.1:3333' },
      socket: {},
    } as IncomingMessage, recorder.response);

    const payload = recorder.readJson();
    expect(payload.performanceTrace.summary.sessions).toHaveLength(1);
    expect(payload.performanceTrace.summary.sessions[0]).toMatchObject({
      traceId: 'target-1:channel:session-abc:77',
      sendToRxMs: 16,
      rxToRenderMs: 32,
    });
  });
});
