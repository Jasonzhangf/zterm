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
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import type {
  BridgeServerMessage as ServerMessage,
} from '@zterm/shared/protocol';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  WTERM_CONFIG_DISPLAY_PATH,
} from '@zterm/shared/mobile-config';
import { getWtermHomeDir, getWtermUpdatesDir, resolveDaemonRuntimeConfig } from './daemon-config';
import {
  buildDaemonConnectionEndpointCandidates,
  resolveDaemonTailscaleUpdateManifestUrl,
} from './daemon-connection-endpoint-runtime';
import { createTraversalRelayHostClient } from './relay-client';
import { findChangedIndexedRanges } from './canonical-buffer';
import { buildBufferHeadPayload, buildChangedRangesBufferSyncPayload } from './buffer-sync-contract';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachGeometry } from './mirror-geometry';
import { createTerminalMirrorCaptureRuntime } from './terminal-mirror-capture';
import { dispatchScheduledJob } from './schedule-dispatch';
import { createRuntimeDebugStore, resolveDebugRouteLimit } from './runtime-debug-store';
import { DebugPermissionService } from '@zterm/shared/terminal/debug-contract';
import { loadScheduleStore, saveScheduleStore } from './schedule-store';
import {
  createTerminalRuntime,
  type TerminalTransportSubscriber,
  type SessionMirror,
} from './terminal-runtime';
import { createTerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import { createTerminalFileTransferMessageRuntime } from './terminal-file-transfer-message-runtime';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import { createTerminalAttachmentMessageRuntime } from './terminal-attachment-message-runtime';
import { createTerminalChannelMuxRuntime } from './terminal-channel-mux-runtime';
import { createDaemonInputQueueRuntime } from './daemon-input-queue-runtime';
import { createTerminalHttpRuntime } from './terminal-http-runtime';
import { createAttachmentDeliveryRuntime } from './attachment-delivery-runtime';
import {
  createTerminalScheduleRuntime,
  type TerminalScheduleRuntime,
} from './terminal-schedule-runtime';
import {
  createTerminalControlRuntime,
  type TerminalControlRuntime,
} from './terminal-control-runtime';
import {
  createWezTermBackendRuntime,
  createWezTermCommandRunner,
} from './wezterm-backend';
import { createHerdrBackendRuntime } from './herdr-backend-runtime';
import {
  isHerdrExecutableAvailable,
  resolveTerminalBackendKind,
  resolveHerdrExecutable,
  resolveWezTermExecutable,
} from './terminal-backend-selection';
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
import { captureRemoteScreenshotWithDaemon } from './remote-screenshot-daemon';
import {
  buildRemoteWindowImagePasteInputPayloads,
  createRemoteWindowStreamDaemonRuntime,
} from './remote-window-stream-daemon';
import { createTerminalPerformanceTraceStore } from '@zterm/shared/terminal/performance-trace';

const DAEMON_CONFIG = resolveDaemonRuntimeConfig();
const PORT = DAEMON_CONFIG.port || DEFAULT_BRIDGE_PORT;
const HOST = DAEMON_CONFIG.host || DEFAULT_DAEMON_HOST;

const TERMINAL_BACKEND_KIND = resolveTerminalBackendKind();
const TMUX_BINARY = resolveTmuxBinary();
let wakeHerdrMirror: (sessionName: string) => void = () => undefined;
const createConfiguredHerdrBackendRuntime = () => createHerdrBackendRuntime({
  executable: resolveHerdrExecutable(),
  maxMirrorLines: DAEMON_CONFIG.terminalCacheLines,
  onLiveActivity: (sessionName) => wakeHerdrMirror(sessionName),
});
const TERMINAL_BACKEND_RUNTIME = TERMINAL_BACKEND_KIND === 'wezterm'
  ? createWezTermBackendRuntime({
      runner: createWezTermCommandRunner(resolveWezTermExecutable()),
    maxMirrorLines: DAEMON_CONFIG.terminalCacheLines,
  })
  : TERMINAL_BACKEND_KIND === 'herdr'
    ? createConfiguredHerdrBackendRuntime()
    : null;
const HERDR_BACKEND_RUNTIME = TERMINAL_BACKEND_RUNTIME && TERMINAL_BACKEND_KIND === 'herdr'
  ? TERMINAL_BACKEND_RUNTIME
  : isHerdrExecutableAvailable()
    ? createConfiguredHerdrBackendRuntime()
    : null;
const TERMINAL_BACKEND_RUNTIMES = {
  ...(HERDR_BACKEND_RUNTIME ? { herdr: HERDR_BACKEND_RUNTIME } : {}),
  ...(TERMINAL_BACKEND_KIND === 'wezterm' && TERMINAL_BACKEND_RUNTIME ? { wezterm: TERMINAL_BACKEND_RUNTIME } : {}),
};
const DEFAULT_SESSION_NAME = process.env.ZTERM_DEFAULT_SESSION || 'zterm';
const DAEMON_SESSION_NAME = DAEMON_CONFIG.sessionName || buildDaemonSessionName(PORT);
const HIDDEN_TMUX_SESSIONS = new Set([DAEMON_SESSION_NAME, DEFAULT_DAEMON_SESSION_NAME, 'zterm-daemon-keepalive']);
const AUTO_COMMAND_DELAY_MS = 180;
const REQUIRED_AUTH_TOKEN = DAEMON_CONFIG.authToken;
const MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
const WTERM_HOME_DIR = getWtermHomeDir(homedir());
const UPDATES_DIR = getWtermUpdatesDir(homedir());
const UPLOAD_DIR = join(WTERM_HOME_DIR, 'uploads');
const DOWNLOADS_DIR = join(homedir(), 'Downloads', 'zterm');
const LOG_DIR = join(WTERM_HOME_DIR, 'logs');
const ATTACHMENTS_DIR = join(WTERM_HOME_DIR, 'attachments');
const APP_UPDATE_VERSION_CODE = Number.parseInt(process.env.ZTERM_APP_UPDATE_VERSION_CODE || '', 10);
const APP_UPDATE_VERSION_NAME = (process.env.ZTERM_APP_UPDATE_VERSION_NAME || '').trim();
const APP_UPDATE_MANIFEST_URL = (process.env.ZTERM_APP_UPDATE_MANIFEST_URL || '').trim();
const DAEMON_TAILSCALE_UPDATE_MANIFEST_URL = resolveDaemonTailscaleUpdateManifestUrl({ bridgePort: PORT });
const WS_HEARTBEAT_INTERVAL_MS = 2000;
const STARTUP_PORT_CONFLICT_EXIT_CODE = 78;
const DAEMON_RUNTIME_DEBUG = process.env.ZTERM_DAEMON_DEBUG_LOG === '1';
const MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES = 8;
const MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS = 900;
const daemonDebugPermissionService = new DebugPermissionService();
const MEMORY_GUARD_INTERVAL_MS = 30_000;
const daemonSessionObservationHistory = new Map<string, {
  processName?: string;
  processId?: string;
  processGroupId: string;
  firstSeenAt: number;
  lastFingerprint: string;
  candidateStatus: import('@zterm/shared/protocol').TerminalSessionAgentStatus;
  candidateSince: number;
  idleConfirmations: number;
  lastPublishedAt?: number;
}>();
const readDaemonProcessGroup = (pid: string) => {
  const result = spawnSync('ps', ['-o', 'pgid=,stat=', '-p', pid], { encoding: 'utf8' });
  const [groupId, state] = result.stdout.trim().split(/\s+/u);
  return groupId && state ? { groupId, alive: !state.includes('Z') } : undefined;
};
const MEMORY_GUARD_MAX_RSS_BYTES = 2.5 * 1024 * 1024 * 1024;
const MEMORY_GUARD_MAX_HEAP_USED_BYTES = 1.5 * 1024 * 1024 * 1024;

const sessions = new Map<string, TerminalTransportSubscriber>();
const connections = new Map<string, DaemonTransportConnection>();
const mirrors = new Map<string, SessionMirror>();
const scheduleStore = loadScheduleStore();
const clientRuntimeDebugStore = createRuntimeDebugStore();
const daemonRuntimeDebugStore = createRuntimeDebugStore();
const performanceTraceStore = createTerminalPerformanceTraceStore({ limit: 5000 });
const attachmentDeliveryRuntime = createAttachmentDeliveryRuntime({ rootDir: ATTACHMENTS_DIR });
const terminalAttachTokenRuntime = createTerminalAttachTokenRuntime();
let terminalScheduleRuntime: TerminalScheduleRuntime;
let terminalControlRuntime: TerminalControlRuntime;
let daemonInputQueueRuntime!: ReturnType<typeof createDaemonInputQueueRuntime>;
const daemonInputQueueRuntimeProxy: ReturnType<typeof createDaemonInputQueueRuntime> = {
  handleInputMessage: (connection, payload) =>
    daemonInputQueueRuntime.handleInputMessage(connection, payload),
  enqueueBackendInput: (sessionName, payload, appendEnter, backendKind) =>
    daemonInputQueueRuntime.enqueueBackendInput(sessionName, payload, appendEnter, backendKind),
  enqueueLiveMirrorInput: (sessionName, payload, appendEnter, shouldWrite, backendKind) =>
    daemonInputQueueRuntime.enqueueLiveMirrorInput(
      sessionName,
      payload,
      appendEnter,
      shouldWrite,
      backendKind,
    ),
  disposeLiveMirrorInputBatch: (sessionName, reason, backendKind) =>
    daemonInputQueueRuntime.disposeLiveMirrorInputBatch(sessionName, reason, backendKind),
};
let terminalTransportRuntimeSendMessage: (session: TerminalTransportSubscriber, message: ServerMessage) => void;
let remoteWindowStreamRuntime: ReturnType<typeof createRemoteWindowStreamDaemonRuntime>;
let remoteWindowPasteRequestSeq = 0;
const terminalDebugRuntime = createTerminalDebugRuntime({
  daemonRuntimeDebugEnabled: DAEMON_RUNTIME_DEBUG,
  maxClientDebugBatchLogEntries: MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES,
  maxClientDebugLogPayloadChars: MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS,
  clientRuntimeDebugStore,
  daemonRuntimeDebugStore,
  debugPermissionService: daemonDebugPermissionService,
});
const terminalCoreSupport = createTerminalCoreSupport({
  defaultSessionName: DEFAULT_SESSION_NAME,
  maxCapturedScrollbackLines: MAX_CAPTURED_SCROLLBACK_LINES,
});
const {
  logTimePrefix,
  daemonRuntimeDebug,
  setDaemonRuntimeDebugEnabled,
  setDaemonRuntimeDebugLease,
  summarizePayload,
  handleClientDebugLog,
  handleClientDebugSnapshot,
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
  runTmuxAsync: (args) => terminalControlRuntime.runTmuxAsync(args),
  buildExactTmuxPaneTarget: (sessionName) => terminalControlRuntime.buildExactTmuxPaneTarget(sessionName),
  logTimePrefix,
  wezTermBackend: TERMINAL_BACKEND_RUNTIME,
  terminalBackendKind: TERMINAL_BACKEND_KIND,
  backendRuntimes: TERMINAL_BACKEND_RUNTIMES,
});
const terminalRuntime = createTerminalRuntime({
  defaultSessionName: DEFAULT_SESSION_NAME,
  defaultViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
  sessions,
  mirrors,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  sendText: (transport, text) => terminalTransportRuntime.sendText(transport, text),
  recordPerformanceTrace: (record) => performanceTraceStore.record(record),
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
  readTmuxPaneMetrics: (sessionName, backend) => terminalMirrorCapture.readTmuxPaneMetrics(sessionName, backend),
  resizeBackendSession: (sessionName, geometry, backend) => {
    if ((backend || 'tmux') === 'tmux' && TERMINAL_BACKEND_KIND !== 'wezterm') {
      terminalControlRuntime.runTmux([
        'resize-window', '-t', terminalControlRuntime.buildExactTmuxSessionTarget(sessionName), '-x', String(geometry.cols),
      ]);
      return;
    }
    const externalBackend = backend === 'herdr' ? HERDR_BACKEND_RUNTIME : TERMINAL_BACKEND_RUNTIMES.wezterm;
    if (!externalBackend?.resizeSession) {
      throw new Error(`${backend || 'unknown'} backend does not support resize`);
    }
    externalBackend.resizeSession(sessionName, geometry);
  },
  assertTmuxSessionExists: (sessionName, backend) => {
    if (backend === 'herdr') {
      if (!HERDR_BACKEND_RUNTIME) {
        throw new Error('herdr backend is not available on this daemon');
      }
      if (!HERDR_BACKEND_RUNTIME.listSessions().some((session) => session.sessionName === sessionName)) {
        throw new Error(`herdr session not found: ${sessionName}`);
      }
      return;
    }
    if (TERMINAL_BACKEND_KIND === 'wezterm') {
      if (!TERMINAL_BACKEND_RUNTIMES.wezterm?.listSessions().some((session) => session.sessionName === sessionName)) {
        throw new Error(`wezterm session not found: ${sessionName}`);
      }
      return;
    }
    terminalControlRuntime.runTmux([
      'has-session', '-t', terminalControlRuntime.buildExactTmuxSessionTarget(sessionName),
    ]);
  },
  resolveTerminalSessionBackend: (sessionName) => terminalControlRuntime.resolveTerminalSessionBackend(sessionName),
  captureMirrorAuthoritativeBufferFromTmux: terminalMirrorCapture.captureMirrorAuthoritativeBufferFromTmux,
  mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
    previousStartIndex,
    previousLines,
    nextStartIndex: mirror.bufferStartIndex,
    nextLines: mirror.bufferLines,
  }),
  mirrorCursorEqual,
  daemonInputQueue: daemonInputQueueRuntimeProxy,
  autoCommandDelayMs: AUTO_COMMAND_DELAY_MS,
  waitMs: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  runTmux: (args) => terminalControlRuntime.runTmux(args),
  buildExactTmuxSessionTarget: (sessionName) => terminalControlRuntime.buildExactTmuxSessionTarget(sessionName),
  daemonRuntimeDebug,
  logTimePrefix,
});
wakeHerdrMirror = (sessionName) => {
  const mirror = mirrors.get(getMirrorKey(sessionName, 'herdr'));
  if (mirror) {
    terminalRuntime.scheduleMirrorLiveSync(mirror, 0);
  }
};
const terminalFileTransferRuntime = createTerminalFileTransferRuntime({
  uploadDir: UPLOAD_DIR,
  downloadsDir: DOWNLOADS_DIR,
  wtermHomeDir: WTERM_HOME_DIR,
  platform: process.platform,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  getSessionMirror: terminalRuntime.getSubscriberMirror,
  scheduleMirrorLiveSync: terminalRuntime.scheduleMirrorLiveSync,
  enqueueBackendInput: (sessionName, payload, appendEnter, backend) =>
    daemonInputQueueRuntimeProxy.enqueueBackendInput(sessionName, payload, appendEnter, backend),
  readTmuxPaneCurrentPath: (sessionName, backend) => terminalMirrorCapture.readTmuxPaneCurrentPath(sessionName, backend),
  runCommand: (command, args) => {
    terminalControlRuntime.runCommand(command, args);
  },
  pasteImageToRemoteWindow: async (_session, target) => {
    const requestPrefix = `paste-image-${Date.now()}-${remoteWindowPasteRequestSeq += 1}`;
    const payloads = buildRemoteWindowImagePasteInputPayloads({
      requestPrefix,
      streamId: target.streamId,
      targetId: target.targetId,
    });
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index]!;
      const result = await remoteWindowStreamRuntime.injectInput(payload, {
        version: 1,
        sequence: `${requestPrefix}-${index}`,
        lane: 'reliable',
        attempt: 1,
        sentAtMs: Date.now(),
      });
      if (!result?.control.accepted) {
        throw new Error(result?.control.error?.message || 'remote window image paste rejected');
      }
    }
  },
  captureRemoteScreenshot: captureRemoteScreenshotWithDaemon,
  logTimePrefix,
});

