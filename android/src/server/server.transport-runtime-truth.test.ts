import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readTransportRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-transport-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 2200) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server transport runtime truth gates', () => {
  it('keeps server glue delegating transport wrappers and delivery to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalTransportRuntime');
    expect(source).toContain('const terminalTransportRuntime = createTerminalTransportRuntime({');
    expect(source).toContain('createWebSocketSessionTransport,');
    expect(source).toContain('createRtcSessionTransport,');
    expect(source).toContain('sendTransportMessage,');
    expect(source).toContain('sendMessage,');
    expect(source).toContain('broadcastRuntimeDebugControl,');
    expect(source).toContain('createTransportConnection,');
    expect(source).toContain('} = terminalTransportRuntime;');
  });

  it('does not keep transport delivery implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function createWebSocketSessionTransport(');
    expect(source).not.toContain('function createRtcSessionTransport(');
    expect(source).not.toContain('function sendTransportMessage(');
    expect(source).not.toContain('function sendMessage(');
    expect(source).not.toContain('function broadcastRuntimeDebugControl(');
    expect(source).not.toContain('function createTransportConnection(');
  });

  it('keeps transport delivery implementations inside dedicated runtime', () => {
    const source = readTransportRuntimeSource();
    const wsBlock = extractBlock(source, 'function createWebSocketSessionTransport(');
    const sendBlock = extractBlock(source, 'function sendMessage(');
    const connectionBlock = extractBlock(source, 'function createTransportConnection(');

    expect(wsBlock).toContain("kind: 'ws'");
    expect(wsBlock).toContain('ws.close(1000, reason)');
    expect(sendBlock).toContain("message.type === 'buffer-sync' || message.type === 'connected'");
    expect(sendBlock).toContain("deps.daemonRuntimeDebug('send'");
    expect(connectionBlock).toContain('transportId: uuidv4()');
    expect(connectionBlock).toContain("role: 'pending'");
  });
});
