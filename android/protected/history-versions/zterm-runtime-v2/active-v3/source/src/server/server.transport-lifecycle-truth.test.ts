import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readMessageRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-message-runtime.ts'), 'utf8');
}

function readDaemonControlGatewayRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'daemon-control-gateway-runtime.ts'), 'utf8');
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

function readTerminalRuntimeTypesSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-runtime-types.ts'), 'utf8');
}

function readTerminalMirrorRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-mirror-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 600) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server transport/session lifecycle truth gates', () => {
  it('keeps control transport separate from session transport attach flow', () => {
    const serverSource = readServerSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const controlGatewaySource = readDaemonControlGatewayRuntimeSource();
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const attachTokenRuntimeSource = readAttachTokenRuntimeSource();
    expect(serverSource).toContain('createTerminalMessageRuntime');
    expect(serverSource).toContain('createTerminalAttachTokenRuntime');
    expect(messageRuntimeSource).toContain("case 'session-open'");
    expect(messageRuntimeSource).not.toContain('takeSessionTransportTicket');
    expect(messageRuntimeSource).toContain('controlGateway.handleSessionOpen');
    expect(messageRuntimeSource).toContain('controlGateway.handleSessionTransportConnect');
    expect(controlGatewaySource).toContain('handleSessionOpenMessageRuntime');
    expect(controlGatewaySource).toContain('handleSessionTransportConnectRuntime');
    expect(controlRuntimeSource).toContain("type: 'session-ticket'");
    expect(attachTokenRuntimeSource).toContain('issueSessionTransportToken()');
    expect(attachTokenRuntimeSource).toContain('function consumeSessionTransportToken(token: string)');
    expect(attachTokenRuntimeSource).toContain('const sessionTransportAttachTokens = new Set<string>()');
    expect(controlRuntimeSource).toContain('createTransportSubscriber');
    expect(controlRuntimeSource).not.toContain('createTransportBoundSession');
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
    expect(source).toContain('Attach handshake:');
    expect(source).toContain('session-ticket / sessionTransportToken remain attach-only wire material');
    expect(source).toContain('openRequestId is wire correlation only and is not daemon-owned state');
    expect(source).toContain('daemon does not keep openRequestId as token owner');
  });

  it('does not keep or echo legacy clientSessionId in daemon wire ownership', () => {
    const controlSource = readMessageControlRuntimeSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const attachTokenRuntimeSource = readAttachTokenRuntimeSource();

    expect(controlSource).not.toContain('clientSessionId');
    expect(messageRuntimeSource).not.toContain('clientSessionId');
    expect(attachTokenRuntimeSource).not.toContain('clientSessionId');
  });

  it('does not keep websocket-close grace timers that auto-close bound sessions', () => {
    const source = readServerSource();
    expect(source).not.toContain('_detachTimer');
    expect(source).not.toContain('grace expired');
    expect(source).not.toContain('grace timer handles cleanup');
  });

  it('detaches bound websocket transports instead of closing logical sessions on ws close/error', () => {
    const source = readBridgeRuntimeSource();
    const closeBlock = extractBlock(source, "ws.on('close'");
    const errorBlock = extractBlock(source, "ws.on('error'");
    const detachBlock = extractBlock(source, 'function detachConnectionSubscribers', 900);
    expect(closeBlock).toContain("detachConnectionSubscribers(connection, 'websocket closed')");
    expect(closeBlock).not.toContain("closeTransportSubscriber(session, 'websocket closed', false)");
    expect(errorBlock).toContain("detachConnectionSubscribers(connection, `websocket error: ${error.message}`)");
    expect(errorBlock).not.toContain("closeTransportSubscriber(session, `websocket error: ${error.message}`, false)");
    expect(detachBlock).toContain('connection.boundSubscriberId');
    expect(detachBlock).toContain('deps.listMuxChannelSubscriberIds(connection)');
    expect(detachBlock).toContain('if (!subscriber)');
    expect(detachBlock).toContain('deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId)');
    expect(detachBlock).toContain('deps.releaseAllMuxChannelSubscribers(connection)');
  });

  it('detaches bound rtc transports instead of closing logical sessions on rtc close/error', () => {
    const source = readBridgeRuntimeSource();
    const rtcCloseBlock = extractBlock(source, 'onClose: (_transportId, reason) =>');
    const rtcErrorBlock = extractBlock(source, 'onError: (_transportId, message) =>');
    expect(rtcCloseBlock).toContain('detachConnectionSubscribers(connection, reason)');
    expect(rtcCloseBlock).not.toContain('closeTransportSubscriber(session, reason, false)');
    expect(rtcErrorBlock).toContain('detachConnectionSubscribers(connection, `rtc error: ${message}`)');
    expect(rtcErrorBlock).not.toContain('closeTransportSubscriber(session, `rtc error: ${message}`, false)');
  });

  it('keeps daemon mux channel registry mutation in the channel mux owner', () => {
    const channelMuxSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-channel-mux-runtime.ts'), 'utf8');
    const bridgeSource = readBridgeRuntimeSource();
    const daemonRuntimeSource = readDaemonRuntimeSource();
    const muxChannelRuntimeSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-mux-channel-runtime.ts'), 'utf8');

    expect(channelMuxSource).toContain('function ensureMuxChannels');
    expect(channelMuxSource).toContain('ensureMuxChannels(connection).set(normalizedChannelId, subscriber.id)');
    expect(channelMuxSource).toContain('function releaseAllMuxChannelSubscribers');
    expect(bridgeSource).toContain('deps.listMuxChannelSubscriberIds(connection)');
    expect(bridgeSource).toContain('deps.releaseAllMuxChannelSubscribers(connection)');
    expect(bridgeSource).not.toContain('connection.muxChannels?.clear()');
    expect(daemonRuntimeSource).toContain('deps.listMuxChannelSubscriberIds(connection)');
    expect(daemonRuntimeSource).toContain('deps.releaseAllMuxChannelSubscribers(connection)');
    expect(daemonRuntimeSource).not.toContain('connection.muxChannels?.clear()');
    expect(muxChannelRuntimeSource).not.toContain('connection.muxChannels = new Map()');
    expect(muxChannelRuntimeSource).not.toContain('connection.muxChannels?.delete');
    expect(muxChannelRuntimeSource).not.toContain('connection.muxChannels.delete');
  });

  it('detaches stale bound daemon transports without destroying mirror or tmux session truth', () => {
    const daemonRuntimeSource = readDaemonRuntimeSource();
    const heartbeatBlock = extractBlock(daemonRuntimeSource, 'function startHeartbeatLoop(', 3600);

    expect(heartbeatBlock).toContain('TERMINAL_TRANSPORT_STALE_INBOUND_MS');
    expect(heartbeatBlock).toContain('connection.boundSubscriberId');
    expect(heartbeatBlock).toContain('deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId)');
    expect(heartbeatBlock).toContain('connection.closeTransport(reason)');
    expect(heartbeatBlock).not.toContain('deps.destroyMirror(');
    expect(heartbeatBlock).not.toContain('closeTransportSubscriber(');
    expect(heartbeatBlock).not.toContain('kill-session');
  });

  it('keeps mirror truth alive when session transport detaches or session closes', () => {
    const serverSource = readServerSource();
    const bridgeSource = readBridgeRuntimeSource();
    const wsCloseBlock = extractBlock(bridgeSource, "ws.on('close'");
    const rtcCloseBlock = extractBlock(bridgeSource, 'onClose: (_transportId, reason) =>');

    expect(serverSource).toContain('terminalRuntime.closeTransportSubscriber');
    expect(wsCloseBlock).not.toContain('destroyMirror(');
    expect(rtcCloseBlock).not.toContain('destroyMirror(');
  });

  it('does not keep client-style state machine fields in daemon terminal core', () => {
    const source = readServerSource();
    const runtimeTypesSource = readTerminalRuntimeTypesSource();
    const mirrorRuntimeSource = readTerminalMirrorRuntimeSource();
    expect(source).not.toContain("state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed'");
    expect(source).not.toContain('session.state =');
    expect(source).not.toContain('mirror.state =');
    expect(source).not.toContain('terminalWidthMode:');
    expect(source).not.toContain('requestedAdaptiveCols:');
    expect(runtimeTypesSource).not.toContain('widthMode: TerminalWidthMode;');
    expect(runtimeTypesSource).not.toContain('adaptiveCols:');
    expect(mirrorRuntimeSource).not.toContain('session.widthMode');
    expect(mirrorRuntimeSource).not.toContain('mirror.adaptiveCols');
    expect(mirrorRuntimeSource).not.toContain('function applyAdaptiveColsToTmuxMirror');
    expect(mirrorRuntimeSource).not.toContain('function applyTmuxWindowGeometryToSession');
    expect(mirrorRuntimeSource).not.toContain('function releaseTmuxWindowSizePolicyToLatest');
    expect(mirrorRuntimeSource).toContain('function clearAdaptiveWidthLeaseAggregate');
    expect(mirrorRuntimeSource).toContain('function applyAdaptiveTmuxWidth');
    expect(mirrorRuntimeSource).toContain('function releaseAdaptiveTmuxWidth');
    const reconcileLeaseBlock = extractBlock(mirrorRuntimeSource, 'function reconcileAdaptiveWidthLeases', 2200);
    expect(reconcileLeaseBlock).not.toContain('mirror.cols = targetCols');
    expect(reconcileLeaseBlock).not.toContain('writeMirrorBaselineGeometry(mirror, {');
    const applyAdaptiveBlock = extractBlock(mirrorRuntimeSource, 'function applyAdaptiveTmuxWidth', 2400);
    const releaseAdaptiveBlock = extractBlock(mirrorRuntimeSource, 'function releaseAdaptiveTmuxWidth', 2400);
    expect(applyAdaptiveBlock).toContain("deps.runTmux(['resize-window'");
    expect(releaseAdaptiveBlock).toContain("deps.runTmux(['resize-window'");
    expect(releaseAdaptiveBlock).toContain("'window-size'");
    const runtimeWithoutAdaptiveOwnerBlocks = mirrorRuntimeSource
      .replace(applyAdaptiveBlock, '')
      .replace(releaseAdaptiveBlock, '');
    expect(runtimeWithoutAdaptiveOwnerBlocks).not.toContain("runTmux(['resize-window'");
    expect(runtimeWithoutAdaptiveOwnerBlocks).not.toContain("deps.runTmux(['resize-window'");
    expect(runtimeWithoutAdaptiveOwnerBlocks).not.toContain("'window-size'");
    expect(mirrorRuntimeSource).not.toContain('@zterm_adaptive_width_');
  });

  it('only destroys mirror truth on explicit tmux kill or daemon shutdown', () => {
    const source = readServerSource();
    const daemonRuntimeSource = readDaemonRuntimeSource();
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const killBlock = extractBlock(controlRuntimeSource, "case 'tmux-kill-session':", 900);
    const shutdownBlock = extractBlock(daemonRuntimeSource, 'function shutdownDaemon', 2200);
    const destroyBlock = extractBlock(source, 'terminalRuntime.destroyMirror', 220);

    expect(killBlock).toContain("destroyMirror(mirror, 'tmux session killed', {");
    expect(killBlock).toContain("closeTransportSubscribers: false");
    expect(killBlock).toContain("releaseCode: 'tmux_session_killed'");
    expect(source).toContain('createTerminalDaemonRuntime');
    expect(shutdownBlock).toContain('deps.destroyMirror(mirror, reason, {');
    expect(shutdownBlock).toContain('closeTransportSubscribers: true');
    expect(shutdownBlock).toContain('notifyClientClose: true');
    expect(destroyBlock).toContain('terminalRuntime.destroyMirror');
    expect(destroyBlock).not.toContain("sendMessage(client, { type: 'closed'");
  });

  it('reconnect path closes only the replaced old transport and binds the new transport as current truth', () => {
    const source = readServerSource();
    const bindBlock = extractBlock(source, 'terminalRuntime.bindConnectionToSubscriber', 240);

    expect(bindBlock).toContain('terminalRuntime.bindConnectionToSubscriber');
  });

  it('does not keep logical/client session naming for daemon subscriber ownership', () => {
    const serverSource = readServerSource();
    const bridgeSource = readBridgeRuntimeSource();
    const controlSource = readMessageControlRuntimeSource();
    const messageSource = readMessageRuntimeSource();
    const transportTypesSource = readTerminalRuntimeTypesSource();
    const httpSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-http-runtime.ts'), 'utf8');

    const source = [
      serverSource,
      bridgeSource,
      controlSource,
      messageSource,
      transportTypesSource,
      httpSource,
    ].join('\n');

    expect(source).not.toContain('boundSessionId');
    expect(source).not.toContain('createTransportBoundSession');
    expect(source).not.toContain('bindConnectionToSession');
    expect(source).not.toContain('detachSessionTransportOnly');
    expect(source).not.toContain('clientSessions');
    expect(source).toContain('boundSubscriberId');
    expect(source).toContain('transportSubscribers');
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

  it('keeps only resize as the adaptive-width update entry and does not keep legacy terminal-width-mode handler', () => {
    const source = readMessageRuntimeSource();
    expect(source).toContain("case 'resize':");
    expect(source).not.toContain("case 'terminal-width-mode':");
  });

  it('never falls back to raw terminal input when image-upload binary arrives without pending paste state', () => {
    const serverSource = readServerSource();
    const messageRuntimeSource = readMessageRuntimeSource();
    const binaryBlock = extractBlock(messageRuntimeSource, 'deps.fileTransferMessageRuntime.handleBinaryPayload(session, binaryBuffer)', 180);

    expect(serverSource).toContain('createTerminalFileTransferRuntime');
    expect(binaryBlock).toContain('deps.fileTransferMessageRuntime.handleBinaryPayload(session, binaryBuffer)');
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

  it('does not mutate tmux alternate-screen while checking or mirroring sessions', () => {
    const serverSource = readServerSource();
    const controlSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-control-runtime.ts'), 'utf8');

    expect(serverSource).not.toContain('ensureTmuxSessionAlternateScreenDisabled');
    expect(controlSource).not.toContain('ensureTmuxSessionAlternateScreenDisabled');
    expect(controlSource).not.toContain("runTmux(['set-option', '-t', sessionName, 'alternate-screen', 'off'])");
    expect(controlSource).not.toMatch(/set-(?:window-)?option['"][\s\S]*alternate-screen/);
  });

  it('never implicitly creates a missing tmux session during attach; explicit creation stays on tmux-create-session only', () => {
    const source = readServerSource();
    const mirrorRuntimeSource = readFileSync(join(process.cwd(), 'src', 'server', 'terminal-mirror-runtime.ts'), 'utf8');
    const controlRuntimeSource = readMessageControlRuntimeSource();
    const startMirrorBlock = extractBlock(mirrorRuntimeSource, 'async function startMirror(', 1200);
    const createBlock = extractBlock(controlRuntimeSource, "case 'tmux-create-session':", 420);

    expect(source).toContain('assertTmuxSessionExists: (sessionName, backend) => {');
    expect(source).toContain("'has-session', '-t', terminalControlRuntime.buildExactTmuxSessionTarget(sessionName)");
    expect(source).not.toContain("runTmux(['new-session', '-d', '-s', sessionName");
    expect(startMirrorBlock).toContain('deps.assertTmuxSessionExists(mirror.sessionName, mirror.backend);');
    expect(startMirrorBlock).not.toContain('new-session');
    expect(createBlock).toContain('deps.createDetachedTmuxSession(message.payload.sessionName, message.payload.cwd, backend');
  });
});