terminalControlRuntime = createTerminalControlRuntime({
  tmuxBinary: TMUX_BINARY,
  defaultSessionName: DEFAULT_SESSION_NAME,
  hiddenTmuxSessions: HIDDEN_TMUX_SESSIONS,
  tmuxSocketDir: join(WTERM_HOME_DIR, 'tmux'),
  sanitizeSessionName,
  daemonRuntimeDebug,
  wezTermBackend: TERMINAL_BACKEND_RUNTIME,
  backendRuntimes: TERMINAL_BACKEND_RUNTIMES,
  defaultBackend: TERMINAL_BACKEND_KIND,
});
const {
  runTmux,
  listTmuxSessions,
  listTerminalSessions,
  listTerminalSessionCatalog,
  resolveTerminalSessionBackend,
  createDetachedTmuxSession,
  closeDetachedTerminalSession,
  renameTmuxSession,
} = terminalControlRuntime;
remoteWindowStreamRuntime = createRemoteWindowStreamDaemonRuntime({
  platform: process.platform,
  warmTargetCatalogOnStart: true,
  runTmux,
});

// Tmux is an optional external backend. Do not initialize or query it when
// the daemon is explicitly serving Herdr/WezTerm only.
if (TERMINAL_BACKEND_KIND === 'tmux') {
  terminalControlRuntime.ensureTmuxServerRunning();
  terminalRuntime.restorePersistedAdaptiveWidthBaselines(listTmuxSessions());
}
const terminalTransportRuntime = createTerminalTransportRuntime({
  sessions,
  connections,
  daemonRuntimeDebug,
  summarizePayload,
  recordPerformanceTrace: (record) => performanceTraceStore.record(record),
});
const {
  createWebSocketSessionTransport,
  createRtcSessionTransport,
  sendText,
  sendTransportMessage,
  sendMessage,
  broadcastRuntimeDebugControl,
  createTransportConnection,
} = terminalTransportRuntime;
terminalTransportRuntimeSendMessage = sendMessage;
const attachmentMessageRuntime = createTerminalAttachmentMessageRuntime({
  attachmentDeliveryRuntime,
  sendTransportMessage,
});
const fileTransferMessageRuntime = createTerminalFileTransferMessageRuntime({
  fileTransferRuntime: terminalFileTransferRuntime,
  sendTransportMessage,
});
const terminalChannelMuxRuntime = createTerminalChannelMuxRuntime({
  sessions,
  sendText,
  defaultSessionName: DEFAULT_SESSION_NAME,
});

