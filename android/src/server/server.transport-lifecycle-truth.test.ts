import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 420) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server transport/session lifecycle truth gates', () => {
  it('keeps control transport separate from session transport attach flow', () => {
    const source = readServerSource();
    expect(source).toContain("case 'session-open'");
    expect(source).toContain("type: 'session-ticket'");
    expect(source).toContain('takeSessionTransportTicket');
  });

  it('does not keep websocket-close grace timers that auto-close logical sessions', () => {
    const source = readServerSource();
    expect(source).not.toContain('_detachTimer');
    expect(source).not.toContain('grace expired');
    expect(source).not.toContain('grace timer handles cleanup');
  });

  it('detaches bound websocket transports instead of closing logical sessions on ws close/error', () => {
    const source = readServerSource();
    const closeBlock = extractBlock(source, "ws.on('close'");
    const errorBlock = extractBlock(source, "ws.on('error'");
    const detachBlock = extractBlock(source, 'function detachClientSessionTransportOnly', 520);
    expect(closeBlock).toContain("if (session?.logicalSessionBound)");
    expect(closeBlock).toContain("detachClientSessionTransportOnly(session, 'websocket closed'");
    expect(closeBlock).not.toContain("closeLogicalClientSession(session, 'websocket closed', false)");
    expect(errorBlock).toContain("if (session?.logicalSessionBound)");
    expect(errorBlock).toContain("detachClientSessionTransportOnly(session, `websocket error: ${error.message}`");
    expect(errorBlock).not.toContain("closeLogicalClientSession(session, `websocket error: ${error.message}`, false)");
    expect(detachBlock).toContain('if (transportId && session.transportId !== transportId)');
  });

  it('detaches bound rtc transports instead of closing logical sessions on rtc close/error', () => {
    const source = readServerSource();
    const rtcCloseBlock = extractBlock(source, 'onClose: (_transportId, reason) =>');
    const rtcErrorBlock = extractBlock(source, 'onError: (_transportId, message) =>');
    expect(rtcCloseBlock).toContain('if (session?.logicalSessionBound)');
    expect(rtcCloseBlock).toContain('detachClientSessionTransportOnly(session, reason');
    expect(rtcCloseBlock).not.toContain('closeLogicalClientSession(session, reason, false)');
    expect(rtcErrorBlock).toContain('if (session?.logicalSessionBound)');
    expect(rtcErrorBlock).toContain('detachClientSessionTransportOnly(session, `rtc error: ${message}`');
    expect(rtcErrorBlock).not.toContain('closeLogicalClientSession(session, `rtc error: ${message}`, false)');
  });

  it('keeps mirror truth alive when session transport detaches or logical session closes', () => {
    const source = readServerSource();
    const closeSessionBlock = extractBlock(source, 'function closeLogicalClientSession');
    const wsCloseBlock = extractBlock(source, "ws.on('close'");
    const rtcCloseBlock = extractBlock(source, 'onClose: (_transportId, reason) =>');

    expect(closeSessionBlock).toContain('detachMirrorSubscriber');
    expect(closeSessionBlock).not.toContain('destroyMirror(');
    expect(wsCloseBlock).not.toContain('destroyMirror(');
    expect(rtcCloseBlock).not.toContain('destroyMirror(');
  });

  it('only destroys mirror truth on explicit tmux kill or daemon shutdown', () => {
    const source = readServerSource();
    const killBlock = extractBlock(source, "case 'tmux-kill-session':", 900);
    const shutdownBlock = extractBlock(source, 'function shutdownDaemon', 1200);

    expect(killBlock).toContain("destroyMirror(mirror, 'tmux session killed')");
    expect(shutdownBlock).toContain('destroyMirror(mirror, reason, true)');
  });

  it('reconnect path closes only the replaced old transport and binds the new transport as current truth', () => {
    const source = readServerSource();
    const bindBlock = extractBlock(source, 'function bindTransportConnectionToLogicalSession', 1200);

    expect(bindBlock).toContain('const replacedTransportId = attachClientSessionTransport(');
    expect(bindBlock).toContain("session.transport.close('transport replaced by reconnect')");
    expect(bindBlock).toContain('session.transport = connection.transport');
    expect(bindBlock).toContain('connection.boundSessionId = session.id');
  });

  it('keeps tmux discovery and management on control transport semantics', () => {
    const source = readServerSource();
    const listSessionsBlock = extractBlock(source, "case 'list-sessions':");
    const createBlock = extractBlock(source, "case 'tmux-create-session':");
    const renameBlock = extractBlock(source, "case 'tmux-rename-session':");
    const killBlock = extractBlock(source, "case 'tmux-kill-session':");

    expect(listSessionsBlock).not.toContain('requires an attached session transport');
    expect(createBlock).not.toContain('requires an attached session transport');
    expect(renameBlock).not.toContain('requires an attached session transport');
    expect(killBlock).not.toContain('requires an attached session transport');
  });

  it('never falls back to raw terminal input when image-upload binary arrives without pending paste state', () => {
    const source = readServerSource();
    const block = extractBlock(source, 'function handlePasteImageBinary');

    expect(block).toContain('paste_image_no_pending');
    expect(block).not.toContain("handleInput(session, buffer.toString('utf-8'))");
  });

  it('uses a local-time log helper instead of raw UTC toISOString timestamps', () => {
    const source = readServerSource();
    expect(source).toMatch(/function formatLocalLogTimestamp\([^)]*\)/);
    expect(source).toMatch(/function logTimePrefix\([^)]*\)/);
    expect(source).not.toContain('new Date().toISOString()');
  });

  it('does not require an embedded interactive tmux pty client for daemon control truth', () => {
    const source = readServerSource();
    expect(source).not.toContain("import * as pty from 'node-pty'");
    expect(source).not.toContain("pty.spawn(TMUX_BINARY, ['new-session', '-A', '-s', mirror.sessionName]");
    expect(source).not.toContain('mirror.ptyProcess.write(');
    expect(source).not.toContain('mirror.ptyProcess.resize(');
    expect(source).toContain("runTmux(['send-keys'");
    expect(source).toContain("runTmux(['resize-window'");
  });
});
