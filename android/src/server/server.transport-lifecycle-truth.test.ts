import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readMessageRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-message-runtime.ts'), 'utf8');
}

function readMessageControlRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-message-control-runtime.ts'), 'utf8');
}

function readAttachTokenRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-attach-token-runtime.ts'), 'utf8');
}

function readDebugRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-debug-runtime.ts'), 'utf8');
}

function readDaemonRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-daemon-runtime.ts'), 'utf8');
}

function readBridgeRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-bridge-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 420) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server transport/session lifecycle truth gates', () => {
  it('keeps control transport separate from session transport attach flow', () => {
    const serverSource = readServerSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const attachTokenRuntimeSource = readAttachTokenRuntimeSource();
    expect(serverSource).toContain('createTerminalMessageRuntime');
    expect(serverSource).toContain('createTerminalAttachTokenRuntime');
    expect(messageRuntimeSource).toContain("case 'session-open'");
    expect(messageRuntimeSource).not.toContain('takeSessionTransportTicket');
    expect(messageRuntimeSource).toContain('handleSessionOpenMessageRuntime');
    expect(messageRuntimeSource).toContain('handleSessionTransportConnectRuntime');
    expect(controlRuntimeSource).toContain("type: 'session-ticket'");
    expect(attachTokenRuntimeSource).toContain('issueSessionTransportToken()');
    expect(attachTokenRuntimeSource).toContain('function consumeSessionTransportToken(token: string)');
    expect(attachTokenRuntimeSource).toContain('const sessionTransportAttachTokens = new Set<string>()');
    expect(controlRuntimeSource).toContain('createTransportBoundSession');
  });

  it('keeps attach token runtime outside server.ts so daemon glue stays thinner', () => {
    const serverSource = readServerSource();
    const attachTokenRuntimeSource = readAttachTokenRuntimeSource();
    expect(serverSource).toContain('createTerminalAttachTokenRuntime');
    expect(serverSource).not.toContain('const sessionTransportAttachTokens = new Map<string, string>()');
    expect(serverSource).not.toContain('const sessionTransportAttachTokens = new Set<string>()');
    expect(attachTokenRuntimeSource).toContain('const sessionTransportAttachTokens = new Set<string>()');
  });

  it('documents session-ticket/sessionTransportToken as attach-only compatibility wire material', () => {
    const source = readMessageControlRuntimeSource();
    expect(source).toContain('Compatibility-only attach handshake:');
    expect(source).toContain('session-ticket / sessionTransportToken remain attach-only wire material');
    expect(source).toContain('daemon must not promote either into daemon-owned long-lived business truth');
    expect(source).toContain('openRequestId remains client-local request correlation');
    expect(source).toContain('daemon does not keep openRequestId as token owner');
  });

  it('keeps legacy clientSessionId only as wire-echo compatibility instead of restoring daemon ownership', () => {
    const controlSource = readMessageControlRuntimeSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const attachTokenRuntimeSource = readAttachTokenRuntimeSource();

    expect(controlSource).toContain('clientSessionId: payload.clientSessionId?.trim() || undefined');
    expect(messageRuntimeSource).toContain('clientSessionId: message.payload?.clientSessionId?.trim() || undefined');
    expect(attachTokenRuntimeSource).not.toContain('clientSessionId');
    expect(controlSource).not.toContain('payload.clientSessionId) =>');
    expect(controlSource).not.toContain('clientSessionId, sessionTransportToken');
  });

  it('does not keep websocket-close grace timers that auto-close bound sessions', () => {
    const source = readServerSource();
    expect(source).not.toContain('_detachTimer');
    expect(source).not.toContain('grace expired');
    expect(source).not.toContain('grace timer handles cleanup');
  });

  it('detaches bound websocket transports instead of closing bound sessions on ws close/error', () => {
    const source = readBridgeRuntimeSource();
    const closeBlock = extractBlock(source, "ws.on('close'");
    const errorBlock = extractBlock(source, "ws.on('error'");
    const detachBlock = extractBlock(source, "deps.detachSessionTransportOnly(session, 'websocket closed'", 220);
    expect(closeBlock).toContain("if (session)");
    expect(closeBlock).toContain("deps.detachSessionTransportOnly(session, 'websocket closed'");
    expect(closeBlock).not.toContain("closeLogicalTerminalSession(session, 'websocket closed', false)");
    expect(errorBlock).toContain("if (session)");
    expect(errorBlock).toContain("deps.detachSessionTransportOnly(session, `websocket error: ${error.message}`");
    expect(errorBlock).not.toContain("closeLogicalTerminalSession(session, `websocket error: ${error.message}`, false)");
    expect(detachBlock).toContain("deps.detachSessionTransportOnly(session, 'websocket closed'");
  });

  it('detaches bound rtc transports instead of closing bound sessions on rtc close/error', () => {
    const source = readBridgeRuntimeSource();
    const rtcCloseBlock = extractBlock(source, 'onClose: (_transportId, reason) =>');
    const rtcErrorBlock = extractBlock(source, 'onError: (_transportId, message) =>');
    expect(rtcCloseBlock).toContain('if (session)');
    expect(rtcCloseBlock).toContain('deps.detachSessionTransportOnly(session, reason');
    expect(rtcCloseBlock).not.toContain('closeLogicalTerminalSession(session, reason, false)');
    expect(rtcErrorBlock).toContain('if (session)');
    expect(rtcErrorBlock).toContain('deps.detachSessionTransportOnly(session, `rtc error: ${message}`');
    expect(rtcErrorBlock).not.toContain('closeLogicalTerminalSession(session, `rtc error: ${message}`, false)');
  });

  it('keeps mirror truth alive when session transport detaches or session closes', () => {
    const serverSource = readServerSource();
    const bridgeSource = readBridgeRuntimeSource();
    const wsCloseBlock = extractBlock(bridgeSource, "ws.on('close'");
    const rtcCloseBlock = extractBlock(bridgeSource, 'onClose: (_transportId, reason) =>');

    expect(serverSource).toContain('terminalRuntime.closeSession');
    expect(wsCloseBlock).not.toContain('destroyMirror(');
    expect(rtcCloseBlock).not.toContain('destroyMirror(');
  });

  it('does not keep client-style state machine fields in daemon terminal core', () => {
    const source = readServerSource();
    expect(source).not.toContain("state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed'");
    expect(source).not.toContain('session.state =');
    expect(source).not.toContain('mirror.state =');
    expect(source).not.toContain('terminalWidthMode:');
    expect(source).not.toContain('requestedAdaptiveCols:');
  });

  it('only destroys mirror truth on explicit tmux kill or daemon shutdown', () => {
    const source = readServerSource();
    const daemonRuntimeSource = readDaemonRuntimeSource();
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const killBlock = extractBlock(controlRuntimeSource, "case 'tmux-kill-session':", 900);
    const shutdownBlock = extractBlock(daemonRuntimeSource, 'function shutdownDaemon', 2200);
    const destroyBlock = extractBlock(source, 'terminalRuntime.destroyMirror', 220);

    expect(killBlock).toContain("destroyMirror(mirror, 'tmux session killed', {");
    expect(killBlock).toContain("closeLogicalSessions: false");
    expect(killBlock).toContain("releaseCode: 'tmux_session_killed'");
    expect(source).toContain('createTerminalDaemonRuntime');
    expect(shutdownBlock).toContain('deps.destroyMirror(mirror, reason, {');
    expect(shutdownBlock).toContain('closeLogicalSessions: true');
    expect(shutdownBlock).toContain('notifyClientClose: true');
    expect(destroyBlock).toContain('terminalRuntime.destroyMirror');
    expect(destroyBlock).not.toContain("sendMessage(client, { type: 'closed'");
  });

  it('reconnect path closes only the replaced old transport and binds the new transport as current truth', () => {
    const source = readServerSource();
    const bindBlock = extractBlock(source, 'terminalRuntime.bindConnectionToSession', 240);

    expect(bindBlock).toContain('terminalRuntime.bindConnectionToSession');
  });

  it('keeps tmux discovery and management on control transport semantics', () => {
    const source = readMessageRuntimeSource();
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const listSessionsBlock = extractBlock(source, "case 'list-sessions':");
    const createBlock = extractBlock(controlRuntimeSource, "case 'tmux-create-session':");
    const renameBlock = extractBlock(controlRuntimeSource, "case 'tmux-rename-session':");
    const killBlock = extractBlock(controlRuntimeSource, "case 'tmux-kill-session':");

    expect(listSessionsBlock).not.toContain('requires an attached session transport');
    expect(createBlock).not.toContain('requires an attached session transport');
    expect(renameBlock).not.toContain('requires an attached session transport');
    expect(killBlock).not.toContain('requires an attached session transport');
  });

  it('physically removes legacy resize and terminal-width-mode handlers from daemon message runtime', () => {
    const source = readMessageRuntimeSource();
    expect(source).not.toContain("case 'resize':");
    expect(source).not.toContain("case 'terminal-width-mode':");
  });

  it('never falls back to raw terminal input when image-upload binary arrives without pending paste state', () => {
    const serverSource = readServerSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const binaryBlock = extractBlock(messageRuntimeSource, 'deps.terminalFileTransferRuntime.handleBinaryPayload(session, binaryBuffer)', 180);

    expect(serverSource).toContain('createTerminalFileTransferRuntime');
    expect(binaryBlock).toContain('deps.terminalFileTransferRuntime.handleBinaryPayload(session, binaryBuffer)');
  });

  it('uses dedicated debug runtime local-time log helpers instead of raw UTC toISOString timestamps', () => {
    const serverSource = readServerSource();
    const debugRuntimeSource = readDebugRuntimeSource();
    expect(serverSource).toContain('createTerminalDebugRuntime');
    expect(debugRuntimeSource).toMatch(/function formatLocalLogTimestamp\([^)]*\)/);
    expect(debugRuntimeSource).toMatch(/function logTimePrefix\([^)]*\)/);
    expect(debugRuntimeSource).not.toContain('new Date().toISOString()');
  });

  it('does not require an embedded interactive tmux pty client for daemon control truth', () => {
    const source = readServerSource();
    const controlRuntimeSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-control-runtime.ts'), 'utf8');
    expect(source).not.toContain("import * as pty from 'node-pty'");
    expect(source).not.toContain("pty.spawn(TMUX_BINARY, ['new-session', '-A', '-s', mirror.sessionName]");
    expect(source).not.toContain('mirror.ptyProcess.write(');
    expect(source).not.toContain('mirror.ptyProcess.resize(');
    expect(controlRuntimeSource).toContain("runTmux(['send-keys'");
    expect(controlRuntimeSource).not.toContain("runTmux(['resize-window'");
  });
});