daemonInputQueueRuntime = createDaemonInputQueueRuntime({
  sessions,
  mirrors,
  getMirrorKey,
  sendTransportMessage,
  sendMessage,
  handleInput: (session, data, shouldWrite) => terminalRuntime.handleInput(session, data, shouldWrite),
  writeBackendInputGroup: (sessionName, payload, appendEnter, backendKind) =>
    terminalControlRuntime.writeBackendInputGroup(sessionName, payload, appendEnter, backendKind),
  resolveBackendInputMaxChunkBytes: () => terminalControlRuntime.resolveBackendInputMaxChunkBytes(),
  daemonRuntimeDebug,
});

terminalScheduleRuntime = createTerminalScheduleRuntime({
  initialJobs: scheduleStore.jobs,
  saveJobs: (jobs) => {
    saveScheduleStore(jobs);
  },
  executeJob: async (job) =>
    dispatchScheduledJob(
      {
        enqueueBackendInput: (sessionName, payload, appendEnter, backend) =>
          daemonInputQueueRuntimeProxy.enqueueBackendInput(sessionName, payload, appendEnter, backend),
        isHerdrSession: (sessionName, backend = 'tmux') => {
          if (backend !== 'herdr') {
            return false;
          }
          const registered = Array.from(sessions.values()).some((session) =>
            session.sessionName === sessionName && session.backend === 'herdr')
            || Array.from(mirrors.values()).some((mirror) =>
              mirror.sessionName === sessionName && mirror.backend === 'herdr');
          if (registered) return true;
          if (TERMINAL_BACKEND_KIND !== 'herdr') return false;
          if (!HERDR_BACKEND_RUNTIME) return false;
          return HERDR_BACKEND_RUNTIME.listSessions().some((session) => session.sessionName === sessionName);
        },
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
  appUpdateManifestUrl: APP_UPDATE_MANIFEST_URL || DAEMON_TAILSCALE_UPDATE_MANIFEST_URL,
  sessions,
  mirrors,
  clientRuntimeDebugStore,
  daemonRuntimeDebugStore,
  performanceTraceStore,
  resolveDebugRouteLimit,
  broadcastRuntimeDebugControl,
  setDaemonRuntimeDebugEnabled,
  setDaemonRuntimeDebugLease,
  debugPermissionService: daemonDebugPermissionService,
  handleClientDebugLog,
  handleClientDebugSnapshot,
  logTimePrefix,
  attachmentDeliveryRuntime,
  connections,
  sendTransportMessage,
});

const terminalMessageRuntime = createTerminalMessageRuntime({
  sessions,
  sendTransportMessage,
  sendMessage,
  normalizeBufferSyncRequestPayload,
  getSessionMirror: terminalRuntime.getSubscriberMirror,
  sendBufferHeadToSession: terminalRuntime.sendBufferHeadToSession,
  enqueueRangeBufferSyncResponse: terminalRuntime.enqueueRangeBufferSyncResponse,
  scheduleMirrorLiveSync: terminalRuntime.scheduleMirrorLiveSync,
  refreshMirrorHeadForSession: terminalRuntime.refreshMirrorHeadForSession,
  daemonInputQueue: daemonInputQueueRuntime,
  closeSession: terminalRuntime.closeTransportSubscriber,
  fileTransferMessageRuntime,
  attachmentMessageRuntime,
  remoteWindowStreamRuntime,
  channelMuxRuntime: terminalChannelMuxRuntime,
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
    listTerminalSessions,
    listTerminalSessionCatalog,
    runTmux,
    observationHistory: daemonSessionObservationHistory,
    readProcessGroup: readDaemonProcessGroup,
    resolveTerminalSessionBackend,
    createDetachedTmuxSession,
    closeDetachedTerminalSession,
    renameTmuxSession,
    sanitizeSessionName,
    createTransportSubscriber: (connection) =>
      terminalRuntime.createTransportSubscriber(connection as DaemonTransportConnection),
    bindConnectionToSubscriber: (connection, subscriber) =>
      terminalRuntime.bindConnectionToSubscriber(connection as DaemonTransportConnection, subscriber),
    getMirrorKey,
    attachTmux: terminalRuntime.attachTmux,
    handleAdaptiveResize: terminalRuntime.handleAdaptiveResize,
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
  detachSubscriberTransportOnly: terminalRuntime.detachSubscriberTransportOnly,
  listMuxChannelSubscriberIds: terminalChannelMuxRuntime.listMuxChannelSubscriberIds,
  releaseAllMuxChannelSubscribers: terminalChannelMuxRuntime.releaseAllMuxChannelSubscribers,
  destroyMirror: terminalRuntime.destroyMirror,
  disposeScheduleRuntime: () => terminalScheduleRuntime.dispose(),
  startRelayHostClient: () => relayHostClient.start(),
  disposeRelayHostClient: () => relayHostClient.dispose(),
  disposeRtcBridgeServer: () => rtcBridgeServer.dispose(),
  sendTransportMessage,
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
  detachSubscriberTransportOnly: terminalRuntime.detachSubscriberTransportOnly,
  listMuxChannelSubscriberIds: terminalChannelMuxRuntime.listMuxChannelSubscriberIds,
  releaseAllMuxChannelSubscribers: terminalChannelMuxRuntime.releaseAllMuxChannelSubscribers,
  refreshAdaptiveWidthLeaseHeartbeat: terminalRuntime.refreshAdaptiveWidthLeaseHeartbeat,
  handleMessage: (connection, rawData, isBinary) =>
    terminalMessageRuntime.handleMessage(connection as DaemonTransportConnection, rawData, isBinary),
  handleTransportClosed: (connection) =>
    terminalMessageRuntime.closeConnection(connection as DaemonTransportConnection),
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
  listEndpointCandidates: (now) => buildDaemonConnectionEndpointCandidates({
    hostId: DAEMON_CONFIG.daemonHostId,
    bridgePort: PORT,
    authToken: REQUIRED_AUTH_TOKEN,
    now,
  }),
  listTerminalSessionCatalog,
});
wss.on('connection', handleWebSocketConnection);
startHeartbeatLoop();
startMemoryGuardLoop();
void attachmentDeliveryRuntime.cleanup().catch((error) => {
  console.error(`[${logTimePrefix()}] attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
});
const attachmentCleanupTimer = setInterval(() => {
  void attachmentDeliveryRuntime.cleanup().catch((error) => {
    console.error(`[${logTimePrefix()}] attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, 60 * 60 * 1000);
attachmentCleanupTimer.unref?.();

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
