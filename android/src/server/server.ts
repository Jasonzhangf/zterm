/**
 * zterm Android WebSocket 服务端
 *
 * 目标：tmux/daemon 作为 authoritative terminal truth，移动端只接收 mirror。
 * daemon 只维护每个 tmux session 的 canonical buffer，并向客户端发送最新连续 buffer-sync。
 *
 * 修正：buffer 真源按 tmux session mirror 维护，而不是按 websocket/tab 各自维护。
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { join } from 'path';
import { homedir } from 'os';
import type {
  ServerMessage,
} from '../lib/types';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  WTERM_CONFIG_DISPLAY_PATH,
} from '../lib/mobile-config';
import { getWtermHomeDir, getWtermUpdatesDir, resolveDaemonRuntimeConfig } from './daemon-config';
import { createTraversalRelayHostClient } from './relay-client';
import { findChangedIndexedRanges } from './canonical-buffer';
import { buildBufferHeadPayload, buildChangedRangesBufferSyncPayload } from './buffer-sync-contract';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachGeometry } from './mirror-geometry';
import { createTerminalMirrorCaptureRuntime } from './terminal-mirror-capture';
import { dispatchScheduledJob } from './schedule-dispatch';
import { createRuntimeDebugStore, resolveDebugRouteLimit } from './runtime-debug-store';
import { loadScheduleStore, saveScheduleStore } from './schedule-store';
import {
  createTerminalRuntime,
  type TerminalSession,
  type SessionMirror,
} from './terminal-runtime';
import { createTerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import { createTerminalHttpRuntime } from './terminal-http-runtime';
import {
  createTerminalScheduleRuntime,
  type TerminalScheduleRuntime,
} from './terminal-schedule-runtime';
import {
  createTerminalControlRuntime,
  type TerminalControlRuntime,
} from './terminal-control-runtime';
import {
  createTerminalTransportRuntime,
  type DaemonTransportConnection,
} from './terminal-transport-runtime';
import { createTerminalDebugRuntime } from './terminal-debug-runtime';
import { createTerminalCoreSupport } from './terminal-core-support';
import {
  createTerminalDaemonRuntime,
  resolveTmuxBinary,
} from './terminal-daemon-runtime';
import { createTerminalBridgeRuntime } from './terminal-bridge-runtime';
import { createTerminalAttachTokenRuntime } from './terminal-attach-token-runtime';

const DAEMON_CONFIG = resolveDaemonRuntimeConfig();
const PORT = DAEMON_CONFIG.port || DEFAULT_BRIDGE_PORT;
const HOST = DAEMON_CONFIG.host || DEFAULT_DAEMON_HOST;

const TMUX_BINARY = resolveTmuxBinary();
const DEFAULT_SESSION_NAME = process.env.ZTERM_DEFAULT_SESSION || 'zterm';
const DAEMON_SESSION_NAME = DAEMON_CONFIG.sessionName || buildDaemonSessionName(PORT);
const HIDDEN_TMUX_SESSIONS = new Set([DAEMON_SESSION_NAME, DEFAULT_DAEMON_SESSION_NAME]);
const AUTO_COMMAND_DELAY_MS = 180;
const REQUIRED_AUTH_TOKEN = DAEMON_CONFIG.authToken;
const MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
const WTERM_HOME_DIR = getWtermHomeDir(homedir());
const UPDATES_DIR = getWtermUpdatesDir(homedir());
const UPLOAD_DIR = join(WTERM_HOME_DIR, 'uploads');
const DOWNLOADS_DIR = join(homedir(), 'Downloads', 'zterm');
const LOG_DIR = join(WTERM_HOME_DIR, 'logs');
const APP_UPDATE_VERSION_CODE = Number.parseInt(process.env.ZTERM_APP_UPDATE_VERSION_CODE || '', 10);
const APP_UPDATE_VERSION_NAME = (process.env.ZTERM_APP_UPDATE_VERSION_NAME || '').trim();
const APP_UPDATE_MANIFEST_URL = (process.env.ZTERM_APP_UPDATE_MANIFEST_URL || '').trim();
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const STARTUP_PORT_CONFLICT_EXIT_CODE = 78;
const DAEMON_RUNTIME_DEBUG = process.env.ZTERM_DAEMON_DEBUG_LOG === '1';
const MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES = 8;
const MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS = 900;
const MEMORY_GUARD_INTERVAL_MS = 30_000;
const MEMORY_GUARD_MAX_RSS_BYTES = 2.5 * 1024 * 1024 * 1024;
const MEMORY_GUARD_MAX_HEAP_USED_BYTES = 1.5 * 1024 * 1024 * 1024;

const sessions = new Map<string, TerminalSession>();
const connections = new Map<string, DaemonTransportConnection>();
const mirrors = new Map<string, SessionMirror>();
const scheduleStore = loadScheduleStore();
const clientRuntimeDebugStore = createRuntimeDebugStore();
const terminalAttachTokenRuntime = createTerminalAttachTokenRuntime();
let terminalScheduleRuntime: TerminalScheduleRuntime;
let terminalControlRuntime: TerminalControlRuntime;
let terminalTransportRuntimeSendMessage: (session: TerminalSession, message: ServerMessage) => void;
const terminalDebugRuntime = createTerminalDebugRuntime({
  daemonRuntimeDebugEnabled: DAEMON_RUNTIME_DEBUG,
  maxClientDebugBatchLogEntries: MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES,
  maxClientDebugLogPayloadChars: MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS,
  clientRuntimeDebugStore,
  sessions,
});
const terminalCoreSupport = createTerminalCoreSupport({
  defaultSessionName: DEFAULT_SESSION_NAME,
  maxCapturedScrollbackLines: MAX_CAPTURED_SCROLLBACK_LINES,
});
const {
  logTimePrefix,
  daemonRuntimeDebug,
  summarizePayload,
  handleClientDebugLog,
} = terminalDebugRuntime;
const {
  resolveMirrorCacheLines,
  sanitizeSessionName,
  getMirrorKey,
  mirrorCursorEqual,
  normalizeTerminalCols,
  normalizeTerminalRows,
  normalizeBufferSyncRequestPayload,
} = terminalCoreSupport;
const terminalMirrorCapture = createTerminalMirrorCaptureRuntime({
  resolveMirrorCacheLines,
  runTmux: (args) => terminalControlRuntime.runTmux(args),
  logTimePrefix,
});
const terminalRuntime = createTerminalRuntime({
  defaultSessionName: DEFAULT_SESSION_NAME,
  defaultViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
  sessions,
  mirrors,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  sendScheduleStateToSession: (session, sessionName) =>
    terminalScheduleRuntime.sendScheduleStateToSession(session, sessionName),
  buildConnectedPayload: (sessionId, requestOrigin) => terminalHttpRuntime.buildConnectedPayload(sessionId, requestOrigin),
  buildBufferHeadPayload: (sessionId, mirror) => buildBufferHeadPayload(sessionId, mirror),
  buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => buildChangedRangesBufferSyncPayload(mirror, changedRanges),
  sanitizeSessionName,
  getMirrorKey,
  normalizeTerminalCols,
  normalizeTerminalRows,
  resolveAttachGeometry,
  readTmuxPaneMetrics: (sessionName) => terminalMirrorCapture.readTmuxPaneMetrics(sessionName),
  ensureTmuxSession: (sessionName, cols, rows) => {
    const requestedTmuxRows = terminalMirrorCapture.resolveRequestedTmuxRows(rows);
    let sessionExists = true;
    try {
      terminalControlRuntime.runTmux(['has-session', '-t', sessionName]);
    } catch {
      sessionExists = false;
    }
    if (!sessionExists) {
      terminalControlRuntime.runTmux(['new-session', '-d', '-s', sessionName, '-x', String(cols), '-y', String(requestedTmuxRows)]);
    }
    terminalControlRuntime.ensureTmuxSessionAlternateScreenDisabled(sessionName);
  },
  captureMirrorAuthoritativeBufferFromTmux: terminalMirrorCapture.captureMirrorAuthoritativeBufferFromTmux,
  mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
    previousStartIndex,
    previousLines,
    nextStartIndex: mirror.bufferStartIndex,
    nextLines: mirror.bufferLines,
  }),
  mirrorCursorEqual,
  writeToLiveMirror: (sessionName, payload, appendEnter) =>
    terminalControlRuntime.writeToLiveMirror(sessionName, payload, appendEnter),
  writeToTmuxSession: (sessionName, payload, appendEnter) =>
    terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter),
  autoCommandDelayMs: AUTO_COMMAND_DELAY_MS,
  waitMs: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  daemonRuntimeDebug,
  logTimePrefix,
});
const terminalFileTransferRuntime = createTerminalFileTransferRuntime({
  uploadDir: UPLOAD_DIR,
  downloadsDir: DOWNLOADS_DIR,
  wtermHomeDir: WTERM_HOME_DIR,
  platform: process.platform,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  getSessionMirror: terminalRuntime.getSessionMirror,
  scheduleMirrorLiveSync: terminalRuntime.scheduleMirrorLiveSync,
  writeToTmuxSession: (sessionName, payload, appendEnter) =>
    terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter),
  writeToLiveMirror: (sessionName, payload, appendEnter) =>
    terminalControlRuntime.writeToLiveMirror(sessionName, payload, appendEnter),
  readTmuxPaneCurrentPath: (sessionName) => terminalMirrorCapture.readTmuxPaneCurrentPath(sessionName),
  runCommand: (command, args) => {
    terminalControlRuntime.runCommand(command, args);
  },
  logTimePrefix,
});

terminalControlRuntime = createTerminalControlRuntime({
  tmuxBinary: TMUX_BINARY,
  defaultSessionName: DEFAULT_SESSION_NAME,
  hiddenTmuxSessions: HIDDEN_TMUX_SESSIONS,
  mirrors,
  getMirrorKey,
  sanitizeSessionName,
});
const {
  runTmux,
  writeToTmuxSession,
  writeToLiveMirror,
  listTmuxSessions,
  createDetachedTmuxSession,
  renameTmuxSession,
} = terminalControlRuntime;
const terminalTransportRuntime = createTerminalTransportRuntime({
  sessions,
  connections,
  daemonRuntimeDebug,
  summarizePayload,
});
const {
  createWebSocketSessionTransport,
  createRtcSessionTransport,
  sendTransportMessage,
  sendMessage,
  broadcastRuntimeDebugControl,
  createTransportConnection,
} = terminalTransportRuntime;
terminalTransportRuntimeSendMessage = sendMessage;

terminalScheduleRuntime = createTerminalScheduleRuntime({
  initialJobs: scheduleStore.jobs,
  saveJobs: (jobs) => {
    saveScheduleStore(jobs);
  },
  executeJob: async (job) =>
    dispatchScheduledJob(
      {
        writeToLiveMirror,
        writeToTmuxSession,
      },
      job,
    ),
  sessions,
  sendMessage,
});
const { scheduleEngine, sendScheduleStateToSession } = terminalScheduleRuntime;

const terminalHttpRuntime = createTerminalHttpRuntime({
  host: HOST,
  port: PORT,
  daemonHostId: DAEMON_CONFIG.daemonHostId,
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  updatesDir: UPDATES_DIR,
  appUpdateVersionCode: APP_UPDATE_VERSION_CODE,
  appUpdateVersionName: APP_UPDATE_VERSION_NAME,
  appUpdateManifestUrl: APP_UPDATE_MANIFEST_URL,
  sessions,
  mirrors,
  clientRuntimeDebugStore,
  resolveDebugRouteLimit,
  broadcastRuntimeDebugControl,
  logTimePrefix,
});

const terminalMessageRuntime = createTerminalMessageRuntime({
  sessions,
  sendTransportMessage,
  sendMessage,
  normalizeBufferSyncRequestPayload,
  getSessionMirror: terminalRuntime.getSessionMirror,
  sendBufferHeadToSession: terminalRuntime.sendBufferHeadToSession,
  refreshMirrorHeadForSession: terminalRuntime.refreshMirrorHeadForSession,
  handleInput: terminalRuntime.handleInput,
  closeSession: terminalRuntime.closeSession,
  terminalFileTransferRuntime,
  handleClientDebugLog,
  controlRuntimeDeps: {
    sessions,
    mirrors,
    issueSessionTransportToken: terminalAttachTokenRuntime.issueSessionTransportToken,
    consumeSessionTransportToken: terminalAttachTokenRuntime.consumeSessionTransportToken,
    scheduleEngine,
    sendTransportMessage,
    sendMessage,
    sendScheduleStateToSession,
    listTmuxSessions,
    createDetachedTmuxSession,
    renameTmuxSession,
    runTmux,
    sanitizeSessionName,
    createTransportBoundSession: (connection) =>
      terminalRuntime.createTransportBoundSession(connection as DaemonTransportConnection),
    bindConnectionToSession: (connection, session) =>
      terminalRuntime.bindConnectionToSession(connection as DaemonTransportConnection, session),
    getMirrorKey,
    attachTmux: terminalRuntime.attachTmux,
    destroyMirror: terminalRuntime.destroyMirror,
  },
});

const server = createServer((request, response) => terminalHttpRuntime.handleHttpRequest(request, response));

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 256,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});

const terminalDaemonRuntime = createTerminalDaemonRuntime({
  host: HOST,
  port: PORT,
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  updatesDir: UPDATES_DIR,
  tmuxBinary: TMUX_BINARY,
  defaultSessionName: DEFAULT_SESSION_NAME,
  logDir: LOG_DIR,
  configDisplayPath: DAEMON_CONFIG.configFound ? WTERM_CONFIG_DISPLAY_PATH : `${WTERM_CONFIG_DISPLAY_PATH} (not found)`,
  authLabel: REQUIRED_AUTH_TOKEN ? `enabled (${DAEMON_CONFIG.authSource})` : 'disabled',
  relayLabel: DAEMON_CONFIG.relay ? `${DAEMON_CONFIG.relay.relayUrl} (host=${DAEMON_CONFIG.relay.hostId})` : 'disabled',
  terminalCacheLines: MAX_CAPTURED_SCROLLBACK_LINES,
  wsHeartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
  memoryGuardIntervalMs: MEMORY_GUARD_INTERVAL_MS,
  memoryGuardMaxRssBytes: MEMORY_GUARD_MAX_RSS_BYTES,
  memoryGuardMaxHeapUsedBytes: MEMORY_GUARD_MAX_HEAP_USED_BYTES,
  startupPortConflictExitCode: STARTUP_PORT_CONFLICT_EXIT_CODE,
  sessions,
  connections,
  mirrors,
  server,
  wss,
  logTimePrefix,
  shutdownTerminalSessions: (sessionsMap, reason) => {
    for (const session of sessionsMap.values()) {
      if (session.transport && session.closeTransport) {
        session.closeTransport(reason);
      }
    }
    sessionsMap.clear();
  },
  destroyMirror: terminalRuntime.destroyMirror,
  disposeScheduleRuntime: () => terminalScheduleRuntime.dispose(),
  startRelayHostClient: () => relayHostClient.start(),
  disposeRelayHostClient: () => relayHostClient.dispose(),
  disposeRtcBridgeServer: () => rtcBridgeServer.dispose(),
});
const {
  extractAuthToken,
  startHeartbeatLoop,
  startMemoryGuardLoop,
  shutdownDaemon,
  handleDaemonServerClosed,
  handleDaemonServerError,
  handleDaemonServerListening,
} = terminalDaemonRuntime;

const terminalBridgeRuntime = createTerminalBridgeRuntime({
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  sessions,
  connections,
  wss,
  logTimePrefix,
  extractAuthToken,
  resolveRequestOrigin: (request) => terminalHttpRuntime.resolveRequestOrigin(request),
  createWebSocketSessionTransport,
  createRtcSessionTransport,
  createTransportConnection,
  detachSessionTransportOnly: terminalRuntime.detachSessionTransportOnly,
  handleMessage: (connection, rawData, isBinary) =>
    terminalMessageRuntime.handleMessage(connection as DaemonTransportConnection, rawData, isBinary),
});
const {
  rtcBridgeServer,
  handleWebSocketConnection,
  handleServerUpgrade,
  handleRelaySignal,
  closeRelayPeer,
} = terminalBridgeRuntime;
const relayHostClient = createTraversalRelayHostClient({
  config: DAEMON_CONFIG.relay,
  handleRelaySignal,
  closeRelayPeer,
});
wss.on('connection', handleWebSocketConnection);
startHeartbeatLoop();
startMemoryGuardLoop();

wss.on('close', () => {
  handleDaemonServerClosed();
});

server.on('error', (error) => {
  handleDaemonServerError(error);
});

server.on('upgrade', handleServerUpgrade);

server.listen(PORT, HOST, () => {
  handleDaemonServerListening();
});

process.on('SIGINT', () => shutdownDaemon('SIGINT', 0));
process.on('SIGTERM', () => shutdownDaemon('SIGTERM', 0));
process.on('SIGHUP', () => shutdownDaemon('SIGHUP', 0));
