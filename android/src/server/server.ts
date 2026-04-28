/**
 * zterm Android WebSocket 服务端
 *
 * 目标：tmux/daemon 作为 authoritative terminal truth，移动端只接收 mirror。
 * daemon 只维护每个 tmux session 的 canonical buffer，并向客户端发送最新连续 buffer-sync。
 *
 * 修正：buffer 真源按 tmux session mirror 维护，而不是按 websocket/tab 各自维护。
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { WasmBridge } from '@jsonstudio/wtermmod-core';
import { spawnSync } from 'child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { basename, extname, join, resolve } from 'path';
import { homedir } from 'os';
import { createRtcBridgeServer, type RtcServerTransport, type SignalMessage } from './rtc-bridge';
import type {
  AttachFileStartPayload,
  BufferHeadPayload,
  BufferSyncRequestPayload,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  FileDownloadRequestPayload,
  FileListErrorPayload,
  FileListRequestPayload,
  FileListResponsePayload,
  FileUploadChunkPayload,
  FileUploadCompletePayload,
  FileUploadEndPayload,
  FileUploadErrorPayload,
  FileUploadProgressPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  PasteImageStartPayload,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  RuntimeDebugLogEntry,
  ScheduleEventPayload,
  ScheduleJobDraft,
  ScheduleStatePayload,
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';
import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  WTERM_CONFIG_DISPLAY_PATH,
} from '../lib/mobile-config';
import { getWtermHomeDir, getWtermUpdatesDir, resolveDaemonRuntimeConfig } from './daemon-config';
import { createTraversalRelayHostClient } from './relay-client';
import {
  findChangedIndexedRanges,
  normalizeMirrorCaptureLines,
  resolveCanonicalAvailableLineCount,
  trimTrailingDefaultCells,
  trimCanonicalBufferWindow,
} from './canonical-buffer';
import { buildBufferHeadPayload, buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import {
  attachClientSessionTransport,
  closeClientSession as removeLogicalClientSession,
  detachClientSessionTransport as markLogicalClientSessionTransportDetached,
  shutdownClientSessions,
} from './client-session-lifecycle';
import { closeMirrorSubscribers, detachMirrorSubscriber } from './mirror-lifecycle';
import { DEFAULT_TERMINAL_SESSION_VIEWPORT, resolveAttachGeometry, resolveMirrorSubscriberGeometry } from './mirror-geometry';
import { resolveFileTransferListPath } from './file-transfer-path';
import { dispatchScheduledJob } from './schedule-dispatch';
import { requestRemoteScreenshotViaHelper } from './remote-screenshot-helper-client';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';
import { createRuntimeDebugStore, resolveDebugRouteLimit } from './runtime-debug-store';
import { ScheduleEngine } from './schedule-engine';
import { loadScheduleStore, saveScheduleStore } from './schedule-store';
import {
  createSessionTransportTicketStore,
  issueSessionTransportTicket,
  revokeSessionTransportTicket,
  takeSessionTransportTicket,
} from './session-transport-ticket';

// 保留正在推进中的文件传输/目录能力真相；当前 server 主链尚未接线完成，
// 这里只做显式占位，避免把“未接线的新功能定义”误删成不存在。
void readdirSync;
void statSync;
void (0 as unknown as
  | FileDownloadRequestPayload
  | FileListRequestPayload
  | FileUploadChunkPayload
  | FileUploadEndPayload
  | FileUploadStartPayload);

interface TmuxConnectPayload {
  clientSessionId: string;
  sessionTransportToken?: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  cols?: number;
  rows?: number;
  terminalWidthMode?: 'adaptive-phone' | 'mirror-fixed';
  autoCommand?: string;
}

interface ClientSessionTransport {
  kind: 'ws' | 'rtc';
  readyState: number;
  sendText: (text: string) => void;
  close: (reason?: string) => void;
  ping?: () => void;
}

interface TransportConnection {
  id: string;
  transportId: string;
  transport: ClientSessionTransport;
  closeTransport: (reason: string) => void;
  requestOrigin: string;
  wsAlive: boolean;
  role: 'pending' | 'control' | 'session';
  boundSessionId: string | null;
}

interface ClientSession {
  id: string;
  clientSessionId: string;
  transportId: string | null;
  transport: ClientSessionTransport | null;
  closeTransport?: (reason: string) => void;
  requestOrigin: string;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
  title: string;
  sessionName: string;
  mirrorKey: string | null;
  cols: number;
  rows: number;
  terminalWidthMode: 'adaptive-phone' | 'mirror-fixed';
  requestedAdaptiveCols: number | null;
  wsAlive: boolean;
  pendingPasteImage: PasteImageStartPayload | null;
  pendingAttachFile: AttachFileStartPayload | null;
  logicalSessionBound: boolean;
}

interface SessionMirror {
  key: string;
  sessionName: string;
  ptyProcess: pty.IPty | null;
  scratchBridge: WasmBridge | null;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
  title: string;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
  lastScrollbackCount: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cursor: TerminalCursorState | null;
  lastFlushStartedAt: number;
  lastFlushCompletedAt: number;
  flushInFlight: boolean;
  flushPromise: Promise<boolean> | null;
  liveSyncTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<string>;
}

interface TmuxPaneMetrics {
  paneId: string;
  tmuxAvailableLineCountHint: number;
  paneRows: number;
  paneCols: number;
  alternateOn: boolean;
}

interface TmuxCursorState {
  col: number;
  row: number;
  visible: boolean;
  cursorKeysApp: boolean;
}

function normalizeMirrorCursor(options: {
  bufferStartIndex: number;
  availableEndIndex: number;
  paneRows: number;
  cursor: TmuxCursorState;
}): TerminalCursorState | null {
  const safePaneRows = Math.max(1, Math.floor(options.paneRows || 1));
  const safeBufferStartIndex = Math.max(0, Math.floor(options.bufferStartIndex || 0));
  const safeAvailableEndIndex = Math.max(safeBufferStartIndex, Math.floor(options.availableEndIndex || 0));
  if (safeAvailableEndIndex <= safeBufferStartIndex) {
    return null;
  }
  const visibleTopIndex = Math.max(safeBufferStartIndex, safeAvailableEndIndex - safePaneRows);
  const rowIndex = Math.max(
    visibleTopIndex,
    Math.min(safeAvailableEndIndex - 1, visibleTopIndex + Math.max(0, Math.floor(options.cursor.row || 0))),
  );
  return {
    rowIndex,
    col: Math.max(0, Math.floor(options.cursor.col || 0)),
    visible: Boolean(options.cursor.visible),
  };
}

function mirrorCursorEqual(left: TerminalCursorState | null | undefined, right: TerminalCursorState | null | undefined) {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.rowIndex === right.rowIndex && left.col === right.col && left.visible === right.visible;
}

type ClientMessage =
  | { type: 'session-open'; payload: TmuxConnectPayload }
  | { type: 'connect'; payload: TmuxConnectPayload }
  | { type: 'buffer-head-request' }
  | { type: 'buffer-sync-request'; payload: BufferSyncRequestPayload }
  | { type: 'debug-log'; payload: { entries: RuntimeDebugLogEntry[] } }
  | { type: 'list-sessions' }
  | { type: 'schedule-list'; payload: { sessionName: string } }
  | { type: 'schedule-upsert'; payload: { job: ScheduleJobDraft } }
  | { type: 'schedule-delete'; payload: { jobId: string } }
  | { type: 'schedule-toggle'; payload: { jobId: string; enabled: boolean } }
  | { type: 'schedule-run-now'; payload: { jobId: string } }
  | { type: 'tmux-create-session'; payload: { sessionName: string } }
  | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string } }
  | { type: 'tmux-kill-session'; payload: { sessionName: string } }
  | { type: 'input'; payload: string }
  | { type: 'paste-image-start'; payload: PasteImageStartPayload }
  | { type: 'paste-image'; payload: PasteImagePayload }
  | { type: 'attach-file-start'; payload: AttachFileStartPayload }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'terminal-width-mode'; payload: { mode: 'adaptive-phone' | 'mirror-fixed'; cols?: number } }
  | { type: 'file-list-request'; payload: FileListRequestPayload }
  | { type: 'file-download-request'; payload: FileDownloadRequestPayload }
  | { type: 'remote-screenshot-request'; payload: RemoteScreenshotRequestPayload }
  | { type: 'file-upload-start'; payload: FileUploadStartPayload }
  | { type: 'file-upload-chunk'; payload: FileUploadChunkPayload }
  | { type: 'file-upload-end'; payload: FileUploadEndPayload }
  | { type: 'ping' }
  | { type: 'close' };

type ServerMessage =
  | {
      type: 'session-ticket';
      payload: {
        clientSessionId: string;
        sessionTransportToken: string;
        sessionName: string;
      };
    }
  | {
      type: 'session-open-failed';
      payload: {
        clientSessionId: string;
        message: string;
        code?: string;
      };
    }
  | {
      type: 'connected';
      payload: {
        sessionId: string;
        appUpdate?: {
          versionCode: number;
          versionName: string;
          manifestUrl?: string;
        };
      };
    }
  | { type: 'buffer-head'; payload: BufferHeadPayload }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'buffer-sync'; payload: TerminalBufferPayload }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'debug-control'; payload: { enabled: boolean; reason?: string } }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'file-attached'; payload: { name: string; path: string; bytes: number } }
  | { type: 'file-list-response'; payload: FileListResponsePayload }
  | { type: 'file-list-error'; payload: FileListErrorPayload }
  | { type: 'remote-screenshot-status'; payload: RemoteScreenshotStatusPayload }
  | { type: 'file-download-chunk'; payload: FileDownloadChunkPayload }
  | { type: 'file-download-complete'; payload: FileDownloadCompletePayload }
  | { type: 'file-download-error'; payload: FileDownloadErrorPayload }
  | { type: 'file-upload-progress'; payload: FileUploadProgressPayload }
  | { type: 'file-upload-complete'; payload: FileUploadCompletePayload }
  | { type: 'file-upload-error'; payload: FileUploadErrorPayload }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

const DAEMON_CONFIG = resolveDaemonRuntimeConfig();
const PORT = DAEMON_CONFIG.port || DEFAULT_BRIDGE_PORT;
const HOST = DAEMON_CONFIG.host || DEFAULT_DAEMON_HOST;

function resolveTmuxBinary() {
  const override = process.env.ZTERM_TMUX_BINARY?.trim();
  if (override) {
    return override;
  }

  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    'tmux',
  ];

  const existingCandidate = candidates.find((candidate) => candidate === 'tmux' || existsSync(candidate));
  return existingCandidate || 'tmux';
}

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

const sessions = new Map<string, ClientSession>();
const connections = new Map<string, TransportConnection>();
const mirrors = new Map<string, SessionMirror>();
const sessionTransportTicketStore = createSessionTransportTicketStore();
const scheduleStore = loadScheduleStore();
const clientRuntimeDebugStore = createRuntimeDebugStore();

function resolveMirrorCacheLines(rows: number) {
  const paneRows = Math.max(1, Math.floor(rows || 1));
  if (!Number.isFinite(MAX_CAPTURED_SCROLLBACK_LINES) || MAX_CAPTURED_SCROLLBACK_LINES <= 0) {
    return paneRows;
  }
  return Math.max(paneRows, Math.floor(MAX_CAPTURED_SCROLLBACK_LINES));
}

function daemonRuntimeDebug(scope: string, payload?: unknown) {
  if (!DAEMON_RUNTIME_DEBUG) {
    return;
  }

  const timestamp = new Date().toISOString();
  if (payload === undefined) {
    console.debug(`[daemon-runtime:${scope}] ${timestamp}`);
    return;
  }

  console.debug(`[daemon-runtime:${scope}] ${timestamp}`, payload);
}

function truncateDaemonLogPayload(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 12))}…[truncated]`;
}

function normalizeClientDebugEntries(entries: RuntimeDebugLogEntry[]) {
  return entries
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.scope === 'string')
    .slice(0, MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES)
    .map((entry) => ({
      seq: typeof entry.seq === 'number' && Number.isFinite(entry.seq) ? entry.seq : 0,
      ts: typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
      scope: truncateDaemonLogPayload(entry.scope, 120),
      payload:
        typeof entry.payload === 'string' && entry.payload.length > 0
          ? truncateDaemonLogPayload(entry.payload, MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS)
          : '',
    }));
}

function handleClientDebugLog(session: ClientSession, payload: { entries: RuntimeDebugLogEntry[] }) {
  const entries = normalizeClientDebugEntries(Array.isArray(payload.entries) ? payload.entries : []);
  if (entries.length === 0) {
    return;
  }

  clientRuntimeDebugStore.appendBatch(
    {
      sessionId: session.id,
      tmuxSessionName: session.sessionName || 'unknown',
      requestOrigin: session.requestOrigin,
    },
    entries,
  );

  console.log(
    `[${new Date().toISOString()}] [client-debug] session=${session.id} tmux=${session.sessionName || 'unknown'} entries=${entries.length}`,
  );
  for (const entry of entries) {
    console.log(
      `[${new Date().toISOString()}] [client-debug:${entry.scope}] seq=${entry.seq} ts=${entry.ts} session=${session.id} ${entry.payload}`,
    );
  }
}

function summarizePayload(message: ServerMessage) {
  if (message.type !== 'buffer-sync') {
    return null;
  }

  const payload = message.payload;
  const firstLine = payload.lines[0];
  const lastLine = payload.lines[payload.lines.length - 1];
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    rows: payload.rows,
    cols: payload.cols,
    lineCount: payload.lines.length,
    firstLineIndex: firstLine ? ('i' in firstLine ? firstLine.i : firstLine.index) : null,
    lastLineIndex: lastLine ? ('i' in lastLine ? lastLine.i : lastLine.index) : null,
  };
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.TMUX;
  delete env.TMUX_PANE;
  env.TERM = 'xterm-256color';
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_CTYPE = env.LC_CTYPE || env.LANG;
  const currentPath = env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  env.PATH = Array.from(new Set([
    '/opt/homebrew/bin',
    '/usr/local/bin',
    currentPath,
  ])).join(':');
  return env;
}

function sanitizeSessionName(input?: string) {
  const candidate = (input || DEFAULT_SESSION_NAME).trim();
  const normalized = candidate.replace(/[^a-zA-Z0-9:_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || DEFAULT_SESSION_NAME;
}

function getMirrorKey(sessionName: string) {
  return sanitizeSessionName(sessionName);
}

function normalizeClientSessionId(input?: string) {
  const candidate = (input || '').trim();
  if (!candidate) {
    throw new Error('connect payload missing clientSessionId');
  }
  return candidate;
}

function normalizeTerminalCols(cols: number | undefined) {
  if (!Number.isFinite(cols) || cols! <= 0) {
    throw new Error('terminal cols must be a finite positive number');
  }
  return Math.max(1, Math.floor(cols!));
}

function normalizeTerminalRows(rows: number | undefined) {
  if (!Number.isFinite(rows) || rows! <= 0) {
    throw new Error('terminal rows must be a finite positive number');
  }
  return Math.max(1, Math.floor(rows!));
}

function createWebSocketSessionTransport(ws: WebSocket): ClientSessionTransport {
  return {
    kind: 'ws',
    get readyState() {
      return ws.readyState;
    },
    sendText(text: string) {
      ws.send(text);
    },
    close(reason?: string) {
      ws.close(1000, reason);
    },
    ping() {
      ws.ping();
    },
  };
}

function createRtcSessionTransport(transport: RtcServerTransport): ClientSessionTransport {
  return {
    kind: 'rtc',
    get readyState() {
      return transport.readyState;
    },
    sendText(text: string) {
      transport.sendText(text);
    },
    close(reason?: string) {
      transport.close(reason);
    },
  };
}

function sendTransportMessage(transport: ClientSessionTransport | null | undefined, message: ServerMessage) {
  if (!transport || transport.readyState !== WebSocket.OPEN) {
    return;
  }
  transport.sendText(JSON.stringify(message));
}

function sendMessage(session: ClientSession, message: ServerMessage) {
  if (session.transport && session.transport.readyState === WebSocket.OPEN) {
    if (message.type === 'buffer-sync' || message.type === 'connected') {
      daemonRuntimeDebug('send', {
        sessionId: session.id,
        sessionName: session.sessionName,
        type: message.type,
        payload: summarizePayload(message),
      });
    }
    sendTransportMessage(session.transport, message);
  }
}

function buildScheduleStatePayload(sessionName: string): ScheduleStatePayload {
  return {
    sessionName,
    jobs: scheduleEngine.listBySession(sessionName),
  };
}

function sendScheduleStateToSession(session: ClientSession, sessionName = session.sessionName) {
  if (!sessionName) {
    return;
  }
  sendMessage(session, {
    type: 'schedule-state',
    payload: buildScheduleStatePayload(sessionName),
  });
}

function broadcastScheduleState(sessionName: string) {
  if (!sessionName) {
    return;
  }
  for (const session of sessions.values()) {
    if (session.sessionName !== sessionName || session.state === 'closed') {
      continue;
    }
    sendScheduleStateToSession(session, sessionName);
  }
}

function broadcastScheduleEvent(event: ScheduleEventPayload) {
  for (const session of sessions.values()) {
    if (session.sessionName !== event.sessionName || session.state === 'closed') {
      continue;
    }
    sendMessage(session, {
      type: 'schedule-event',
      payload: event,
    });
  }
}

function broadcastRuntimeDebugControl(enabled: boolean, reason: string, sessionId?: string) {
  for (const session of sessions.values()) {
    if (session.state === 'closed') {
      continue;
    }
    if (sessionId && session.id !== sessionId) {
      continue;
    }
    sendMessage(session, {
      type: 'debug-control',
      payload: {
        enabled,
        reason,
      },
    });
  }
}

function writeToTmuxSession(sessionName: string, payload: string, appendEnter: boolean) {
  runTmux(['send-keys', '-t', sessionName, '-l', '--', payload]);
  if (appendEnter) {
    runTmux(['send-keys', '-t', sessionName, 'Enter']);
  }
}

function writeToLiveMirror(sessionName: string, payload: string) {
  const mirror = mirrors.get(getMirrorKey(sessionName));
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    return false;
  }
  mirror.ptyProcess.write(payload);
  return true;
}

const scheduleEngine = new ScheduleEngine({
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
  onStateChange: (sessionName) => {
    broadcastScheduleState(sessionName);
  },
  onEvent: (event) => {
    broadcastScheduleEvent(event);
  },
});

function readLatestUpdateManifest() {
  const manifestPath = join(UPDATES_DIR, 'latest.json');
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      versionCode?: number;
      versionName?: string;
    };
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] failed to parse update manifest: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function resolveRequestOrigin(request: IncomingMessage) {
  const host = request.headers.host || `${HOST}:${PORT}`;
  const protocol = 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function buildConnectedPayload(sessionId: string, requestOrOrigin?: IncomingMessage | string) {
  const latestManifest = readLatestUpdateManifest();
  const requestOrigin =
    typeof requestOrOrigin === 'string'
      ? requestOrOrigin
      : requestOrOrigin
        ? resolveRequestOrigin(requestOrOrigin)
        : `http://${HOST}:${PORT}`;
  const manifestUrl = `${requestOrigin}/updates/latest.json`;

  return {
    sessionId,
    appUpdate:
      latestManifest && Number.isFinite(latestManifest.versionCode) && latestManifest.versionCode! > 0 && latestManifest.versionName
        ? {
            versionCode: latestManifest.versionCode!,
            versionName: latestManifest.versionName,
            manifestUrl,
          }
        : Number.isFinite(APP_UPDATE_VERSION_CODE) && APP_UPDATE_VERSION_CODE > 0 && APP_UPDATE_VERSION_NAME
          ? {
              versionCode: APP_UPDATE_VERSION_CODE,
              versionName: APP_UPDATE_VERSION_NAME,
              manifestUrl: APP_UPDATE_MANIFEST_URL || manifestUrl,
            }
        : undefined,
  };
}

function writeCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZTerm-Token');
}

function serveJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  writeCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveUpdateFilePath(pathname: string) {
  const relativePath = pathname.replace(/^\/updates\//, '');
  const safeName = basename(relativePath);
  const absolutePath = resolve(UPDATES_DIR, safeName);
  if (!absolutePath.startsWith(resolve(UPDATES_DIR))) {
    return null;
  }
  return absolutePath;
}

function buildRuntimeHealthSnapshot(request: IncomingMessage) {
  const requestHost = request.headers.host || `${HOST}:${PORT}`;
  const memoryUsage = process.memoryUsage();
  const sessionEntries = Array.from(sessions.values());
  const mirrorEntries = Array.from(mirrors.values());
  return {
    ok: true,
    wsUrl: `ws://${requestHost}`,
    updatesUrl: `${resolveRequestOrigin(request)}/updates/latest.json`,
    updatesDir: UPDATES_DIR,
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    memory: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
    },
    sessions: {
      total: sessionEntries.length,
      connected: sessionEntries.filter((session) => session.state === 'connected').length,
      connecting: sessionEntries.filter((session) => session.state === 'connecting').length,
    },
    mirrors: {
      total: mirrorEntries.length,
      connected: mirrorEntries.filter((mirror) => mirror.state === 'connected').length,
      subscribers: mirrorEntries.reduce((sum, mirror) => sum + mirror.subscribers.size, 0),
    },
  };
}

function extractHttpDebugToken(request: IncomingMessage, url: URL) {
  const authorization = request.headers.authorization?.trim() || '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  const headerToken = request.headers['x-zterm-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  return url.searchParams.get('token')?.trim() || '';
}

function ensureDebugAuthorized(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (!REQUIRED_AUTH_TOKEN) {
    return true;
  }

  const providedToken = extractHttpDebugToken(request, url);
  if (providedToken === REQUIRED_AUTH_TOKEN) {
    return true;
  }

  serveJson(response, { message: 'unauthorized debug access' }, 401);
  return false;
}

function buildDebugRuntimeSnapshot(request: IncomingMessage) {
  const sessionEntries = Array.from(sessions.values());
  const mirrorEntries = Array.from(mirrors.values());

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    authEnabled: Boolean(REQUIRED_AUTH_TOKEN),
    health: buildRuntimeHealthSnapshot(request),
    clientDebug: clientRuntimeDebugStore.getSummary(),
    clientSessions: sessionEntries.map((session) => ({
      id: session.id,
      state: session.state,
      sessionName: session.sessionName,
      title: session.title,
      cols: session.cols,
      rows: session.rows,
      wsAlive: session.wsAlive,
      requestOrigin: session.requestOrigin,
    })),
    mirrors: mirrorEntries.map((mirror) => ({
      key: mirror.key,
      sessionName: mirror.sessionName,
      state: mirror.state,
      title: mirror.title,
      revision: mirror.revision,
      latestEndIndex: getMirrorAvailableEndIndex(mirror),
      cols: mirror.cols,
      rows: mirror.rows,
      bufferStartIndex: mirror.bufferStartIndex,
      bufferEndIndex: getMirrorAvailableEndIndex(mirror),
      bufferedLines: mirror.bufferLines.length,
      cursorKeysApp: mirror.cursorKeysApp,
      subscribers: Array.from(mirror.subscribers),
      lastFlushStartedAt: mirror.lastFlushStartedAt,
      lastFlushCompletedAt: mirror.lastFlushCompletedAt,
      flushInFlight: mirror.flushInFlight,
    })),
  };
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  writeCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }

  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || '/', origin);

  if (url.pathname === '/health') {
    serveJson(response, buildRuntimeHealthSnapshot(request));
    return;
  }

  if (url.pathname === '/debug/runtime') {
    if (!ensureDebugAuthorized(request, response, url)) {
      return;
    }
    serveJson(response, buildDebugRuntimeSnapshot(request));
    return;
  }

  if (url.pathname === '/debug/runtime/logs') {
    if (!ensureDebugAuthorized(request, response, url)) {
      return;
    }
    const limit = resolveDebugRouteLimit(url.searchParams.get('limit'));
    const sessionId = url.searchParams.get('sessionId')?.trim() || '';
    const tmuxSessionName = url.searchParams.get('tmuxSessionName')?.trim() || '';
    const scopeIncludes = url.searchParams.get('scope')?.trim() || '';
    const entries = clientRuntimeDebugStore.listEntries({
      limit,
      sessionId: sessionId || undefined,
      tmuxSessionName: tmuxSessionName || undefined,
      scopeIncludes: scopeIncludes || undefined,
    });
    serveJson(response, {
      ok: true,
      generatedAt: new Date().toISOString(),
      limit,
      returned: entries.length,
      filters: {
        sessionId: sessionId || null,
        tmuxSessionName: tmuxSessionName || null,
        scope: scopeIncludes || null,
      },
      entries,
    });
    return;
  }

  if (url.pathname === '/debug/runtime/control') {
    if (!ensureDebugAuthorized(request, response, url)) {
      return;
    }
    const enabledRaw = (url.searchParams.get('enabled') || '').trim().toLowerCase();
    const enabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'on';
    const sessionId = url.searchParams.get('sessionId')?.trim() || '';
    const reason = url.searchParams.get('reason')?.trim() || 'remote-http-control';
    broadcastRuntimeDebugControl(enabled, reason, sessionId || undefined);
    serveJson(response, {
      ok: true,
      enabled,
      reason,
      sessionId: sessionId || null,
      targetedSessions: sessionId
        ? Array.from(sessions.values()).filter((session) => session.id === sessionId && session.state !== 'closed').map((session) => session.id)
        : Array.from(sessions.values()).filter((session) => session.state !== 'closed').map((session) => session.id),
    });
    return;
  }

  if (url.pathname === '/updates/latest.json') {
    const manifestPath = join(UPDATES_DIR, 'latest.json');
    if (!existsSync(manifestPath)) {
      serveJson(response, { message: 'update manifest not found' }, 404);
      return;
    }

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      const apkUrl = typeof manifest.apkUrl === 'string' ? manifest.apkUrl : '';
      if (apkUrl && !/^https?:\/\//.test(apkUrl)) {
        manifest.apkUrl = `${origin}/updates/${basename(apkUrl)}`;
      }
      serveJson(response, manifest);
    } catch (error) {
      serveJson(response, { message: `invalid update manifest: ${error instanceof Error ? error.message : String(error)}` }, 500);
    }
    return;
  }

  if (url.pathname.startsWith('/updates/')) {
    const filePath = resolveUpdateFilePath(url.pathname);
    if (!filePath || !existsSync(filePath)) {
      serveJson(response, { message: 'update file not found' }, 404);
      return;
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', filePath.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream');
    createReadStream(filePath).pipe(response);
    return;
  }

  serveJson(response, { message: 'not found' }, 404);
}

function runTmux(args: string[]) {
  const result = spawnSync(TMUX_BINARY, args, {
    encoding: 'utf-8',
    cwd: process.env.HOME || homedir(),
    env: cleanEnv(),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    if (stderr.includes('no server running on') && args[0] === 'list-sessions') {
      return { ok: true as const, stdout: '' };
    }
    throw new Error(stderr || `tmux exited with status ${result.status}`);
  }

  return { ok: true as const, stdout: result.stdout || '' };
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: process.env.HOME || homedir(),
    env: cleanEnv(),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
  }

  return result;
}

function sanitizeUploadFileName(input?: string) {
  const generatedName = `upload-${Date.now()}`;
  const candidate = (input || generatedName).trim() || generatedName;
  return candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function ensureUploadDir() {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

function normalizeImageToPng(inputPath: string, preferredBaseName: string) {
  ensureUploadDir();
  const outputPath = join(UPLOAD_DIR, `${preferredBaseName}-${Date.now()}.png`);
  runCommand('sips', ['-s', 'format', 'png', inputPath, '--out', outputPath]);
  return outputPath;
}

function writeImageToClipboard(pngPath: string) {
  runCommand('osascript', [
    '-e',
    `set f to POSIX file "${pngPath.replace(/"/g, '\\"')}"`,
    '-e',
    'set the clipboard to (read f as «class PNGf»)',
  ]);
}

function persistClipboardImageBuffer(
  fileMeta: {
    name: string;
    mimeType: string;
  },
  buffer: Buffer,
) {
  ensureUploadDir();
  const safeName = sanitizeUploadFileName(fileMeta.name || 'upload');
  const explicitExt = extname(safeName);
  const sourceExt =
    explicitExt
    || (fileMeta.mimeType === 'image/jpeg'
      ? '.jpg'
      : fileMeta.mimeType === 'image/png'
        ? '.png'
        : fileMeta.mimeType === 'image/gif'
          ? '.gif'
          : '');
  const sourcePath = join(UPLOAD_DIR, `${safeName.replace(/\.[^.]+$/u, '')}-${Date.now()}${sourceExt}`);
  writeFileSync(sourcePath, buffer);
  const pngPath = normalizeImageToPng(sourcePath, safeName.replace(/\.[^.]+$/u, ''));
  writeImageToClipboard(pngPath);
  return { sourcePath, pngPath, bytes: buffer.byteLength };
}

function persistClipboardImage(payload: PasteImagePayload) {
  return persistClipboardImageBuffer(
    {
      name: payload.name,
      mimeType: payload.mimeType,
    },
    Buffer.from(payload.dataBase64, 'base64'),
  );
}

function logCleanupFailure(scope: string, filePath: string, error: unknown) {
  console.warn(
    `[${new Date().toISOString()}] ${scope} cleanup failed for ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function listTmuxSessions() {
  const result = runTmux(['list-sessions', '-F', '#S']);

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !HIDDEN_TMUX_SESSIONS.has(line));
}

function readTmuxStatusLineCount() {
  try {
    const result = runTmux(['display-message', '-p', '#{?status,1,0}']);
    return result.stdout.trim() === '1' ? 1 : 0;
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] failed to read tmux status line count; defaulting to 0: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
}

function resolveRequestedTmuxRows(contentRows: number) {
  const safeContentRows = Math.max(1, Math.floor(contentRows));
  return safeContentRows + readTmuxStatusLineCount();
}

function readTmuxPaneMetrics(sessionName: string): TmuxPaneMetrics {
  const result = runTmux(['display-message', '-p', '-t', sessionName, '#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}']);
  const [paneIdRaw, tmuxAvailableLineCountRaw, rowsRaw, colsRaw, alternateOnRaw] = result.stdout.trim().split('\t');
  const paneRows = Number.parseInt(rowsRaw ?? '', 10);
  const paneCols = Number.parseInt(colsRaw ?? '', 10);
  if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
    throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ''} cols=${colsRaw ?? ''}`);
  }
  return {
    paneId: paneIdRaw?.trim() || sessionName,
    tmuxAvailableLineCountHint: Math.max(0, Number.parseInt(tmuxAvailableLineCountRaw ?? '', 10) || 0),
    paneRows,
    paneCols,
    alternateOn: alternateOnRaw === '1',
  };
}

function readTmuxPaneCurrentPath(sessionName: string) {
  const result = runTmux(['display-message', '-p', '-t', sessionName, '#{pane_current_path}']);
  const currentPath = result.stdout.trim();
  if (!currentPath) {
    throw new Error(`tmux returned empty pane_current_path for ${sessionName}`);
  }
  return currentPath;
}

function readTmuxCursorState(target: string): TmuxCursorState {
  const result = runTmux(['display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag}']);
  const [colRaw = '0', rowRaw = '0', visibleRaw = '0', cursorKeysAppRaw = '0'] = result.stdout.trim().split(/\s+/u);
  return {
    col: Math.max(0, Number.parseInt(colRaw, 10) || 0),
    row: Math.max(0, Number.parseInt(rowRaw, 10) || 0),
    visible: visibleRaw === '1',
    cursorKeysApp: cursorKeysAppRaw === '1',
  };
}

function captureTmuxMirrorLines(
  target: string,
  options: {
    paneRows: number;
    maxLines: number;
    alternateOn: boolean;
  },
) {
  const safePaneRows = Math.max(1, Math.floor(options.paneRows));
  const safeMaxLines = Math.max(1, Math.floor(options.maxLines));
  const captureResult = runTmux(options.alternateOn
    ? [
        'capture-pane',
        '-M',
        '-p',
        '-e',
        '-N',
        '-t',
        target,
        '-S',
        '0',
        '-E',
        `${Math.max(0, safePaneRows - 1)}`,
      ]
    : [
        'capture-pane',
        '-p',
        '-e',
        '-N',
        '-t',
        target,
        '-S',
        `-${safeMaxLines}`,
        '-E',
        `${Math.max(0, safePaneRows - 1)}`,
      ]);

  const normalizedLines = normalizeMirrorCaptureLines(captureResult.stdout, {
    paneRows: safePaneRows,
    alternateOn: options.alternateOn,
  });
  if (options.alternateOn || normalizedLines.length <= safeMaxLines) {
    return normalizedLines;
  }
  return normalizedLines.slice(-safeMaxLines);
}

async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
  const metrics = readTmuxPaneMetrics(mirror.sessionName);
  const cursor = readTmuxCursorState(metrics.paneId);
  const maxLines = resolveMirrorCacheLines(metrics.paneRows);
  const capturedLines = captureTmuxMirrorLines(metrics.paneId, {
    paneRows: metrics.paneRows,
    maxLines,
    alternateOn: metrics.alternateOn,
  });

  const scratchBridge = mirror.scratchBridge ?? await WasmBridge.load();
  mirror.scratchBridge = scratchBridge;
  scratchBridge.init(metrics.paneCols, metrics.paneRows);
  if (capturedLines.length > 0) {
    scratchBridge.writeString(capturedLines.join('\r\n'));
  }

  const visibleRows = buildVisibleRows(scratchBridge).map(trimTrailingDefaultCells);
  const scratchScrollbackCount = scratchBridge.getScrollbackCount();
  const scrollbackKeepCount = Math.max(0, Math.min(scratchScrollbackCount, maxLines - visibleRows.length));
  const scrollbackStartOldestIndex = Math.max(0, scratchScrollbackCount - scrollbackKeepCount);
  const scrollbackTail =
    scrollbackKeepCount > 0
      ? readScrollbackRangeByOldestIndex(scratchBridge, scrollbackStartOldestIndex, scratchScrollbackCount)
      : [];

  const totalAvailableLines = resolveCanonicalAvailableLineCount({
    paneRows: metrics.paneRows,
    tmuxAvailableLineCountHint: metrics.tmuxAvailableLineCountHint,
    capturedLineCount: capturedLines.length,
    scratchLineCount: scratchScrollbackCount + visibleRows.length,
  });
  const nextBufferLines = [...scrollbackTail, ...visibleRows];
  const nextBufferStartIndex = Math.max(0, totalAvailableLines - nextBufferLines.length);

  mirror.rows = metrics.paneRows;
  mirror.cols = metrics.paneCols;
  mirror.cursorKeysApp = cursor.cursorKeysApp;
  mirror.lastScrollbackCount = scratchScrollbackCount;
  const trimmed = trimCanonicalBufferWindow(
    nextBufferStartIndex,
    nextBufferLines,
    resolveMirrorCacheLines(mirror.rows),
  );
  mirror.bufferStartIndex = trimmed.startIndex;
  mirror.bufferLines = trimmed.lines;
  const availableEndIndex = getMirrorAvailableEndIndex(mirror);
  mirror.cursor = normalizeMirrorCursor({
    bufferStartIndex: mirror.bufferStartIndex,
    availableEndIndex,
    paneRows: mirror.rows,
    cursor,
  });
  const visibleTopIndex = Math.max(mirror.bufferStartIndex, availableEndIndex - mirror.rows);

  console.log(
    `[${new Date().toISOString()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${capturedLines.length} scratch=${scratchScrollbackCount + visibleRows.length} total=${totalAvailableLines} rows=${metrics.paneRows} cols=${metrics.paneCols} buffer=${mirror.bufferStartIndex}-${availableEndIndex} visible=${visibleTopIndex}-${availableEndIndex}`,
  );

  return true;
}

function createDetachedTmuxSession(input?: string) {
  const sessionName = sanitizeSessionName(input);
  runTmux(['new-session', '-d', '-s', sessionName]);
  return sessionName;
}

function renameTmuxSession(currentName?: string, nextName?: string) {
  const sessionName = sanitizeSessionName(currentName);
  const nextSessionName = sanitizeSessionName(nextName);
  runTmux(['rename-session', '-t', sessionName, nextSessionName]);
  return nextSessionName;
}

function createTransportConnection(transport: ClientSessionTransport, requestOrigin: string): TransportConnection {
  const transportId = uuidv4();
  const connection: TransportConnection = {
    id: uuidv4(),
    transportId,
    transport,
    closeTransport: (reason: string) => {
      if (transport.readyState < WebSocket.CLOSING) {
        transport.close(reason);
      }
    },
    requestOrigin,
    wsAlive: true,
    role: 'pending',
    boundSessionId: null,
  };
  connections.set(connection.id, connection);
  return connection;
}

function createLogicalClientSession(clientSessionId: string, requestOrigin: string): ClientSession {
  const session: ClientSession = {
    id: clientSessionId,
    clientSessionId,
    transportId: null,
    transport: null,
    closeTransport: undefined,
    requestOrigin,
    state: 'idle',
    title: 'Terminal',
    sessionName: DEFAULT_SESSION_NAME,
    mirrorKey: null,
    cols: DEFAULT_TERMINAL_SESSION_VIEWPORT.cols,
    rows: DEFAULT_TERMINAL_SESSION_VIEWPORT.rows,
    terminalWidthMode: 'mirror-fixed',
    requestedAdaptiveCols: null,
    wsAlive: false,
    pendingPasteImage: null,
    pendingAttachFile: null,
    logicalSessionBound: true,
  };
  sessions.set(session.id, session);
  return session;
}

function normalizeBufferSyncRequestPayload(
  session: ClientSession,
  request: BufferSyncRequestPayload,
): BufferSyncRequestPayload {
  const localStartIndex = Number.isFinite(request.localStartIndex)
    ? Math.max(0, Math.floor(request.localStartIndex))
    : 0;
  if (!Number.isFinite(request.requestStartIndex) || !Number.isFinite(request.requestEndIndex)) {
    throw new Error(`buffer-sync-request missing request window for session ${session.id}`);
  }
  const requestStartIndex = Math.max(0, Math.floor(request.requestStartIndex));
  const requestEndIndex = Math.max(0, Math.floor(request.requestEndIndex));

  return {
    knownRevision: Number.isFinite(request.knownRevision)
      ? Math.max(0, Math.floor(request.knownRevision))
      : 0,
    localStartIndex,
    localEndIndex: Number.isFinite(request.localEndIndex)
      ? Math.max(localStartIndex, Math.floor(request.localEndIndex))
      : localStartIndex,
    requestStartIndex,
    requestEndIndex: Math.max(requestStartIndex, requestEndIndex),
    missingRanges: request.missingRanges,
  };
}

function normalizeSessionTransportToken(input?: string) {
  const token = (input || '').trim();
  if (!token) {
    throw new Error('connect payload missing sessionTransportToken');
  }
  return token;
}

function handleSessionOpen(connection: TransportConnection, payload: TmuxConnectPayload) {
  const clientSessionId = normalizeClientSessionId(payload.clientSessionId);
  const logicalSession = getOrCreateLogicalClientSession(clientSessionId, connection.requestOrigin);
  connection.role = 'control';
  connection.boundSessionId = null;
  const sessionName = sanitizeSessionName(payload.sessionName || payload.name);
  const issued = issueSessionTransportTicket(sessionTransportTicketStore, clientSessionId);
  sendTransportMessage(connection.transport, {
    type: 'session-ticket',
    payload: {
      clientSessionId,
      sessionTransportToken: issued.token,
      sessionName,
    },
  });
  return logicalSession;
}

function handleSessionTransportConnect(connection: TransportConnection, payload: TmuxConnectPayload) {
  const clientSessionId = normalizeClientSessionId(payload.clientSessionId);
  const token = normalizeSessionTransportToken(payload.sessionTransportToken);
  const ticket = takeSessionTransportTicket(sessionTransportTicketStore, token);
  if (!ticket || ticket.clientSessionId !== clientSessionId) {
    sendTransportMessage(connection.transport, {
      type: 'error',
      payload: {
        message: 'Invalid session transport ticket',
        code: 'session_transport_ticket_invalid',
      },
    });
    connection.closeTransport('session transport ticket invalid');
    return null;
  }
  const logicalSession = sessions.get(clientSessionId) || null;
  if (!logicalSession) {
    sendTransportMessage(connection.transport, {
      type: 'error',
      payload: {
        message: `Logical client session ${clientSessionId} not found`,
        code: 'logical_session_missing',
      },
    });
    connection.closeTransport('logical client session missing');
    return null;
  }
  return bindTransportConnectionToLogicalSession(connection, logicalSession);
}

function createMirror(sessionName: string): SessionMirror {
  const key = getMirrorKey(sessionName);
  const mirror: SessionMirror = {
    key,
    sessionName: key,
    ptyProcess: null,
    scratchBridge: null,
    state: 'idle',
    title: key,
    cols: DEFAULT_TERMINAL_SESSION_VIEWPORT.cols,
    rows: DEFAULT_TERMINAL_SESSION_VIEWPORT.rows,
    cursorKeysApp: false,
    revision: 0,
    lastScrollbackCount: -1,
    bufferStartIndex: 0,
    bufferLines: [],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    flushInFlight: false,
    flushPromise: null,
    liveSyncTimer: null,
    subscribers: new Set(),
  };
  mirrors.set(key, mirror);
  return mirror;
}

function getClientMirror(session: ClientSession) {
  if (!session.mirrorKey) {
    return null;
  }
  return mirrors.get(session.mirrorKey) || null;
}

function getOrCreateLogicalClientSession(clientSessionId: string, requestOrigin: string) {
  const existing = sessions.get(clientSessionId) || null;
  if (existing) {
    existing.requestOrigin = requestOrigin;
    if (existing.state === 'closed') {
      existing.state = 'idle';
    }
    existing.logicalSessionBound = true;
    return existing;
  }
  return createLogicalClientSession(clientSessionId, requestOrigin);
}

function bindTransportConnectionToLogicalSession(
  connection: TransportConnection,
  session: ClientSession,
) {
  const replacedTransportId = attachClientSessionTransport(
    session,
    connection.transportId,
    connection.closeTransport,
  ).replacedTransportId;
  if (
    replacedTransportId
    && session.transport
    && session.transport !== connection.transport
    && session.transport.readyState < WebSocket.CLOSING
  ) {
    try {
      session.transport.close('transport replaced by reconnect');
    } catch (error) {
      console.warn(
        `[${new Date().toISOString()}] failed to close replaced transport for ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  session.transport = connection.transport;
  session.requestOrigin = connection.requestOrigin;
  session.wsAlive = true;
  session.logicalSessionBound = true;
  connection.role = 'session';
  connection.boundSessionId = session.id;
  return session;
}

function detachClientSessionTransportOnly(session: ClientSession, reason: string, transportId?: string) {
  const current = sessions.get(session.id);
  if (!current || current !== session) {
    return;
  }
  if (transportId && session.transportId !== transportId) {
    return;
  }
  session.transport = null;
  session.closeTransport = undefined;
  session.pendingPasteImage = null;
  session.pendingAttachFile = null;
  session.wsAlive = false;
  markLogicalClientSessionTransportDetached(sessions, session.id);
  daemonRuntimeDebug('transport-detached', {
    sessionId: session.id,
    sessionName: session.sessionName,
    type: 'closed',
    payload: { reason },
  });
}

function closeLogicalClientSession(session: ClientSession, reason: string, notifyClient = false) {
  const current = sessions.get(session.id);
  if (!current || current !== session || session.state === 'closed') {
    return;
  }
  const mirror = getClientMirror(session);
  if (mirror) {
    const detachResult = detachMirrorSubscriber(mirror.subscribers, session.id);
    mirror.subscribers = detachResult.nextSubscribers;
    if (detachResult.shouldReconcileGeometry) {
      void reconcileMirrorGeometry(mirror).catch((error) => {
        console.error(
          `[${new Date().toISOString()}] failed to reconcile mirror geometry after detach for ${mirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  if (notifyClient) {
    sendMessage(session, { type: 'closed', payload: { reason } });
  }

  if (session.transport && session.transport.readyState < WebSocket.CLOSING) {
    try {
      session.transport.close(reason);
    } catch (error) {
      console.warn(
        `[${new Date().toISOString()}] failed to close client transport for ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  session.transport = null;
  session.transportId = null;
  session.closeTransport = undefined;
  session.wsAlive = false;
  session.pendingPasteImage = null;
  session.pendingAttachFile = null;
  session.mirrorKey = null;
  session.state = 'closed';
  revokeSessionTransportTicket(sessionTransportTicketStore, session.id);
  removeLogicalClientSession(sessions, session.id);
}

function destroyMirror(mirror: SessionMirror, reason: string, notifyClients = true) {
  if (mirror.state === 'closed') {
    return;
  }

  mirror.state = 'closed';

  if (mirror.ptyProcess) {
    try {
      mirror.ptyProcess.kill();
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Failed to kill pty for mirror ${mirror.key}:`, error);
    }
    mirror.ptyProcess = null;
  }

  if (notifyClients) {
    for (const sessionId of mirror.subscribers) {
      const client = sessions.get(sessionId);
      if (!client) {
        continue;
      }
      client.mirrorKey = null;
      client.state = 'closed';
      sendMessage(client, { type: 'closed', payload: { reason } });
    }
  }

  closeMirrorSubscribers(sessions, mirror.subscribers);
  mirror.subscribers.clear();
  mirror.scratchBridge = null;
  mirror.bufferLines = [];
  mirror.bufferStartIndex = 0;
  mirror.cursor = null;
  mirror.lastFlushStartedAt = 0;
  mirror.lastFlushCompletedAt = 0;
  mirror.lastScrollbackCount = -1;
  mirror.flushInFlight = false;
  mirror.flushPromise = null;
  if (mirror.liveSyncTimer) {
    clearTimeout(mirror.liveSyncTimer);
    mirror.liveSyncTimer = null;
  }
  mirrors.delete(mirror.key);
}

function serializeCell(cell: ReturnType<WasmBridge['getCell']>): TerminalCell {
  return {
    char: cell.char,
    fg: cell.fg,
    bg: cell.bg,
    flags: cell.flags,
    width: cell.width,
  };
}

function buildVisibleRows(bridge: WasmBridge) {
  const rows = bridge.getRows();
  const cols = bridge.getCols();
  const visibleRows: TerminalCell[][] = [];

  for (let row = 0; row < rows; row += 1) {
    const cells: TerminalCell[] = [];
    for (let col = 0; col < cols; col += 1) {
      cells.push(serializeCell(bridge.getCell(row, col)));
    }
    visibleRows.push(cells);
  }

  return visibleRows;
}

function readScrollbackLineByOldestIndex(bridge: WasmBridge, totalCount: number, oldestIndex: number) {
  const offset = totalCount - 1 - oldestIndex;
  const lineLen = bridge.getScrollbackLineLen(offset);
  const cells: TerminalCell[] = [];
  for (let col = 0; col < lineLen; col += 1) {
    cells.push(serializeCell(bridge.getScrollbackCell(offset, col)));
  }
  return trimTrailingDefaultCells(cells);
}

function getMirrorAvailableEndIndex(mirror: SessionMirror) {
  return mirror.bufferStartIndex + mirror.bufferLines.length;
}

function resolveMirrorTargetGeometry(
  mirror: SessionMirror,
  baselineGeometry: { cols: number; rows: number } = { cols: mirror.cols, rows: mirror.rows },
) {
  return resolveMirrorSubscriberGeometry({
    baselineGeometry: {
      cols: normalizeTerminalCols(baselineGeometry.cols),
      rows: normalizeTerminalRows(baselineGeometry.rows),
    },
    subscribers: Array.from(mirror.subscribers)
      .map((sessionId) => sessions.get(sessionId) || null)
      .filter((session): session is ClientSession => Boolean(session && session.state !== 'closed'))
      .map((session) => ({
        widthMode: session.terminalWidthMode,
        requestedCols: session.requestedAdaptiveCols,
      })),
  });
}

function readScrollbackRangeByOldestIndex(bridge: WasmBridge, startInclusive: number, endExclusive: number) {
  const totalCount = bridge.getScrollbackCount();
  if (totalCount <= 0 || endExclusive <= startInclusive) {
    return [];
  }

  const start = Math.max(0, Math.min(startInclusive, totalCount));
  const end = Math.max(start, Math.min(endExclusive, totalCount));
  const lines: TerminalCell[][] = [];
  for (let oldestIndex = start; oldestIndex < end; oldestIndex += 1) {
    lines.push(readScrollbackLineByOldestIndex(bridge, totalCount, oldestIndex));
  }
  return lines;
}

function mirrorBufferChanged(
  mirror: SessionMirror,
  previousStartIndex: number,
  previousLines: TerminalCell[][],
) {
  return findChangedIndexedRanges({
    previousStartIndex,
    previousLines,
    nextStartIndex: mirror.bufferStartIndex,
    nextLines: mirror.bufferLines,
  });
}

function ensureSessionConnected(session: ClientSession, mirror: SessionMirror) {
  const titleChanged = session.title !== mirror.title;
  session.title = mirror.title;
  session.sessionName = mirror.sessionName;
  if (session.state !== 'connected') {
    session.state = 'connected';
    sendMessage(session, { type: 'connected', payload: buildConnectedPayload(session.id, session.requestOrigin) });
    sendScheduleStateToSession(session, mirror.sessionName);
    sendMessage(session, { type: 'title', payload: mirror.title });
    return;
  }
  if (titleChanged) {
    sendMessage(session, { type: 'title', payload: mirror.title });
  }
}

function announceMirrorSubscribersReady(mirror: SessionMirror) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state === 'closed') {
      continue;
    }
    ensureSessionConnected(session, mirror);
  }
}

function sendBufferHeadToSession(
  session: ClientSession,
  mirror: SessionMirror,
) {
  if (session.state === 'closed' || !session.transport || session.transport.readyState !== WebSocket.OPEN) {
    return;
  }
  ensureSessionConnected(session, mirror);
  sendMessage(session, {
    type: 'buffer-head',
    payload: buildBufferHeadPayload(session.id, mirror),
  });
}

async function syncMirrorCanonicalBuffer(
  mirror: SessionMirror,
  options?: { forceRevision?: boolean },
) {
  if (mirror.state !== 'connected') {
    return false;
  }

  if (mirror.flushPromise) {
    return mirror.flushPromise;
  }

  const previousStartIndex = mirror.bufferStartIndex;
  const previousLines = mirror.bufferLines.slice();
  const previousCursor = mirror.cursor ? { ...mirror.cursor } : null;
  const previousCursorKeysApp = mirror.cursorKeysApp;
  const forceRevision = Boolean(options?.forceRevision);

  mirror.lastFlushStartedAt = Date.now();
  mirror.flushInFlight = true;
  const capturePromise = captureMirrorAuthoritativeBufferFromTmux(mirror)
    .then((captured) => {
      if (!captured) {
        throw new Error('tmux capture returned no canonical buffer');
      }

      const changedRanges = mirrorBufferChanged(mirror, previousStartIndex, previousLines);
      const cursorChanged = !mirrorCursorEqual(previousCursor, mirror.cursor);
      const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
      if (forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged) {
        mirror.revision += 1;
      }

      return true;
    })
    .catch((error) => {
      console.error(
        `[${new Date().toISOString()}] canonical mirror refresh failed for ${mirror.sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    })
    .finally(() => {
      mirror.lastFlushCompletedAt = Date.now();
      mirror.flushInFlight = false;
      mirror.flushPromise = null;
    });

  mirror.flushPromise = capturePromise;
  return capturePromise;
}

function scheduleMirrorLiveSync(mirror: SessionMirror, delayMs = 12) {
  if (mirror.state !== 'connected') {
    return;
  }

  if (mirror.liveSyncTimer) {
    clearTimeout(mirror.liveSyncTimer);
  }

  mirror.liveSyncTimer = setTimeout(() => {
    mirror.liveSyncTimer = null;
    void syncMirrorCanonicalBuffer(mirror);
  }, Math.max(0, delayMs));
}

async function resizeConnectedMirror(mirror: SessionMirror, cols: number) {
  if (mirror.state !== 'connected' || !mirror.ptyProcess) {
    return;
  }

  const tmuxRows = resolveRequestedTmuxRows(mirror.rows);
  mirror.cols = cols;
  mirror.ptyProcess.resize(cols, tmuxRows);
  mirror.lastScrollbackCount = -1;
  mirror.bufferLines = [];
  mirror.bufferStartIndex = 0;
  mirror.cursor = null;
  const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
  if (!captured) {
    throw new Error('Failed to capture canonical tmux buffer after resize');
  }
}

async function reconcileMirrorGeometry(mirror: SessionMirror) {
  if (mirror.state !== 'connected' || !mirror.ptyProcess) {
    return false;
  }

  const target = resolveMirrorTargetGeometry(mirror);
  if (
    target.cols === mirror.cols
  ) {
    return false;
  }

  await resizeConnectedMirror(mirror, target.cols);
  return true;
}

async function startMirror(mirror: SessionMirror, autoCommand?: string) {
  if (mirror.state === 'connected' || mirror.state === 'connecting') {
    return;
  }

  mirror.state = 'connecting';
  mirror.title = mirror.sessionName;
  mirror.lastScrollbackCount = -1;
  mirror.bufferLines = [];
  mirror.bufferStartIndex = 0;
  mirror.cursor = null;
  const targetGeometry = resolveMirrorTargetGeometry(mirror);
  mirror.cols = targetGeometry.cols;
  mirror.rows = targetGeometry.rows;
  const requestedTmuxRows = resolveRequestedTmuxRows(targetGeometry.rows);

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(TMUX_BINARY, ['new-session', '-A', '-s', mirror.sessionName], {
      name: 'xterm-256color',
      cols: targetGeometry.cols,
      rows: requestedTmuxRows,
      cwd: process.env.HOME || '/',
      env: cleanEnv(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mirror.state = 'error';
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      session.state = 'error';
      sendMessage(session, { type: 'error', payload: { message: `Failed to spawn tmux: ${message}`, code: 'spawn_failed' } });
    }
    return;
  }

  mirror.ptyProcess = ptyProcess;
  mirror.state = 'connected';

  ptyProcess.onData((_data: string) => {
    scheduleMirrorLiveSync(mirror, 33);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const reason = `pty exited (code=${exitCode}, signal=${signal ?? 'none'})`;
    destroyMirror(mirror, reason);
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
    if (!captured) {
      throw new Error('Failed to capture canonical tmux buffer during initial sync');
    }
    announceMirrorSubscribersReady(mirror);
  } catch (error) {
    mirror.state = 'error';
    console.error(
      `[${new Date().toISOString()}] initial buffer sync failed for ${mirror.sessionName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    for (const sessionId of mirror.subscribers) {
      const subscriber = sessions.get(sessionId);
      if (!subscriber) {
        continue;
      }
      subscriber.state = 'error';
      sendMessage(subscriber, {
        type: 'error',
        payload: {
          message: `Initial canonical sync failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'initial_buffer_sync_failed',
        },
      });
    }
  }

  if (autoCommand?.trim()) {
    const command = autoCommand.endsWith('\r') ? autoCommand : `${autoCommand}\r`;
    setTimeout(() => {
      if (mirror.state === 'connected' && mirror.ptyProcess) {
        mirror.ptyProcess.write(command);
      }
    }, AUTO_COMMAND_DELAY_MS);
  }
}

async function attachTmux(session: ClientSession, payload: TmuxConnectPayload) {
  const nextSessionName = sanitizeSessionName(payload.sessionName || payload.name);
  const nextMirrorKey = getMirrorKey(nextSessionName);
  const existingMirror = mirrors.get(nextMirrorKey) || null;
  const existingTmuxGeometry = existingMirror
    ? null
    : (() => {
      try {
        const metrics = readTmuxPaneMetrics(nextSessionName);
        return {
          cols: metrics.paneCols,
          rows: metrics.paneRows,
        };
      } catch (metricsError) {
        console.warn('[server] readTmuxPaneMetrics failed:', metricsError instanceof Error ? metricsError.message : metricsError);
        return null;
      }
    })();
  const requestedGeometry = resolveAttachGeometry({
    requestedGeometry:
      typeof payload.cols === 'number'
      && Number.isFinite(payload.cols)
      && typeof payload.rows === 'number'
      && Number.isFinite(payload.rows)
        ? {
            cols: payload.cols,
            rows: payload.rows,
          }
        : null,
    currentMirrorGeometry: existingMirror
      ? {
          cols: existingMirror.cols,
          rows: existingMirror.rows,
        }
      : null,
    existingTmuxGeometry,
    previousSessionGeometry: {
      cols: session.cols,
      rows: session.rows,
    },
  });
  const requestedCols = normalizeTerminalCols(requestedGeometry.cols);
  const requestedRows = normalizeTerminalRows(requestedGeometry.rows);

  const previousMirror = getClientMirror(session);
  if (previousMirror) {
    const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
    previousMirror.subscribers = detachResult.nextSubscribers;
    if (detachResult.shouldReconcileGeometry) {
      void reconcileMirrorGeometry(previousMirror).catch((error) => {
        console.error(
          `[${new Date().toISOString()}] failed to reconcile mirror geometry after session switch for ${previousMirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  session.state = 'connecting';
  session.title = nextSessionName;
  session.sessionName = nextSessionName;
  session.mirrorKey = nextMirrorKey;
  session.cols = requestedCols;
  session.rows = requestedRows;
  session.terminalWidthMode = payload.terminalWidthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
  session.requestedAdaptiveCols =
    session.terminalWidthMode === 'adaptive-phone'
    && typeof payload.cols === 'number'
    && Number.isFinite(payload.cols)
      ? normalizeTerminalCols(payload.cols)
      : null;

  let mirror = existingMirror;
  if (!mirror) {
    mirror = createMirror(nextSessionName);
  }
  mirror.subscribers.add(session.id);
  if (mirror.state !== 'connected') {
    const targetGeometry = resolveMirrorTargetGeometry(mirror, { cols: requestedCols, rows: requestedRows });
    mirror.cols = targetGeometry.cols;
    mirror.rows = targetGeometry.rows;
  }
  sendMessage(session, { type: 'title', payload: mirror.title });

  if (mirror.state === 'connected') {
    const resized = await reconcileMirrorGeometry(mirror);
    if (resized) {
      return;
    }
    ensureSessionConnected(session, mirror);
    return;
  }

  await startMirror(mirror, payload.autoCommand);
}

async function handleResize(session: ClientSession, cols: number, rows: number) {
  session.cols = normalizeTerminalCols(cols);
  void rows;
  if (session.terminalWidthMode !== 'adaptive-phone') {
    return;
  }
  session.requestedAdaptiveCols = session.cols;
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    return;
  }
  await reconcileMirrorGeometry(mirror);
}

async function handleTerminalWidthMode(session: ClientSession, mode: 'adaptive-phone' | 'mirror-fixed', cols?: number) {
  session.terminalWidthMode = mode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
  session.requestedAdaptiveCols =
    session.terminalWidthMode === 'adaptive-phone'
    && typeof cols === 'number'
    && Number.isFinite(cols)
    && cols > 0
      ? normalizeTerminalCols(cols)
      : null;
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    return;
  }
  if (session.terminalWidthMode !== 'adaptive-phone') {
    return;
  }
  await reconcileMirrorGeometry(mirror);
}

function handleInput(session: ClientSession, data: string) {
  const mirror = getClientMirror(session);
  if (mirror?.state === 'connected' && mirror.ptyProcess) {
    mirror.ptyProcess.write(data);
    scheduleMirrorLiveSync(mirror, 33);
  }
}

function handlePasteImage(session: ClientSession, payload: PasteImagePayload) {
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    sendMessage(session, { type: 'error', payload: { message: 'Session is not ready for image paste', code: 'session_not_ready' } });
    return;
  }

  try {
    const { sourcePath, pngPath, bytes } = persistClipboardImage(payload);
    const pasteSequence = payload.pasteSequence || '\x16';
    mirror.ptyProcess.write(pasteSequence);
    scheduleMirrorLiveSync(mirror, 33);
    sendMessage(session, {
      type: 'image-pasted',
      payload: {
        name: payload.name,
        mimeType: payload.mimeType,
        bytes,
      },
    });
    try {
      unlinkSync(sourcePath);
    } catch (error) {
      logCleanupFailure('paste-image', sourcePath, error);
    }
    try {
      unlinkSync(pngPath);
    } catch (error) {
      logCleanupFailure('paste-image', pngPath, error);
    }
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    sendMessage(session, { type: 'error', payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' } });
  }
}

// ============================================
// File Transfer handlers (Epic-007)
// ============================================

const FILE_CHUNK_SIZE = 256 * 1024; // 256KB per chunk
const REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS = 15000;

function handleFileListRequest(session: ClientSession, payload: FileListRequestPayload) {
  const { requestId, path: requestedPath, showHidden } = payload;

  try {
    const resolvedPath = resolveFileTransferListPath(
      requestedPath,
      () => readTmuxPaneCurrentPath(session.sessionName),
    );
    const entries = readdirSync(resolvedPath, { withFileTypes: true });
    const fileEntries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: number }> = [];

    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) {
        continue;
      }

      try {
        const stats = statSync(join(resolvedPath, entry.name));
        fileEntries.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isDirectory() ? 0 : stats.size,
          modified: stats.mtimeMs,
        });
      } catch {
        // Skip entries we can't stat
      }
    }

    fileEntries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parentPath = resolvedPath === '/' ? null : resolve(resolvedPath, '..');

    sendMessage(session, {
      type: 'file-list-response',
      payload: { requestId, path: resolvedPath, parentPath, entries: fileEntries },
    });
  } catch (error) {
    sendMessage(session, {
      type: 'file-list-error',
      payload: { requestId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function handleFileDownloadRequest(session: ClientSession, payload: FileDownloadRequestPayload) {
  const { requestId, remotePath, fileName } = payload;

  try {
    if (!existsSync(remotePath)) {
      sendMessage(session, { type: 'file-download-error', payload: { requestId, error: 'File not found' } });
      return;
    }

    const fileBuffer = readFileSync(remotePath);
    sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
  } catch (error) {
    sendMessage(session, {
      type: 'file-download-error',
      payload: { requestId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function sendFileDownloadBuffer(session: ClientSession, requestId: string, fileName: string, fileBuffer: Buffer) {
  const totalChunks = Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE);
  let index = 0;

  function sendNextChunk() {
    if (index >= totalChunks) {
      sendMessage(session, {
        type: 'file-download-complete',
        payload: { requestId, fileName, totalBytes: fileBuffer.length },
      });
      return;
    }
    const start = index * FILE_CHUNK_SIZE;
    const end = Math.min(start + FILE_CHUNK_SIZE, fileBuffer.length);
    const chunk = fileBuffer.subarray(start, end);
    sendMessage(session, {
      type: 'file-download-chunk',
      payload: {
        requestId,
        chunkIndex: index,
        totalChunks,
        fileName,
        dataBase64: chunk.toString('base64'),
      },
    });
    index += 1;
    setImmediate(sendNextChunk);
  }

  sendNextChunk();
}

function buildRemoteScreenshotFileName() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `remote-screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

async function handleRemoteScreenshotRequest(session: ClientSession, payload: RemoteScreenshotRequestPayload) {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  if (!requestId) {
    sendMessage(session, {
      type: 'file-download-error',
      payload: { requestId: '', error: 'remote-screenshot-request missing requestId' },
    });
    return;
  }

  if (process.platform !== 'darwin') {
    sendMessage(session, {
      type: 'file-download-error',
      payload: { requestId, error: `Remote screenshot unsupported on platform: ${process.platform}` },
    });
    return;
  }

  const fileName = buildRemoteScreenshotFileName();
  const tempPath = join(getWtermHomeDir(), fileName);

  sendMessage(session, {
    type: 'remote-screenshot-status',
    payload: { requestId, phase: 'capturing', fileName },
  });

  mkdirSync(getWtermHomeDir(), { recursive: true });

  try {
    const captureResult = await requestRemoteScreenshotViaHelper({
      outputPath: tempPath,
      timeoutMs: REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
    });
    const fileBuffer = readFileSync(captureResult.outputPath);
    sendMessage(session, {
      type: 'remote-screenshot-status',
      payload: {
        requestId,
        phase: 'transferring',
        fileName,
        receivedChunks: 0,
        totalChunks: Math.max(1, Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE)),
        totalBytes: fileBuffer.length,
      },
    });
    sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
  } catch (error) {
    sendMessage(session, {
      type: 'file-download-error',
      payload: {
        requestId,
        error: resolveRemoteScreenshotErrorMessage(error, REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS),
      },
    });
  } finally {
    cleanup();
  }

  function cleanup() {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup failure
    }
  }
}

const pendingUploads = new Map<string, {
  targetDir: string;
  fileName: string;
  fileSize: number;
  chunks: Map<number, Buffer>;
  totalChunks: number;
  receivedChunks: number;
}>();

function handleFileUploadStart(session: ClientSession, payload: FileUploadStartPayload) {
  const { requestId, targetDir, fileName, fileSize, chunkCount } = payload;

  mkdirSync(targetDir, { recursive: true });

  pendingUploads.set(requestId, {
    targetDir,
    fileName,
    fileSize,
    chunks: new Map(),
    totalChunks: chunkCount,
    receivedChunks: 0,
  });

  sendMessage(session, {
    type: 'file-upload-progress',
    payload: { requestId, chunkIndex: 0, totalChunks: chunkCount },
  });
}

function handleFileUploadChunk(session: ClientSession, payload: FileUploadChunkPayload) {
  const { requestId, chunkIndex, dataBase64 } = payload;
  const upload = pendingUploads.get(requestId);

  if (!upload) {
    sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
    return;
  }

  upload.chunks.set(chunkIndex, Buffer.from(dataBase64, 'base64'));
  upload.receivedChunks++;

  sendMessage(session, {
    type: 'file-upload-progress',
    payload: { requestId, chunkIndex: upload.receivedChunks, totalChunks: upload.totalChunks },
  });
}

function handleFileUploadEnd(session: ClientSession, payload: FileUploadEndPayload) {
  const { requestId } = payload;
  const upload = pendingUploads.get(requestId);

  if (!upload) {
    sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
    return;
  }

  try {
    const sortedChunks: Buffer[] = [];
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunk = upload.chunks.get(i);
      if (!chunk) {
        throw new Error('Missing chunk ' + i);
      }
      sortedChunks.push(chunk);
    }

    const filePath = join(upload.targetDir, upload.fileName);
    const fileBuffer = Buffer.concat(sortedChunks);
    writeFileSync(filePath, fileBuffer);

    sendMessage(session, {
      type: 'file-upload-complete',
      payload: { requestId, filePath, bytes: fileBuffer.length },
    });
  } catch (error) {
    sendMessage(session, {
      type: 'file-upload-error',
      payload: { requestId, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    pendingUploads.delete(requestId);
  }
}

function handleAttachFileBinary(session: ClientSession, buffer: Buffer) {
  const pending = session.pendingAttachFile;
  session.pendingAttachFile = null;

  if (!pending) {
    sendMessage(session, { type: 'error', payload: { message: 'No pending attach-file when binary arrived', code: 'attach_file_no_pending' } });
    return;
  }

  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    sendMessage(session, { type: 'error', payload: { message: 'Session is not ready for file attach', code: 'session_not_ready' } });
    return;
  }

  try {
    const downloadDir = join(homedir(), 'Downloads', 'zterm');
    mkdirSync(downloadDir, { recursive: true });

    const targetPath = join(downloadDir, pending.name);
    writeFileSync(targetPath, buffer);

    mirror.ptyProcess.write(targetPath);
    mirror.ptyProcess.write('\r');

    sendMessage(session, {
      type: 'file-attached',
      payload: {
        name: pending.name,
        path: targetPath,
        bytes: buffer.length,
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    sendMessage(session, { type: 'error', payload: { message: `Failed to attach file: ${err}`, code: 'attach_file_failed' } });
  }
}

function handlePasteImageBinary(session: ClientSession, buffer: Buffer) {
  const pending = session.pendingPasteImage;
  session.pendingPasteImage = null;

  if (!pending) {
    handleInput(session, buffer.toString('utf-8'));
    return;
  }

  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    sendMessage(session, { type: 'error', payload: { message: 'Session is not ready for image paste', code: 'session_not_ready' } });
    return;
  }

  try {
    const { sourcePath, pngPath, bytes } = persistClipboardImageBuffer(
      {
        name: pending.name,
        mimeType: pending.mimeType,
      },
      buffer,
    );
    const pasteSequence = pending.pasteSequence || '\x16';
    mirror.ptyProcess.write(pasteSequence);
    sendMessage(session, {
      type: 'image-pasted',
      payload: {
        name: pending.name,
        mimeType: pending.mimeType,
        bytes,
      },
    });
    try {
      unlinkSync(sourcePath);
    } catch (error) {
      logCleanupFailure('paste-image-binary', sourcePath, error);
    }
    try {
      unlinkSync(pngPath);
    } catch (error) {
      logCleanupFailure('paste-image-binary', pngPath, error);
    }
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    sendMessage(session, { type: 'error', payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' } });
  }
}

async function handleMessage(connection: TransportConnection, rawData: RawData, isBinary = false) {
  const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
  if (isBinary) {
    if (!session) {
      sendTransportMessage(connection.transport, {
        type: 'error',
        payload: { message: 'Binary payload requires an attached session transport', code: 'binary_requires_session' },
      });
      return;
    }
    const binaryBuffer = Buffer.isBuffer(rawData)
      ? rawData
      : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData as ArrayBuffer);
    if (session.pendingAttachFile) {
      handleAttachFileBinary(session, binaryBuffer);
    } else {
      handlePasteImageBinary(session, binaryBuffer);
    }
    return;
  }

  const text = typeof rawData === 'string'
    ? rawData
    : Buffer.isBuffer(rawData)
      ? rawData.toString('utf-8')
      : Array.isArray(rawData)
        ? Buffer.concat(rawData).toString('utf-8')
        : Buffer.from(rawData as ArrayBuffer).toString('utf-8');

  let message: ClientMessage;
  try {
    message = JSON.parse(text) as ClientMessage;
  } catch (_parseError) {
    if (!session) {
      sendTransportMessage(connection.transport, {
        type: 'error',
        payload: { message: 'Plain text input requires an attached session transport', code: 'input_requires_session' },
      });
      return;
    }
    handleInput(session, text);
    return;
  }

  switch (message.type) {
    case 'session-open':
      try {
        handleSessionOpen(connection, message.payload);
      } catch (error) {
        sendTransportMessage(connection.transport, {
          type: 'session-open-failed',
          payload: {
            clientSessionId: message.payload?.clientSessionId || '',
            message: error instanceof Error ? error.message : 'Invalid session-open payload',
            code: 'session_open_invalid',
          },
        });
      }
      break;
    case 'list-sessions':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'list-sessions requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      try {
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to list tmux sessions: ${err}`, code: 'list_sessions_failed' } });
      }
      break;
    case 'schedule-list':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'schedule-list requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      sendScheduleStateToSession(session, sanitizeSessionName(message.payload.sessionName || session.sessionName));
      break;
    case 'schedule-upsert':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'schedule-upsert requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      try {
        const normalized = normalizeScheduleDraft(
          {
            ...message.payload.job,
            targetSessionName: sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName),
          },
          {
            now: new Date(),
            existing: message.payload.job.id
              ? scheduleEngine.listBySession(sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName)).find((job) => job.id === message.payload.job.id) || null
              : null,
          },
        );
        if (!normalized.targetSessionName) {
          sendMessage(session, { type: 'error', payload: { message: 'Missing target session', code: 'schedule_invalid_target' } });
          break;
        }
        scheduleEngine.upsert({
          ...message.payload.job,
          targetSessionName: normalized.targetSessionName,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to save schedule: ${err}`, code: 'schedule_upsert_failed' } });
      }
      break;
    case 'schedule-delete':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'schedule-delete requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      scheduleEngine.delete(message.payload.jobId);
      break;
    case 'schedule-toggle':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'schedule-toggle requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled));
      break;
    case 'schedule-run-now':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'schedule-run-now requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      void scheduleEngine.runNow(message.payload.jobId);
      break;
    case 'connect':
      try {
        const logicalSession = handleSessionTransportConnect(connection, message.payload);
        if (logicalSession) {
          void attachTmux(logicalSession, message.payload);
        }
      } catch (error) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: {
            message: error instanceof Error ? error.message : 'Invalid connect payload',
            code: 'connect_payload_invalid',
          },
        });
      }
      break;
    case 'buffer-head-request': {
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'buffer-head-request requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      const mirror = getClientMirror(session);
      if (!mirror || mirror.state !== 'connected') {
        break;
      }
      sendBufferHeadToSession(session, mirror);
      break;
    }
    case 'paste-image-start':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'paste-image-start requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      session.pendingPasteImage = message.payload;
      break;
    case 'attach-file-start':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'attach-file-start requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      session.pendingAttachFile = message.payload;
      break;
    case 'buffer-sync-request': {
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'buffer-sync-request requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      const mirror = getClientMirror(session);
      if (!mirror || mirror.state !== 'connected') {
        break;
      }
      let request: BufferSyncRequestPayload;
      try {
        request = normalizeBufferSyncRequestPayload(session, message.payload);
      } catch (error) {
        sendMessage(session, {
          type: 'error',
          payload: {
            message: error instanceof Error ? error.message : 'Invalid buffer-sync-request',
            code: 'buffer_sync_request_invalid',
          },
        });
        break;
      }
      const payload = buildRequestedRangeBufferPayload(mirror, request);
      sendMessage(session, { type: 'buffer-sync', payload });
      break;
    }
    case 'debug-log':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'debug-log requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleClientDebugLog(session, message.payload);
      break;
    case 'tmux-create-session':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'tmux-create-session requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      try {
        createDetachedTmuxSession(message.payload.sessionName);
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to create tmux session: ${err}`, code: 'tmux_create_failed' } });
      }
      break;
    case 'tmux-rename-session':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'tmux-rename-session requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      try {
        const currentName = sanitizeSessionName(message.payload.sessionName);
        const nextName = renameTmuxSession(message.payload.sessionName, message.payload.nextSessionName);
        const currentKey = getMirrorKey(currentName);
        const nextKey = getMirrorKey(nextName);
        scheduleEngine.renameSession(currentName, nextName);
        const mirror = mirrors.get(currentKey);
        if (mirror && currentKey !== nextKey) {
          mirrors.delete(currentKey);
          mirror.key = nextKey;
          mirror.sessionName = nextKey;
          mirror.title = nextKey;
          mirrors.set(nextKey, mirror);
          for (const sessionId of mirror.subscribers) {
            const client = sessions.get(sessionId);
            if (!client) {
              continue;
            }
            client.mirrorKey = nextKey;
            client.sessionName = nextKey;
            client.title = nextKey;
            sendMessage(client, { type: 'title', payload: nextKey });
          }
        }
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to rename tmux session: ${err}`, code: 'tmux_rename_failed' } });
      }
      break;
    case 'tmux-kill-session':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'tmux-kill-session requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      try {
        // Hard rule: user tmux session kill is explicit-only.
        // Close tab / split / pane recycle / runtime cleanup must never flow into this path.
        const sessionName = sanitizeSessionName(message.payload.sessionName);
        runTmux(['kill-session', '-t', sessionName]);
        scheduleEngine.markSessionMissing(sessionName, 'session killed');
        const mirror = mirrors.get(getMirrorKey(sessionName));
        if (mirror) {
          destroyMirror(mirror, 'tmux session killed');
        }
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to kill tmux session: ${err}`, code: 'tmux_kill_failed' } });
      }
      break;
    case 'input':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'input requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleInput(session, message.payload);
      break;
    case 'paste-image':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'paste-image requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handlePasteImage(session, message.payload);
      break;
    case 'resize':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'resize requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      void handleResize(session, message.payload.cols, message.payload.rows);
      break;
    case 'terminal-width-mode':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'terminal-width-mode requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      void handleTerminalWidthMode(session, message.payload.mode, message.payload.cols);
      break;
    case 'ping': {
      sendTransportMessage(connection.transport, { type: 'pong' });
      break;
    }
    case 'close':
      if (!session) {
        connection.closeTransport('client requested close');
        break;
      }
      closeLogicalClientSession(session, 'client requested close', false);
      break;
    case 'file-list-request':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'file-list-request requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleFileListRequest(session, message.payload);
      break;
    case 'file-download-request':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'file-download-request requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleFileDownloadRequest(session, message.payload);
      break;
    case 'remote-screenshot-request':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'remote-screenshot-request requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      void handleRemoteScreenshotRequest(session, message.payload);
      break;
    case 'file-upload-start':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'file-upload-start requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleFileUploadStart(session, message.payload);
      break;
    case 'file-upload-chunk':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'file-upload-chunk requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleFileUploadChunk(session, message.payload);
      break;
    case 'file-upload-end':
      if (!session) {
        sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: 'file-upload-end requires an attached session transport', code: 'session_required' },
        });
        break;
      }
      handleFileUploadEnd(session, message.payload);
      break;
  }
}

const server = createServer(handleHttpRequest);

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 256,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});

const rtcBridgeServer = createRtcBridgeServer({
  onTransportOpen: (transport) => {
    const connection = createTransportConnection(createRtcSessionTransport(transport), transport.requestOrigin);
    console.log(`[${new Date().toISOString()}] rtc transport ${connection.id} created`);
    return {
      onMessage: (_transportId, data, isBinary) => {
        connection.wsAlive = true;
        const boundSession = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
        if (boundSession) {
          boundSession.wsAlive = true;
        }
        void handleMessage(connection, data, isBinary);
      },
      onClose: (_transportId, reason) => {
        console.log(`[${new Date().toISOString()}] rtc transport ${connection.id} closed: ${reason}`);
        const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
        if (session?.logicalSessionBound) {
          detachClientSessionTransportOnly(session, reason, connection.transportId);
        }
        connections.delete(connection.id);
      },
      onError: (_transportId, message) => {
        console.error(`[${new Date().toISOString()}] rtc transport ${connection.id} error: ${message}`);
        const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
        if (session?.logicalSessionBound) {
          detachClientSessionTransportOnly(session, `rtc error: ${message}`, connection.transportId);
        }
        connections.delete(connection.id);
      },
    };
  },
});

const relayHostClient = createTraversalRelayHostClient({
  config: DAEMON_CONFIG.relay,
  handleRelaySignal: async (peerId, message, emitSignal) => {
    await rtcBridgeServer.handleRelaySignal(peerId, 'relay-host', message as SignalMessage, emitSignal);
  },
  closeRelayPeer: (peerId, reason) => {
    rtcBridgeServer.closeRelayPeer(peerId, reason);
  },
});

function extractAuthToken(rawUrl?: string) {
  try {
    const url = new URL(rawUrl || '/', 'ws://localhost');
    return url.searchParams.get('token')?.trim() || '';
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] failed to parse websocket auth token from "${rawUrl || ''}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return '';
  }
}

wss.on('connection', (ws: WebSocket, request) => {
  const providedToken = extractAuthToken(request.url);
  if (REQUIRED_AUTH_TOKEN && providedToken !== REQUIRED_AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Unauthorized bridge token', code: 'unauthorized' } }));
    ws.close(4001, 'unauthorized');
    console.warn(`[${new Date().toISOString()}] unauthorized websocket from ${request.socket.remoteAddress || 'unknown'}`);
    return;
  }

  const connection = createTransportConnection(createWebSocketSessionTransport(ws), resolveRequestOrigin(request));
  console.log(`[${new Date().toISOString()}] websocket transport ${connection.id} created`);

  ws.on('pong', () => {
    connection.wsAlive = true;
    const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
    if (session) {
      session.wsAlive = true;
    }
  });

  ws.on('message', (rawData, isBinary) => {
    connection.wsAlive = true;
    const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
    if (session) {
      session.wsAlive = true;
    }
    void handleMessage(connection, rawData, isBinary);
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] websocket transport ${connection.id} closed`);
    const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
    if (session?.logicalSessionBound) {
      detachClientSessionTransportOnly(session, 'websocket closed', connection.transportId);
    }
    connections.delete(connection.id);
  });

  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] websocket transport ${connection.id} error: ${error.message}`);
    const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
    if (session?.logicalSessionBound) {
      detachClientSessionTransportOnly(session, `websocket error: ${error.message}`, connection.transportId);
    }
    connections.delete(connection.id);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const connection of connections.values()) {
    if (connection.transport.kind !== 'ws' || connection.transport.readyState !== WebSocket.OPEN) {
      continue;
    }

    if (!connection.wsAlive) {
      console.warn(`[${new Date().toISOString()}] transport ${connection.id} heartbeat timeout`);
      connection.transport.close('heartbeat timeout');
      continue;
    }

    connection.wsAlive = false;
    const session = connection.boundSessionId ? sessions.get(connection.boundSessionId) || null : null;
    if (session) {
      session.wsAlive = false;
    }
    try {
      connection.transport.ping?.();
    } catch (error) {
      console.warn(
        `[${new Date().toISOString()}] transport ${connection.id} heartbeat ping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      connection.transport.close('heartbeat ping failed');
    }
  }
}, WS_HEARTBEAT_INTERVAL_MS);

heartbeatTimer.unref?.();

let shutdownInFlight = false;

function shutdownDaemon(reason: string, exitCode = 0) {
  if (shutdownInFlight) {
    return;
  }
  shutdownInFlight = true;

  console.log(`[${new Date().toISOString()}] daemon shutdown start: ${reason}`);
  clearInterval(heartbeatTimer);
  clearInterval(memoryGuardTimer);
  scheduleEngine.dispose();
  relayHostClient.dispose();
  for (const connection of connections.values()) {
    try {
      connection.closeTransport(reason);
    } catch (error) {
      console.warn(
        `[${new Date().toISOString()}] failed to close transport ${connection.id} during daemon shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  connections.clear();
  shutdownClientSessions(sessions, reason);

  for (const mirror of [...mirrors.values()]) {
    destroyMirror(mirror, reason, true);
  }

  const finalize = () => {
    process.exit(exitCode);
  };

  try {
    wss.close();
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] websocket server close failed:`, error);
  }

  server.close((error) => {
    if (error) {
      console.warn(`[${new Date().toISOString()}] http server close failed: ${error.message}`);
    }
    finalize();
  });

  setTimeout(finalize, 1500).unref?.();
}

const memoryGuardTimer = setInterval(() => {
  const usage = process.memoryUsage();
  if (usage.rss < MEMORY_GUARD_MAX_RSS_BYTES && usage.heapUsed < MEMORY_GUARD_MAX_HEAP_USED_BYTES) {
    return;
  }

  console.error(
    `[${new Date().toISOString()}] daemon memory guard tripped: rss=${usage.rss} heapUsed=${usage.heapUsed} sessions=${sessions.size} mirrors=${mirrors.size}`,
  );
  shutdownDaemon('memory guard', 70);
}, MEMORY_GUARD_INTERVAL_MS);

memoryGuardTimer.unref?.();

wss.on('close', () => {
  clearInterval(heartbeatTimer);
  clearInterval(memoryGuardTimer);
  scheduleEngine.dispose();
  relayHostClient.dispose();
  rtcBridgeServer.dispose();
});

server.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `[${new Date().toISOString()}] daemon listen conflict on ${HOST}:${PORT}; another process is already bound to this port`,
    );
    shutdownDaemon('listen conflict', STARTUP_PORT_CONFLICT_EXIT_CODE);
    return;
  }

  console.error(
    `[${new Date().toISOString()}] daemon server error: ${error instanceof Error ? error.message : String(error)}`,
  );
  shutdownDaemon('server error', 1);
});

server.on('upgrade', (request, socket, head) => {
  const origin = resolveRequestOrigin(request);
  const pathname = new URL(request.url || '/', origin).pathname;

  if (pathname === '/signal') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const providedToken = extractAuthToken(request.url);
      if (REQUIRED_AUTH_TOKEN && providedToken !== REQUIRED_AUTH_TOKEN) {
        ws.send(JSON.stringify({ type: 'rtc-error', payload: { message: 'Unauthorized bridge token' } }));
        ws.close(4001, 'unauthorized');
        return;
      }
      rtcBridgeServer.handleSignalConnection(ws, origin);
    });
    return;
  }

  if (pathname !== '/' && pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, HOST, () => {
  relayHostClient.start();
  console.log(`[${new Date().toISOString()}] zterm tmux bridge listening on ws://${HOST}:${PORT}`);
  console.log(`  - health: http://${HOST}:${PORT}/health`);
  console.log(`  - rtc signal: ws://${HOST}:${PORT}/signal${REQUIRED_AUTH_TOKEN ? '?token=<auth>' : ''}`);
  console.log(`  - runtime debug snapshot: http://${HOST}:${PORT}/debug/runtime${REQUIRED_AUTH_TOKEN ? '?token=<auth>' : ''}`);
  console.log(`  - runtime debug logs: http://${HOST}:${PORT}/debug/runtime/logs${REQUIRED_AUTH_TOKEN ? '?token=<auth>&limit=200' : '?limit=200'}`);
  console.log(`  - runtime debug control: http://${HOST}:${PORT}/debug/runtime/control${REQUIRED_AUTH_TOKEN ? '?token=<auth>&enabled=1' : '?enabled=1'}`);
  console.log(`  - updates manifest: http://${HOST}:${PORT}/updates/latest.json`);
  console.log(`  - updates dir: ${UPDATES_DIR}`);
  console.log(`  - tmux binary: ${TMUX_BINARY}`);
  console.log(`  - default session: ${DEFAULT_SESSION_NAME}`);
  console.log(`  - active logs: ${LOG_DIR}`);
  console.log(`  - auth: ${REQUIRED_AUTH_TOKEN ? `enabled (${DAEMON_CONFIG.authSource})` : 'disabled'}`);
  console.log(`  - config: ${DAEMON_CONFIG.configFound ? WTERM_CONFIG_DISPLAY_PATH : `${WTERM_CONFIG_DISPLAY_PATH} (not found)`}`);
  console.log(`  - terminal cache lines: ${MAX_CAPTURED_SCROLLBACK_LINES}`);
  console.log(`  - traversal relay: ${DAEMON_CONFIG.relay ? `${DAEMON_CONFIG.relay.relayUrl} (host=${DAEMON_CONFIG.relay.hostId})` : 'disabled'}`);
});

process.on('SIGINT', () => shutdownDaemon('SIGINT', 0));
process.on('SIGTERM', () => shutdownDaemon('SIGTERM', 0));
process.on('SIGHUP', () => shutdownDaemon('SIGHUP', 0));
