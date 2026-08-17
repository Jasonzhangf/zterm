import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRuntimeDebugStore } from './runtime-debug-store';
import { createTerminalHttpRuntime, type TerminalHttpRuntimeDeps } from './terminal-http-runtime';
import { DebugPermissionService } from '@zterm/shared/terminal/debug-contract';

function responseRecorder() {
  let body = '';
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    end(chunk?: string) {
      body += chunk || '';
    },
  } as unknown as ServerResponse;
  return {
    response,
    readJson: () => JSON.parse(body),
    readText: () => body,
  };
}

function request(method: string, url: string, payload: unknown, headers: Record<string, string> = {}) {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.url = url;
  emitter.headers = { host: '127.0.0.1:3333', ...headers } as IncomingMessage['headers'];
  emitter.socket = {} as IncomingMessage['socket'];
  queueMicrotask(() => {
    emitter.emit('data', Buffer.from(JSON.stringify(payload)));
    emitter.emit('end');
  });
  return emitter;
}

function createDeps(overrides: Partial<TerminalHttpRuntimeDeps> = {}) {
  const deps: TerminalHttpRuntimeDeps = {
    host: '127.0.0.1',
    port: 3333,
    requiredAuthToken: '',
    updatesDir: '/tmp/zterm-missing',
    appUpdateVersionCode: 0,
    appUpdateVersionName: '',
    appUpdateManifestUrl: '',
    sessions: new Map(),
    mirrors: new Map(),
    clientRuntimeDebugStore: createRuntimeDebugStore(),
    daemonRuntimeDebugStore: createRuntimeDebugStore(),
    performanceTraceStore: {} as never,
    resolveDebugRouteLimit: () => 200,
    broadcastRuntimeDebugControl: vi.fn(),
    setDaemonRuntimeDebugEnabled: vi.fn(),
    setDaemonRuntimeDebugLease: vi.fn(),
    handleClientDebugLog: vi.fn(),
    handleClientDebugSnapshot: vi.fn(),
    logTimePrefix: () => '',
    connections: new Map(),
    sendTransportMessage: vi.fn(),
  };
  return { ...deps, ...overrides };
}

