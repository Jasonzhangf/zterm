import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readBridgeRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-bridge-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 2600) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server bridge runtime truth gates', () => {
  it('keeps server glue delegating ws/rtc/upgrade bridge handling to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalBridgeRuntime');
    expect(source).toContain('const terminalBridgeRuntime = createTerminalBridgeRuntime({');
    expect(source).toContain('rtcBridgeServer,');
    expect(source).toContain('handleWebSocketConnection,');
    expect(source).toContain('handleServerUpgrade,');
    expect(source).toContain('handleRelaySignal,');
    expect(source).toContain('closeRelayPeer,');
    expect(source).toContain('} = terminalBridgeRuntime;');
    expect(source).toContain("wss.on('connection', handleWebSocketConnection)");
    expect(source).toContain("server.on('upgrade', handleServerUpgrade)");
  });

  it('does not keep ws/rtc/upgrade bridge implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain("wss.on('connection', (ws: WebSocket, request) =>");
    expect(source).not.toContain("server.on('upgrade', (request, socket, head) =>");
    expect(source).not.toContain('const rtcBridgeServer = createRtcBridgeServer({');
  });

  it('keeps ws/rtc/upgrade bridge implementations inside dedicated runtime', () => {
    const source = readBridgeRuntimeSource();
    const rtcBlock = extractBlock(source, 'const rtcBridgeServer = createRtcBridgeServer({', 2600);
    const wsBlock = extractBlock(source, 'function handleWebSocketConnection(');
    const upgradeBlock = extractBlock(source, 'function handleServerUpgrade(');

    expect(rtcBlock).toContain("deps.detachSessionTransportOnly(session, reason, connection.transportId)");
    expect(rtcBlock).toContain('deps.connections.delete(connection.id)');
    expect(wsBlock).toContain("ws.on('close', () => {");
    expect(wsBlock).toContain("deps.detachSessionTransportOnly(session, 'websocket closed', connection.transportId)");
    expect(upgradeBlock).toContain("if (pathname === '/signal')");
    expect(upgradeBlock).toContain("if (pathname !== '/' && pathname !== '/ws')");
  });
});
