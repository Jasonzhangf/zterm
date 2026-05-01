import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readDaemonRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-daemon-runtime.ts'), 'utf8');
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
    expect(heartbeatBlock).toContain("connection.transport.close('heartbeat timeout')");
    expect(heartbeatBlock).toContain('connection.transport.ping?.()');
    expect(shutdownBlock).toContain('deps.shutdownClientSessions(deps.sessions, reason)');
    expect(shutdownBlock).toContain('deps.destroyMirror(mirror, reason, {');
    expect(shutdownBlock).toContain('deps.server.close((error) => {');
  });
});