describe('terminal HTTP debug observability channel', () => {
  it('accepts authenticated client debug logs as POST without session transport', async () => {
    const handleClientDebugLog = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({ handleClientDebugLog }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/logs', {
        kind: 'logs',
        payload: {
          entries: [{ seq: 1, ts: '2026-08-14T00:00:00.000Z', scope: 'session.input.send', payload: '{}' }],
        },
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(200);
    expect(handleClientDebugLog).toHaveBeenCalledWith(
      {
        sessionId: 'client-runtime',
        tmuxSessionName: 'client',
        requestOrigin: 'http://127.0.0.1:3333',
      },
      {
        entries: [
          expect.objectContaining({ scope: 'session.input.send' }),
        ],
      },
    );
  });

  it('ignores body-forged debug source metadata and assigns request identity on logs', async () => {
    const handleClientDebugLog = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({ handleClientDebugLog }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/logs', {
        kind: 'logs',
        payload: {
          sessionId: 'forged-session',
          tmuxSessionName: 'forged-tmux',
          requestOrigin: 'http://attacker.invalid',
          entries: [{ seq: 1, ts: '2026-08-14T00:00:00.000Z', scope: 'session.input.send' }],
        },
      }),
      recorder.response,
    );

    expect(handleClientDebugLog).toHaveBeenCalledWith(
      {
        sessionId: 'client-runtime',
        tmuxSessionName: 'client',
        requestOrigin: 'http://127.0.0.1:3333',
      },
      expect.objectContaining({ entries: [expect.objectContaining({ scope: 'session.input.send' })] }),
    );
    expect(JSON.stringify(handleClientDebugLog.mock.calls[0][0])).not.toContain('forged');
  });

  it('accepts client debug snapshots through the dedicated POST route', async () => {
    const handleClientDebugSnapshot = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({ handleClientDebugSnapshot }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/snapshot', {
        kind: 'snapshot',
        payload: {
          sessionId: 'forged-session',
          tmuxSessionName: 'forged-tmux',
          requestOrigin: 'http://attacker.invalid',
          snapshot: { source: 'debug-observability-http', online: true },
        },
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(200);
    expect(handleClientDebugSnapshot).toHaveBeenCalledWith(
      {
        sessionId: 'client-runtime',
        tmuxSessionName: 'client',
        requestOrigin: 'http://127.0.0.1:3333',
      },
      expect.objectContaining({ snapshot: expect.objectContaining({ online: true }) }),
    );
  });

  it('requires POST for debug control mutation and applies the expiring lease', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    const debugPermissionService = new DebugPermissionService();
    debugPermissionService.grant('debug:control', 60_000);
    const runtime = createTerminalHttpRuntime(createDeps({
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
      debugPermissionService,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/control', {
        enabled: true,
        ttlMs: 12345,
        reason: 'test',
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(200);
    expect(setDaemonRuntimeDebugLease).toHaveBeenCalledWith(true, 12345);
    expect(broadcastRuntimeDebugControl).toHaveBeenCalledWith(true, 'test', undefined);
    expect(recorder.readJson()).toMatchObject({
      ok: true,
      enabled: true,
      leaseMs: 12345,
    });
  });

  it('defaults debug control mutation to deny when no lease is granted', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/control', {
        enabled: true,
        ttlMs: 12345,
        reason: 'test',
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(403);
    expect(setDaemonRuntimeDebugLease).not.toHaveBeenCalled();
    expect(broadcastRuntimeDebugControl).not.toHaveBeenCalled();
  });

  it('rejects authenticated debug control mutation without an active grant', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({
      requiredAuthToken: 'secret',
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/control', {
        enabled: true,
        ttlMs: 12345,
        reason: 'test',
      }, { 'x-zterm-token': 'secret' }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(403);
    expect(setDaemonRuntimeDebugLease).not.toHaveBeenCalled();
    expect(broadcastRuntimeDebugControl).not.toHaveBeenCalled();
  });

  it('rejects expired debug control lease before applying a mutation', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    let now = 1_000;
    const debugPermissionService = new DebugPermissionService({ now: () => now });
    debugPermissionService.grant('debug:control', 50);
    now = 1_051;
    const runtime = createTerminalHttpRuntime(createDeps({
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
      debugPermissionService,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/control', {
        enabled: true,
        ttlMs: 12345,
        reason: 'test',
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(403);
    expect(setDaemonRuntimeDebugLease).not.toHaveBeenCalled();
    expect(broadcastRuntimeDebugControl).not.toHaveBeenCalled();
  });

  it('rejects debug control mutation on a non-loopback daemon without auth token', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({
      host: '0.0.0.0',
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/control', {
        enabled: true,
        ttlMs: 12345,
        reason: 'test',
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(401);
    expect(setDaemonRuntimeDebugLease).not.toHaveBeenCalled();
    expect(broadcastRuntimeDebugControl).not.toHaveBeenCalled();
  });

  it('rejects GET debug control without mutating daemon debug state', async () => {
    const setDaemonRuntimeDebugLease = vi.fn();
    const broadcastRuntimeDebugControl = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({
      setDaemonRuntimeDebugLease,
      broadcastRuntimeDebugControl,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('GET', '/debug/runtime/control?enabled=1', null),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(405);
    expect(setDaemonRuntimeDebugLease).not.toHaveBeenCalled();
    expect(broadcastRuntimeDebugControl).not.toHaveBeenCalled();
  });

  it('defaults to deny unauthenticated client debug uploads', async () => {
    const handleClientDebugLog = vi.fn();
    const runtime = createTerminalHttpRuntime(createDeps({
      requiredAuthToken: 'secret',
      handleClientDebugLog,
    }));
    const recorder = responseRecorder();

    await runtime.handleHttpRequest(
      request('POST', '/debug/runtime/logs', {
        kind: 'logs',
        payload: { entries: [{ seq: 1, ts: '', scope: 'test' }] },
      }),
      recorder.response,
    );

    expect(recorder.response.statusCode).toBe(401);
    expect(handleClientDebugLog).not.toHaveBeenCalled();
  });
});
