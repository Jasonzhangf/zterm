import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readDaemonRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-daemon-runtime.ts'), 'utf8');
}

function readPerformanceSchedulerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-performance-scheduler.ts'), 'utf8');
}

function readPreparedDaemonReleaseSource() {
  return readFileSync(
    join(process.cwd(), 'release-dist', 'zterm-daemon-0.1.3-darwin-arm64', 'runtime', 'server.cjs'),
    'utf8',
  );
}

function extractBlock(source: string, anchor: string, length = 2600) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server daemon runtime truth gates', () => {
  it('keeps server glue delegating daemon service helpers to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalDaemonRuntime');
    expect(source).toContain('const terminalDaemonRuntime = createTerminalDaemonRuntime({');
    expect(source).toContain('extractAuthToken,');
    expect(source).toContain('startHeartbeatLoop,');
    expect(source).toContain('startMemoryGuardLoop,');
    expect(source).toContain('shutdownDaemon,');
    expect(source).toContain('handleDaemonServerClosed,');
    expect(source).toContain('handleDaemonServerError,');
    expect(source).toContain('handleDaemonServerListening,');
    expect(source).toContain('} = terminalDaemonRuntime;');
  });

  it('does not keep daemon service helper implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function resolveTmuxBinary(');
    expect(source).not.toContain('function extractAuthToken(');
    expect(source).not.toContain('function shutdownDaemon(');
    expect(source).not.toContain('const heartbeatTimer = setInterval(');
    expect(source).not.toContain('const memoryGuardTimer = setInterval(');
  });

  it('keeps daemon service helper implementations inside dedicated runtime', () => {
    const source = readDaemonRuntimeSource();
    const authBlock = extractBlock(source, 'function extractAuthToken(');
    const heartbeatBlock = extractBlock(source, 'function startHeartbeatLoop(');
    const shutdownBlock = extractBlock(source, 'function shutdownDaemon(', 3200);

    expect(source).toContain('export function resolveTmuxBinary()');
    expect(authBlock).toContain("new URL(rawUrl || '/', 'ws://localhost')");
    expect(heartbeatBlock).toContain('heartbeat missed pong');
    expect(heartbeatBlock).not.toContain("connection.transport.close('heartbeat timeout')");
    expect(heartbeatBlock).toContain('connection.transport.ping?.()');
    expect(heartbeatBlock).toContain('TERMINAL_TRANSPORT_STALE_INBOUND_MS');
    expect(heartbeatBlock).toContain('deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId)');
    expect(heartbeatBlock).toContain('connection.closeTransport(reason)');
    expect(shutdownBlock).toContain('deps.shutdownTerminalSessions(deps.sessions, reason)');
    expect(shutdownBlock).toContain('deps.destroyMirror(mirror, reason, {');
    expect(shutdownBlock).toContain('deps.server.close((error) => {');
  });

  it('keeps daemon performance scheduler free of client UI state', () => {
    const source = readPerformanceSchedulerSource();

    expect(source).not.toMatch(/activeSessionId|activeTab|foreground|background/);
    expect(source).not.toMatch(/follow|reading|visibleRange|viewport|paneLayout/);
    expect(source).toContain('transportBufferedBytes');
    expect(source).toContain('lastCaptureDurationMs');
  });

  it('keeps the prepared daemon release runtime aligned with terminal mux protocol support', () => {
    const source = readPreparedDaemonReleaseSource();

    expect(source).toContain('mux-hello');
    expect(source).toContain('mux-ready');
    expect(source).toContain('mux-channel-open');
    expect(source).toContain('mux-channel-opened');
    expect(source).toContain('mux-channel-message');
  });
});
