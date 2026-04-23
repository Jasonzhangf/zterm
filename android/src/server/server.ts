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
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { basename, extname, join, resolve } from 'path';
import { homedir } from 'os';
import type {
  BufferSyncRequestPayload,
  PasteImagePayload,
  PasteImageStartPayload,
  RuntimeDebugLogEntry,
  ScheduleEventPayload,
  ScheduleJobDraft,
  ScheduleStatePayload,
  TerminalBufferPayload,
  TerminalCell,
  TerminalIndexedLine,
} from '../lib/types';
import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  resolveTerminalCacheLines,
  WTERM_CONFIG_DISPLAY_PATH,
} from '../lib/mobile-config';
import { getWtermHomeDir, getWtermUpdatesDir, resolveDaemonRuntimeConfig } from './daemon-config';
import {
  advanceKnownLocalWindowRange,
  findChangedIndexedRange,
  normalizeCapturedLineBlock,
  paintCursorIntoViewport,
  resolveCanonicalAvailableLineCount,
  resolveFollowTailSyncPlan,
  resolveReadingWindow,
  sliceIndexedLines,
  trimTrailingDefaultCells,
  trimCanonicalBufferWindow,
} from './canonical-buffer';
import { dispatchScheduledJob } from './schedule-dispatch';
import { ScheduleEngine } from './schedule-engine';
import { loadScheduleStore, saveScheduleStore } from './schedule-store';

interface TmuxConnectPayload {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  cols?: number;
  rows?: number;
  autoCommand?: string;
}

interface ClientSession {
  id: string;
  ws: WebSocket;
  requestOrigin: string;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
  streamMode: 'active' | 'idle';
  title: string;
  sessionName: string;
  mirrorKey: string | null;
  cols: number;
  rows: number;
  wsAlive: boolean;
  lastBufferSyncRequest: BufferSyncRequestPayload | null;
  pendingPasteImage: PasteImageStartPayload | null;
}

interface SessionMirror {
  key: string;
  sessionName: string;
  ptyProcess: pty.IPty | null;
  observerProcess: pty.IPty | null;
  observerLineBuffer: string;
  scratchBridge: WasmBridge | null;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
  title: string;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
  lastDeltaFromRevision: number;
  lastDeltaToRevision: number;
  lastDeltaRange: { startIndex: number; endIndex: number } | null;
  lastScrollbackCount: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  lastOutputAt: number;
  lastFlushCompletedAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: boolean;
  flushRequestedWhileBusy: boolean;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  orphanedAt: number | null;
  subscribers: Set<string>;
}

interface TmuxPaneMetrics {
  paneId: string;
  historySize: number;
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

type ClientMessage =
  | { type: 'connect'; payload: TmuxConnectPayload }
  | { type: 'stream-mode'; payload: { mode: 'active' | 'idle' } }
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
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'ping' }
  | { type: 'close' };

type ServerMessage =
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
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'buffer-sync'; payload: TerminalBufferPayload }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
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
const ACTIVE_STREAM_INTERVAL_MS = 16;
const MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
const WTERM_HOME_DIR = getWtermHomeDir(homedir());
const UPDATES_DIR = getWtermUpdatesDir(homedir());
const UPLOAD_DIR = join(WTERM_HOME_DIR, 'uploads');
const LOG_DIR = join(WTERM_HOME_DIR, 'logs');
const APP_UPDATE_VERSION_CODE = Number.parseInt(process.env.ZTERM_APP_UPDATE_VERSION_CODE || '', 10);
const APP_UPDATE_VERSION_NAME = (process.env.ZTERM_APP_UPDATE_VERSION_NAME || '').trim();
const APP_UPDATE_MANIFEST_URL = (process.env.ZTERM_APP_UPDATE_MANIFEST_URL || '').trim();
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const MIRROR_RECONCILE_POLL_MS = 500;
const FALLBACK_RECONCILE_MIN_INTERVAL_MS = 2000;
const STARTUP_PORT_CONFLICT_EXIT_CODE = 78;
const ORPHAN_MIRROR_TTL_MS = 2 * 60 * 1000;
const DAEMON_RUNTIME_DEBUG = process.env.ZTERM_DAEMON_DEBUG_LOG === '1';
const MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES = 8;
const MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS = 900;
const MEMORY_GUARD_INTERVAL_MS = 30_000;
const MEMORY_GUARD_MAX_RSS_BYTES = 2.5 * 1024 * 1024 * 1024;
const MEMORY_GUARD_MAX_HEAP_USED_BYTES = 1.5 * 1024 * 1024 * 1024;

const sessions = new Map<string, ClientSession>();
const mirrors = new Map<string, SessionMirror>();
const scheduleStore = loadScheduleStore();

function resolveMirrorCacheLines(rows: number) {
  const viewportRows = Math.max(1, Math.floor(rows || 1));
  if (!Number.isFinite(MAX_CAPTURED_SCROLLBACK_LINES) || MAX_CAPTURED_SCROLLBACK_LINES <= 0) {
    return viewportRows;
  }
  return Math.max(viewportRows, Math.floor(MAX_CAPTURED_SCROLLBACK_LINES));
}

function resolveWireFollowCacheLines(rows: number) {
  return Math.max(1, resolveTerminalCacheLines(rows));
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
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    viewportEndIndex: payload.viewportEndIndex,
    rows: payload.rows,
    cols: payload.cols,
    lineCount: payload.lines.length,
    firstLineIndex: payload.lines[0]?.index ?? null,
    lastLineIndex: payload.lines[payload.lines.length - 1]?.index ?? null,
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

function normalizeViewportCols(cols: number | undefined) {
  return Math.max(1, Math.floor(cols || 80));
}

function normalizeViewportRows(rows: number | undefined) {
  return Math.max(1, Math.floor(rows || 24));
}

function sendMessage(session: ClientSession, message: ServerMessage) {
  if (session.ws.readyState === WebSocket.OPEN) {
    if (message.type === 'buffer-sync' || message.type === 'connected') {
      daemonRuntimeDebug('send', {
        sessionId: session.id,
        sessionName: session.sessionName,
        type: message.type,
        payload: summarizePayload(message),
      });
    }
    session.ws.send(JSON.stringify(message));
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
  scheduleMirrorFlush(mirror);
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
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
      orphaned: mirrorEntries.filter((mirror) => mirror.subscribers.size === 0).length,
      subscribers: mirrorEntries.reduce((sum, mirror) => sum + mirror.subscribers.size, 0),
    },
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
  const fallback = `upload-${Date.now()}`;
  const candidate = (input || fallback).trim() || fallback;
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
  } catch {
    return 0;
  }
}

function resolveRequestedTmuxRows(contentRows: number) {
  const safeContentRows = Math.max(1, Math.floor(contentRows));
  return safeContentRows + readTmuxStatusLineCount();
}

function readTmuxPaneMetrics(sessionName: string): TmuxPaneMetrics {
  const result = runTmux(['display-message', '-p', '-t', sessionName, '#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}']);
  const [paneIdRaw = '', historyRaw = '0', rowsRaw = '24', colsRaw = '80', alternateOnRaw = '0'] = result.stdout.trim().split('\t');
  return {
    paneId: paneIdRaw.trim() || sessionName,
    historySize: Math.max(0, Number.parseInt(historyRaw, 10) || 0),
    paneRows: Math.max(1, Number.parseInt(rowsRaw, 10) || 24),
    paneCols: Math.max(1, Number.parseInt(colsRaw, 10) || 80),
    alternateOn: alternateOnRaw === '1',
  };
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

function captureTmuxPaneLines(
  target: string,
  options: {
    paneRows: number;
    maxLines: number;
    alternateOn: boolean;
  },
) {
  const safePaneRows = Math.max(1, Math.floor(options.paneRows));
  const safeMaxLines = Math.max(1, Math.floor(options.maxLines));
  const viewportResult = runTmux([
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
  ]);

  const viewportLines = normalizeCapturedLineBlock(viewportResult.stdout, safePaneRows);
  if (options.alternateOn) {
    return {
      historyLines: [] as string[],
      viewportLines,
    };
  }

  const historyResult = runTmux([
    'capture-pane',
    '-p',
    '-e',
    '-N',
    '-t',
    target,
    '-S',
    `-${safeMaxLines}`,
    '-E',
    '-1',
  ]);
  const historyCapturedLines = normalizeCapturedLineBlock(historyResult.stdout);
  const historyLineCount = Math.max(0, Math.min(historyCapturedLines.length, safeMaxLines - safePaneRows));

  return {
    historyLines: historyLineCount > 0 ? historyCapturedLines.slice(0, historyLineCount) : [],
    viewportLines,
  };
}

async function captureMirrorAuthoritativeBufferFromTmux(mirror: SessionMirror) {
  const metrics = readTmuxPaneMetrics(mirror.sessionName);
  const cursor = readTmuxCursorState(metrics.paneId);
  const maxLines = resolveMirrorCacheLines(metrics.paneRows);
  const captured = captureTmuxPaneLines(metrics.paneId, {
    paneRows: metrics.paneRows,
    maxLines,
    alternateOn: metrics.alternateOn,
  });
  const capturedLines = [...captured.historyLines, ...captured.viewportLines];

  const scratchBridge = mirror.scratchBridge ?? await WasmBridge.load();
  mirror.scratchBridge = scratchBridge;
  scratchBridge.init(metrics.paneCols, metrics.paneRows);
  if (capturedLines.length > 0) {
    scratchBridge.writeString(capturedLines.join('\r\n'));
  }

  const viewport = paintCursorIntoViewport(
    buildViewport(scratchBridge),
    Math.max(0, Math.min(metrics.paneRows - 1, cursor.row)),
    cursor.col,
    cursor.visible,
  ).map(trimTrailingDefaultCells);
  const scratchScrollbackCount = scratchBridge.getScrollbackCount();
  const scrollbackKeepCount = Math.max(0, Math.min(scratchScrollbackCount, maxLines - viewport.length));
  const scrollbackStartOldestIndex = Math.max(0, scratchScrollbackCount - scrollbackKeepCount);
  const scrollbackTail =
    scrollbackKeepCount > 0
      ? readScrollbackRangeByOldestIndex(scratchBridge, scrollbackStartOldestIndex, scratchScrollbackCount)
      : [];

  const totalAvailableLines = resolveCanonicalAvailableLineCount({
    paneRows: metrics.paneRows,
    historySize: metrics.historySize,
    capturedLineCount: capturedLines.length,
    scratchLineCount: scratchScrollbackCount + viewport.length,
  });
  const nextBufferLines = [...scrollbackTail, ...viewport];
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
  const viewportTopIndex = Math.max(mirror.bufferStartIndex, availableEndIndex - mirror.rows);

  console.log(
    `[${new Date().toISOString()}] [mirror:${mirror.sessionName}] tmux capture sync history=${metrics.historySize} captured=${capturedLines.length} viewportCaptured=${captured.viewportLines.length} scratch=${scratchScrollbackCount + viewport.length} total=${totalAvailableLines} rows=${metrics.paneRows} cols=${metrics.paneCols} buffer=${mirror.bufferStartIndex}-${availableEndIndex} viewport=${viewportTopIndex}-${availableEndIndex}`,
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

function killTmuxSession(input?: string) {
  const sessionName = sanitizeSessionName(input);
  runTmux(['kill-session', '-t', sessionName]);
  return sessionName;
}

function clearMirrorFlushTimer(mirror: SessionMirror) {
  if (mirror.flushTimer) {
    clearTimeout(mirror.flushTimer);
    mirror.flushTimer = null;
  }
}

function clearMirrorDestroyTimer(mirror: SessionMirror) {
  if (mirror.destroyTimer) {
    clearTimeout(mirror.destroyTimer);
    mirror.destroyTimer = null;
  }
}

function scheduleMirrorDestroyIfOrphaned(mirror: SessionMirror, reason: string) {
  if (mirror.state === 'closed' || mirror.subscribers.size > 0) {
    clearMirrorDestroyTimer(mirror);
    mirror.orphanedAt = mirror.subscribers.size > 0 ? null : mirror.orphanedAt;
    return;
  }

  mirror.orphanedAt = Date.now();
  clearMirrorDestroyTimer(mirror);
  mirror.destroyTimer = setTimeout(() => {
    mirror.destroyTimer = null;
    if (mirror.state === 'closed' || mirror.subscribers.size > 0) {
      if (mirror.subscribers.size > 0) {
        mirror.orphanedAt = null;
      }
      return;
    }
    destroyMirror(mirror, reason, false);
  }, ORPHAN_MIRROR_TTL_MS);
  mirror.destroyTimer.unref?.();
}

function createClientSession(ws: WebSocket, requestOrigin: string): ClientSession {
  const session: ClientSession = {
    id: uuidv4(),
    ws,
    requestOrigin,
    state: 'idle',
    streamMode: 'idle',
    title: 'Terminal',
    sessionName: DEFAULT_SESSION_NAME,
    mirrorKey: null,
    cols: 80,
    rows: 24,
    wsAlive: true,
    lastBufferSyncRequest: null,
    pendingPasteImage: null,
  };
  sessions.set(session.id, session);
  return session;
}

function normalizeBufferSyncRequestPayload(
  session: ClientSession,
  request: BufferSyncRequestPayload,
): BufferSyncRequestPayload {
  const localStartIndex = Math.max(0, Math.floor(request.localStartIndex || 0));
  const mirror = getClientMirror(session);
  const fallbackRows = mirror?.rows || session.rows || 24;
  const fallbackEndIndex = mirror ? getMirrorAvailableEndIndex(mirror) : 0;

  return {
    knownRevision: Math.max(0, Math.floor(request.knownRevision || 0)),
    localStartIndex,
    localEndIndex: Math.max(localStartIndex, Math.floor(request.localEndIndex || localStartIndex)),
    viewportEndIndex: Math.max(0, Math.floor(request.viewportEndIndex || fallbackEndIndex)),
    viewportRows: Math.max(1, Math.floor(request.viewportRows || fallbackRows)),
    mode: request.mode === 'reading' ? 'reading' : 'follow',
  };
}

function createMirror(sessionName: string): SessionMirror {
  const key = getMirrorKey(sessionName);
  const mirror: SessionMirror = {
    key,
    sessionName: key,
    ptyProcess: null,
    observerProcess: null,
    observerLineBuffer: '',
    scratchBridge: null,
    state: 'idle',
    title: key,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    revision: 0,
    lastDeltaFromRevision: 0,
    lastDeltaToRevision: 0,
    lastDeltaRange: null,
    lastScrollbackCount: -1,
    bufferStartIndex: 0,
    bufferLines: [],
    lastOutputAt: 0,
    lastFlushCompletedAt: 0,
    flushTimer: null,
    flushInFlight: false,
    flushRequestedWhileBusy: false,
    destroyTimer: null,
    orphanedAt: null,
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

function detachClientSession(session: ClientSession, reason: string, notifyClient = false) {
  if (session.state === 'closed') {
    return;
  }

  const mirror = getClientMirror(session);
  if (mirror) {
    mirror.subscribers.delete(session.id);
    if (mirror.subscribers.size > 0) {
      void reconcileMirrorGeometry(mirror).catch((error) => {
        console.error(
          `[${new Date().toISOString()}] failed to reconcile mirror geometry after detach for ${mirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    scheduleMirrorDestroyIfOrphaned(mirror, 'orphaned mirror reaped after client disconnect');
  }

  session.mirrorKey = null;
  session.state = 'closed';

  if (notifyClient) {
    sendMessage(session, { type: 'closed', payload: { reason } });
  }

  sessions.delete(session.id);
}

function destroyMirror(mirror: SessionMirror, reason: string, notifyClients = true) {
  if (mirror.state === 'closed') {
    return;
  }

  mirror.state = 'closed';
  clearMirrorFlushTimer(mirror);
  clearMirrorDestroyTimer(mirror);

  if (mirror.ptyProcess) {
    try {
      mirror.ptyProcess.kill();
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Failed to kill pty for mirror ${mirror.key}:`, error);
    }
    mirror.ptyProcess = null;
  }

  if (mirror.observerProcess) {
    try {
      mirror.observerProcess.kill();
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Failed to kill control observer for mirror ${mirror.key}:`, error);
    }
    mirror.observerProcess = null;
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

  mirror.subscribers.clear();
  mirror.scratchBridge = null;
  mirror.observerLineBuffer = '';
  mirror.bufferLines = [];
  mirror.bufferStartIndex = 0;
  mirror.lastDeltaFromRevision = 0;
  mirror.lastDeltaToRevision = 0;
  mirror.lastDeltaRange = null;
  mirror.lastScrollbackCount = -1;
  mirror.orphanedAt = null;
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

function buildViewport(bridge: WasmBridge) {
  const rows = bridge.getRows();
  const cols = bridge.getCols();
  const viewport: TerminalCell[][] = [];

  for (let row = 0; row < rows; row += 1) {
    const cells: TerminalCell[] = [];
    for (let col = 0; col < cols; col += 1) {
      cells.push(serializeCell(bridge.getCell(row, col)));
    }
    viewport.push(cells);
  }

  return viewport;
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
  fallback: { cols: number; rows: number } = { cols: mirror.cols, rows: mirror.rows },
) {
  let minCols = Number.POSITIVE_INFINITY;
  let minRows = Number.POSITIVE_INFINITY;

  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state === 'closed') {
      continue;
    }
    minCols = Math.min(minCols, normalizeViewportCols(session.cols));
    minRows = Math.min(minRows, normalizeViewportRows(session.rows));
  }

  if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) {
    return {
      cols: normalizeViewportCols(fallback.cols),
      rows: normalizeViewportRows(fallback.rows),
    };
  }

  return {
    cols: normalizeViewportCols(minCols),
    rows: normalizeViewportRows(minRows),
  };
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

function countActiveSubscribers(mirror: SessionMirror) {
  let activeCount = 0;
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (session?.state === 'connected' && session.streamMode === 'active') {
      activeCount += 1;
    }
  }
  return activeCount;
}

function buildBufferPayload(
  mirror: SessionMirror,
  lines: TerminalIndexedLine[],
): TerminalBufferPayload | null {
  const viewportEndIndex = getMirrorAvailableEndIndex(mirror);

  return {
    revision: mirror.revision,
    startIndex: mirror.bufferStartIndex,
    endIndex: getMirrorAvailableEndIndex(mirror),
    viewportEndIndex,
    cols: mirror.cols,
    rows: mirror.rows,
    cursorKeysApp: mirror.cursorKeysApp,
    lines: lines.map((line) => ({ index: line.index, cells: line.cells })),
  };
}

function buildFullBufferSyncPayload(mirror: SessionMirror): TerminalBufferPayload | null {
  return buildBufferPayload(
    mirror,
    sliceIndexedLines(
      mirror.bufferStartIndex,
      mirror.bufferLines,
      mirror.bufferStartIndex,
      getMirrorAvailableEndIndex(mirror),
    ),
  );
}

function resolveTailWindow(
  mirror: SessionMirror,
  viewportRows: number,
) {
  const bufferEndIndex = getMirrorAvailableEndIndex(mirror);
  const cacheLines = resolveWireFollowCacheLines(viewportRows);
  return {
    startIndex: Math.max(mirror.bufferStartIndex, bufferEndIndex - cacheLines),
    endIndex: bufferEndIndex,
    viewportEndIndex: bufferEndIndex,
  };
}

function buildTailWindowBufferSyncPayload(
  mirror: SessionMirror,
  viewportRows: number,
) {
  const tailWindow = resolveTailWindow(mirror, viewportRows);
  return buildSparseWindowBufferSyncPayload(mirror, tailWindow, [
    {
      startIndex: tailWindow.startIndex,
      endIndex: tailWindow.endIndex,
    },
  ]);
}

function mirrorBufferChanged(
  mirror: SessionMirror,
  previousStartIndex: number,
  previousLines: TerminalCell[][],
) {
  return findChangedIndexedRange({
    previousStartIndex,
    previousLines,
    nextStartIndex: mirror.bufferStartIndex,
    nextLines: mirror.bufferLines,
  });
}

function normalizeRequestedMissingRanges(
  missingRanges: BufferSyncRequestPayload['missingRanges'],
  startIndex: number,
  endIndex: number,
) {
  if (!Array.isArray(missingRanges) || endIndex <= startIndex) {
    return [] as Array<{ startIndex: number; endIndex: number }>;
  }
  return missingRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.startIndex || 0))),
      endIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.endIndex || 0))),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

function buildMissingRangeBufferSyncPayload(
  mirror: SessionMirror,
  window: { startIndex: number; endIndex: number; viewportEndIndex: number },
  missingRanges: Array<{ startIndex: number; endIndex: number }>,
) {
  if (missingRanges.length === 0 || window.endIndex <= window.startIndex) {
    return null;
  }
  const indexedLines = missingRanges.flatMap((range) => sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    range.startIndex,
    range.endIndex,
  ));
  const payload = buildBufferPayload(mirror, indexedLines);
  if (!payload) {
    return null;
  }
  payload.startIndex = window.startIndex;
  payload.endIndex = window.endIndex;
  payload.viewportEndIndex = Math.max(window.startIndex, Math.floor(window.viewportEndIndex));
  return payload;
}

function buildSparseWindowBufferSyncPayload(
  mirror: SessionMirror,
  window: { startIndex: number; endIndex: number; viewportEndIndex: number },
  lineRanges: Array<{ startIndex: number; endIndex: number }>,
) {
  if (lineRanges.length === 0 || window.endIndex <= window.startIndex) {
    return null;
  }

  const indexedLines = lineRanges.flatMap((range) => sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    range.startIndex,
    range.endIndex,
  ));
  const payload = buildBufferPayload(mirror, indexedLines);
  if (!payload) {
    return null;
  }

  payload.startIndex = window.startIndex;
  payload.endIndex = window.endIndex;
  payload.viewportEndIndex = Math.max(window.startIndex, Math.floor(window.viewportEndIndex));
  return payload;
}

function collectReadingMissingRanges(options: {
  request: BufferSyncRequestPayload;
  desiredStartIndex: number;
  desiredEndIndex: number;
  deltaRange: { startIndex: number; endIndex: number } | null;
  currentRevision: number;
  lastDeltaFromRevision: number;
  lastDeltaToRevision: number;
}) {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  const localStartIndex = Math.max(0, Math.floor(options.request.localStartIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(options.request.localEndIndex || localStartIndex));

  if (options.desiredStartIndex < localStartIndex) {
    ranges.push({
      startIndex: options.desiredStartIndex,
      endIndex: Math.min(options.desiredEndIndex, localStartIndex),
    });
  }
  if (options.desiredEndIndex > localEndIndex) {
    ranges.push({
      startIndex: Math.max(options.desiredStartIndex, localEndIndex),
      endIndex: options.desiredEndIndex,
    });
  }

  const knownRevision = Math.max(0, Math.floor(options.request.knownRevision || 0));
  const safeCurrentRevision = Math.max(0, Math.floor(options.currentRevision || 0));
  const safeDeltaFromRevision = Math.max(0, Math.floor(options.lastDeltaFromRevision || 0));
  const safeDeltaToRevision = Math.max(0, Math.floor(options.lastDeltaToRevision || 0));
  if (
    options.deltaRange
    && knownRevision < safeCurrentRevision
    && knownRevision === safeDeltaFromRevision
    && safeCurrentRevision === safeDeltaToRevision
  ) {
    const startIndex = Math.max(options.desiredStartIndex, Math.floor(options.deltaRange.startIndex || 0));
    const endIndex = Math.min(options.desiredEndIndex, Math.floor(options.deltaRange.endIndex || 0));
    if (endIndex > startIndex) {
      ranges.push({ startIndex, endIndex });
    }
  }

  ranges.sort((a, b) => a.startIndex - b.startIndex);
  const merged: Array<{ startIndex: number; endIndex: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.startIndex > last.endIndex) {
      merged.push({ ...range });
      continue;
    }
    last.endIndex = Math.max(last.endIndex, range.endIndex);
  }
  return merged.filter((range) => range.endIndex > range.startIndex);
}

function buildClientRequestedBufferPayload(
  mirror: SessionMirror,
  request: BufferSyncRequestPayload,
) {
  const knownRevision = Math.max(0, Math.floor(request.knownRevision || 0));
  if (knownRevision >= mirror.revision) {
    return null;
  }

  const mirrorStartIndex = mirror.bufferStartIndex;
  const mirrorEndIndex = getMirrorAvailableEndIndex(mirror);
  if (mirrorEndIndex <= mirrorStartIndex) {
    return buildFullBufferSyncPayload(mirror);
  }

  const localStartIndex = Math.max(0, Math.floor(request.localStartIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(request.localEndIndex || localStartIndex));
  const viewportRows = Math.max(1, Math.floor(request.viewportRows || mirror.rows || 1));
  const mode = request.mode === 'reading' ? 'reading' : 'follow';
  const requestedViewportEndIndex = mode === 'follow'
    ? mirrorEndIndex
    : Math.max(
        mirrorStartIndex,
        Math.min(mirrorEndIndex, Math.floor(request.viewportEndIndex || mirrorEndIndex)),
      );
  if (mode === 'reading') {
    const readingWindow = resolveReadingWindow({
      bufferStartIndex: mirrorStartIndex,
      bufferEndIndex: mirrorEndIndex,
      viewportEndIndex: requestedViewportEndIndex,
      viewportRows,
      cacheLines: resolveWireFollowCacheLines(viewportRows),
    });
    const viewportStartIndex = Math.max(mirrorStartIndex, requestedViewportEndIndex - viewportRows);
    if (request.prefetch) {
      const preloadRows = Math.max(viewportRows * 2, 48);
      const readingWindowStartIndex = Math.max(mirrorStartIndex, viewportStartIndex - preloadRows);
      const readingWindowEndIndex = Math.max(readingWindowStartIndex, requestedViewportEndIndex);
      const missingRanges = normalizeRequestedMissingRanges(
        request.missingRanges,
        readingWindowStartIndex,
        readingWindowEndIndex,
      );

      if (missingRanges.length > 0) {
        return buildMissingRangeBufferSyncPayload(mirror, {
          startIndex: readingWindowStartIndex,
          endIndex: readingWindowEndIndex,
          viewportEndIndex: requestedViewportEndIndex,
        }, missingRanges);
      }

      return null;
    }

    const readingMissingRanges = collectReadingMissingRanges({
      request,
      desiredStartIndex: readingWindow.startIndex,
      desiredEndIndex: readingWindow.endIndex,
      deltaRange: mirror.lastDeltaRange,
      currentRevision: mirror.revision,
      lastDeltaFromRevision: mirror.lastDeltaFromRevision,
      lastDeltaToRevision: mirror.lastDeltaToRevision,
    });
    if (readingMissingRanges.length > 0) {
      return buildMissingRangeBufferSyncPayload(mirror, {
        startIndex: readingWindow.startIndex,
        endIndex: readingWindow.endIndex,
        viewportEndIndex: readingWindow.viewportEndIndex,
      }, readingMissingRanges);
    }

    return null;
  }

  const tailWindow = resolveTailWindow(mirror, viewportRows);
  const followPlan = resolveFollowTailSyncPlan({
    knownRevision,
    currentRevision: mirror.revision,
    lastDeltaFromRevision: mirror.lastDeltaFromRevision,
    lastDeltaToRevision: mirror.lastDeltaToRevision,
    lastDeltaRange: mirror.lastDeltaRange,
    bufferStartIndex: tailWindow.startIndex,
    bufferEndIndex: tailWindow.endIndex,
    localStartIndex,
    localEndIndex,
    viewportRows,
    cacheLines: resolveWireFollowCacheLines(viewportRows),
  });
  if (!followPlan) {
    return null;
  }

  return buildSparseWindowBufferSyncPayload(mirror, {
    startIndex: followPlan.windowStartIndex,
    endIndex: followPlan.windowEndIndex,
    viewportEndIndex: tailWindow.viewportEndIndex,
  }, followPlan.ranges);
}

function buildLiveBufferPayloadForSession(session: ClientSession, mirror: SessionMirror) {
  if (session.streamMode !== 'active') {
    return null;
  }
  const request = session.lastBufferSyncRequest;
  if (request) {
    if (request.mode === 'reading') {
      return buildClientRequestedBufferPayload(mirror, request);
    }
    return buildClientRequestedBufferPayload(mirror, request)
      || buildTailWindowBufferSyncPayload(mirror, request.viewportRows || session.rows || mirror.rows);
  }
  return buildTailWindowBufferSyncPayload(mirror, session.rows || mirror.rows);
}

function advanceSessionBufferSyncRequest(
  session: ClientSession,
  payload: TerminalBufferPayload,
) {
  if (!session.lastBufferSyncRequest) {
    return;
  }

  const nextLocalWindow = advanceKnownLocalWindowRange({
    localStartIndex: session.lastBufferSyncRequest.localStartIndex,
    localEndIndex: session.lastBufferSyncRequest.localEndIndex,
    payloadStartIndex: Math.max(0, Math.floor(payload.startIndex || 0)),
    payloadEndIndex: Math.max(
      Math.max(0, Math.floor(payload.startIndex || 0)),
      Math.floor(payload.endIndex || 0),
    ),
  });

  session.lastBufferSyncRequest = {
    ...session.lastBufferSyncRequest,
    knownRevision: Math.max(0, Math.floor(payload.revision || 0)),
    localStartIndex: nextLocalWindow.startIndex,
    localEndIndex: nextLocalWindow.endIndex,
    viewportEndIndex:
      session.lastBufferSyncRequest.mode === 'follow'
        ? Math.max(0, Math.floor(payload.viewportEndIndex || session.lastBufferSyncRequest.viewportEndIndex))
        : session.lastBufferSyncRequest.viewportEndIndex,
  };
}

function pushMirrorBufferSyncToSubscribers(mirror: SessionMirror) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state === 'closed') {
      continue;
    }

    const payload = buildLiveBufferPayloadForSession(session, mirror);
    if (!payload) {
      continue;
    }

    sendMessage(session, { type: 'buffer-sync', payload });
    advanceSessionBufferSyncRequest(session, payload);
  }
}

function sendBufferSyncToClient(session: ClientSession, mirror: SessionMirror) {
  session.title = mirror.title;
  session.sessionName = mirror.sessionName;
  if (session.state !== 'connected') {
    session.state = 'connected';
    sendMessage(session, { type: 'connected', payload: buildConnectedPayload(session.id, session.requestOrigin) });
    sendScheduleStateToSession(session, mirror.sessionName);
  }
  sendMessage(session, { type: 'title', payload: mirror.title });
  if (session.streamMode !== 'active') {
    return;
  }
  const payload = buildTailWindowBufferSyncPayload(
    mirror,
    session.lastBufferSyncRequest?.viewportRows || session.rows || mirror.rows,
  );
  if (!payload) {
    return;
  }
  sendMessage(session, { type: 'buffer-sync', payload });
  advanceSessionBufferSyncRequest(session, payload);
}

function sendInitialBufferSyncToClient(session: ClientSession, mirror: SessionMirror) {
  sendBufferSyncToClient(session, mirror);
}

async function resizeConnectedMirror(mirror: SessionMirror, cols: number, rows: number) {
  if (mirror.state !== 'connected' || !mirror.ptyProcess) {
    return;
  }

  const tmuxRows = resolveRequestedTmuxRows(rows);
  mirror.cols = cols;
  mirror.rows = rows;
  mirror.ptyProcess.resize(cols, tmuxRows);
  mirror.lastScrollbackCount = -1;
  mirror.bufferLines = [];
  mirror.bufferStartIndex = 0;
  clearMirrorFlushTimer(mirror);
  const captured = await captureMirrorAuthoritativeBufferFromTmux(mirror);
  if (!captured) {
    throw new Error('Failed to capture canonical tmux buffer after resize');
  }
  mirror.lastDeltaFromRevision = mirror.revision;
  mirror.revision += 1;
  mirror.lastDeltaToRevision = mirror.revision;
  mirror.lastDeltaRange = null;
  broadcastMirrorBufferReset(mirror);
}

async function reconcileMirrorGeometry(mirror: SessionMirror) {
  if (mirror.state !== 'connected' || !mirror.ptyProcess) {
    return false;
  }

  const target = resolveMirrorTargetGeometry(mirror);
  if (
    target.cols === mirror.cols
    && target.rows === mirror.rows
  ) {
    return false;
  }

  await resizeConnectedMirror(mirror, target.cols, target.rows);
  return true;
}

function broadcastMirrorBufferReset(mirror: SessionMirror) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }
    sendInitialBufferSyncToClient(session, mirror);
  }
}

function flushMirrorUpdates(mirror: SessionMirror) {
  mirror.flushTimer = null;

  if (mirror.state !== 'connected') {
    return;
  }

  mirror.flushInFlight = true;
  mirror.flushRequestedWhileBusy = false;
  const previousStartIndex = mirror.bufferStartIndex;
  const previousLines = mirror.bufferLines.slice();

  void captureMirrorAuthoritativeBufferFromTmux(mirror)
    .then((captured) => {
      if (!captured) {
        throw new Error('tmux capture returned no canonical buffer');
      }

      const changedRange = mirrorBufferChanged(mirror, previousStartIndex, previousLines);
      if (changedRange) {
        mirror.lastDeltaFromRevision = mirror.revision;
        mirror.lastDeltaToRevision = mirror.revision + 1;
        mirror.lastDeltaRange = changedRange;
        mirror.revision += 1;
        pushMirrorBufferSyncToSubscribers(mirror);
      } else {
        mirror.lastDeltaRange = null;
      }
    })
    .catch((error) => {
      console.error(
        `[${new Date().toISOString()}] canonical mirror refresh failed for ${mirror.sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      mirror.lastFlushCompletedAt = Date.now();
      mirror.flushInFlight = false;
      if (mirror.flushRequestedWhileBusy) {
        mirror.flushRequestedWhileBusy = false;
        scheduleMirrorFlush(mirror);
      }
    });
}

function scheduleMirrorFlush(mirror: SessionMirror) {
  if (mirror.state !== 'connected') {
    return;
  }

  const activeSubscribers = countActiveSubscribers(mirror);
  if (activeSubscribers <= 0) {
    clearMirrorFlushTimer(mirror);
    return;
  }

  if (mirror.flushInFlight) {
    mirror.flushRequestedWhileBusy = true;
    return;
  }

  if (mirror.flushTimer) {
    return;
  }

  mirror.flushTimer = setTimeout(() => flushMirrorUpdates(mirror), ACTIVE_STREAM_INTERVAL_MS);
}

function handleTmuxControlNotification(mirror: SessionMirror, line: string) {
  if (!line.startsWith('%')) {
    return;
  }

  if (line.startsWith('%session-renamed ')) {
    const nextTitle = line.slice('%session-renamed '.length).trim();
    if (nextTitle) {
      mirror.title = nextTitle;
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (session && session.state !== 'closed') {
          session.title = nextTitle;
          sendMessage(session, { type: 'title', payload: nextTitle });
        }
      }
    }
  }

  if (
    line.startsWith('%output ')
    || line.startsWith('%extended-output ')
    || line.startsWith('%layout-change ')
    || line.startsWith('%session-window-changed ')
    || line.startsWith('%session-changed ')
    || line.startsWith('%client-session-changed ')
    || line.startsWith('%pane-mode-changed ')
    || line.startsWith('%continue ')
    || line.startsWith('%pause ')
  ) {
    mirror.lastOutputAt = Date.now();
    scheduleMirrorFlush(mirror);
  }
}

function handleTmuxObserverData(mirror: SessionMirror, data: string) {
  mirror.observerLineBuffer += data;
  const lines = mirror.observerLineBuffer.split('\n');
  mirror.observerLineBuffer = lines.pop() || '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (!line) {
      continue;
    }
    handleTmuxControlNotification(mirror, line);
  }
}

function startMirrorObserver(mirror: SessionMirror, cols: number, rows: number) {
  if (mirror.observerProcess) {
    return;
  }

  const observerProcess = pty.spawn(TMUX_BINARY, ['-CC', 'attach-session', '-t', mirror.sessionName, '-f', 'ignore-size,read-only'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || '/',
    env: cleanEnv(),
  });

  mirror.observerProcess = observerProcess;
  mirror.observerLineBuffer = '';

  observerProcess.onData((data: string) => {
    handleTmuxObserverData(mirror, data);
  });

  observerProcess.onExit(({ exitCode, signal }) => {
    const reason = `tmux control observer exited (code=${exitCode}, signal=${signal ?? 'none'})`;
    if (mirror.state !== 'closed') {
      console.error(`[${new Date().toISOString()}] ${reason} for ${mirror.sessionName}`);
      destroyMirror(mirror, reason);
    }
  });
}

function shouldRunFallbackReconcile(mirror: SessionMirror) {
  if (countActiveSubscribers(mirror) <= 0) {
    return false;
  }

  const now = Date.now();
  if (mirror.lastFlushCompletedAt > 0 && now - mirror.lastFlushCompletedAt < FALLBACK_RECONCILE_MIN_INTERVAL_MS) {
    return false;
  }

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
  clearMirrorFlushTimer(mirror);
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

  try {
    startMirrorObserver(mirror, targetGeometry.cols, requestedTmuxRows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    destroyMirror(mirror, `failed to start tmux control observer: ${message}`);
    return;
  }

  ptyProcess.onData((data: string) => {
    void data;
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const reason = `pty exited (code=${exitCode}, signal=${signal ?? 'none'})`;
    destroyMirror(mirror, reason);
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const captured = await captureMirrorAuthoritativeBufferFromTmux(mirror);
    if (!captured) {
      throw new Error('Failed to capture canonical tmux buffer during initial sync');
    }
    mirror.revision += 1;
    broadcastMirrorBufferReset(mirror);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] initial buffer sync failed for ${mirror.sessionName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    try {
      mirror.lastScrollbackCount = -1;
      mirror.bufferLines = [];
      mirror.bufferStartIndex = 0;
      const captured = await captureMirrorAuthoritativeBufferFromTmux(mirror);
      if (!captured) {
        throw new Error('Failed to capture canonical tmux buffer during fallback sync');
      }
      mirror.revision += 1;
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        session.title = mirror.title;
        session.sessionName = mirror.sessionName;
        if (session.state !== 'connected') {
          session.state = 'connected';
          sendMessage(session, { type: 'connected', payload: buildConnectedPayload(session.id, session.requestOrigin) });
        }
        sendMessage(session, { type: 'title', payload: mirror.title });
        const fallbackPayload = buildBufferPayload(mirror, sliceIndexedLines(mirror.bufferStartIndex, mirror.bufferLines, mirror.bufferStartIndex, getMirrorAvailableEndIndex(mirror)));
        if (fallbackPayload) {
          fallbackPayload.revision = mirror.revision;
          sendMessage(session, { type: 'buffer-sync', payload: fallbackPayload });
        }
      }
    } catch (fallbackError) {
      console.error(
        `[${new Date().toISOString()}] fallback buffer sync failed for ${mirror.sessionName}: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      );
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
  const requestedCols =
    typeof payload.cols === 'number' && Number.isFinite(payload.cols) ? normalizeViewportCols(payload.cols) : normalizeViewportCols(session.cols);
  const requestedRows =
    typeof payload.rows === 'number' && Number.isFinite(payload.rows) ? normalizeViewportRows(payload.rows) : normalizeViewportRows(session.rows);

  const previousMirror = getClientMirror(session);
  if (previousMirror) {
    previousMirror.subscribers.delete(session.id);
    if (previousMirror.subscribers.size > 0) {
      void reconcileMirrorGeometry(previousMirror).catch((error) => {
        console.error(
          `[${new Date().toISOString()}] failed to reconcile mirror geometry after session switch for ${previousMirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    scheduleMirrorDestroyIfOrphaned(previousMirror, 'orphaned mirror reaped after session switch');
  }

  session.state = 'connecting';
  session.title = nextSessionName;
  session.sessionName = nextSessionName;
  session.mirrorKey = nextMirrorKey;
  session.cols = requestedCols;
  session.rows = requestedRows;

  let mirror = mirrors.get(nextMirrorKey);
  if (!mirror) {
    mirror = createMirror(nextSessionName);
  }
  mirror.subscribers.add(session.id);
  clearMirrorDestroyTimer(mirror);
  mirror.orphanedAt = null;
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
    sendInitialBufferSyncToClient(session, mirror);
    return;
  }

  await startMirror(mirror, payload.autoCommand);
}

async function handleResize(session: ClientSession, cols: number, rows: number) {
  session.cols = normalizeViewportCols(cols);
  session.rows = normalizeViewportRows(rows);
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess) {
    return;
  }
  await reconcileMirrorGeometry(mirror);
}

function handleInput(session: ClientSession, data: string) {
  const mirror = getClientMirror(session);
  if (mirror?.state === 'connected' && mirror.ptyProcess) {
    mirror.ptyProcess.write(data);
    scheduleMirrorFlush(mirror);
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
    scheduleMirrorFlush(mirror);
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
    } catch {}
    try {
      unlinkSync(pngPath);
    } catch {}
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    sendMessage(session, { type: 'error', payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' } });
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
    scheduleMirrorFlush(mirror);
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
    } catch {}
    try {
      unlinkSync(pngPath);
    } catch {}
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    sendMessage(session, { type: 'error', payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' } });
  }
}

function handleMessage(session: ClientSession, rawData: RawData, isBinary = false) {
  if (isBinary) {
    const binaryBuffer = Buffer.isBuffer(rawData)
      ? rawData
      : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData as ArrayBuffer);
    handlePasteImageBinary(session, binaryBuffer);
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
  } catch {
    handleInput(session, text);
    return;
  }

  switch (message.type) {
    case 'list-sessions':
      try {
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to list tmux sessions: ${err}`, code: 'list_sessions_failed' } });
      }
      break;
    case 'schedule-list':
      sendScheduleStateToSession(session, sanitizeSessionName(message.payload.sessionName || session.sessionName));
      break;
    case 'schedule-upsert':
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
      scheduleEngine.delete(message.payload.jobId);
      break;
    case 'schedule-toggle':
      scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled));
      break;
    case 'schedule-run-now':
      void scheduleEngine.runNow(message.payload.jobId);
      break;
    case 'connect':
      void attachTmux(session, message.payload);
      break;
    case 'stream-mode': {
      session.streamMode = message.payload.mode === 'active' ? 'active' : 'idle';
      const mirror = getClientMirror(session);
      if (mirror) {
        if (session.streamMode === 'active') {
          scheduleMirrorFlush(mirror);
        } else if (countActiveSubscribers(mirror) <= 0) {
          clearMirrorFlushTimer(mirror);
        }
      }
      break;
    }
    case 'paste-image-start':
      session.pendingPasteImage = message.payload;
      break;
    case 'buffer-sync-request': {
      const mirror = getClientMirror(session);
      if (!mirror || mirror.state !== 'connected') {
        break;
      }
      const request = normalizeBufferSyncRequestPayload(session, message.payload);
      session.lastBufferSyncRequest = request;
      const payload = buildClientRequestedBufferPayload(mirror, request);
      if (payload) {
        sendMessage(session, { type: 'buffer-sync', payload });
        advanceSessionBufferSyncRequest(session, payload);
      }
      break;
    }
    case 'debug-log':
      handleClientDebugLog(session, message.payload);
      break;
    case 'tmux-create-session':
      try {
        createDetachedTmuxSession(message.payload.sessionName);
        sendMessage(session, { type: 'sessions', payload: { sessions: listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendMessage(session, { type: 'error', payload: { message: `Failed to create tmux session: ${err}`, code: 'tmux_create_failed' } });
      }
      break;
    case 'tmux-rename-session':
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
      try {
        const sessionName = killTmuxSession(message.payload.sessionName);
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
      handleInput(session, message.payload);
      break;
    case 'paste-image':
      handlePasteImage(session, message.payload);
      break;
    case 'resize':
      void handleResize(session, message.payload.cols, message.payload.rows);
      break;
    case 'ping':
      sendMessage(session, { type: 'pong' });
      break;
    case 'close':
      detachClientSession(session, 'client requested close', false);
      try {
        session.ws.close(1000, 'client requested close');
      } catch {}
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

function extractAuthToken(rawUrl?: string) {
  try {
    const url = new URL(rawUrl || '/', 'ws://localhost');
    return url.searchParams.get('token')?.trim() || '';
  } catch {
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

  const session = createClientSession(ws, resolveRequestOrigin(request));
  console.log(`[${new Date().toISOString()}] client session ${session.id} created`);

  ws.on('pong', () => {
    session.wsAlive = true;
  });

  ws.on('message', (rawData, isBinary) => {
    session.wsAlive = true;
    handleMessage(session, rawData, isBinary);
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] client session ${session.id} websocket closed`);
    detachClientSession(session, 'websocket closed', false);
  });

  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] client session ${session.id} websocket error: ${error.message}`);
    detachClientSession(session, `websocket error: ${error.message}`, false);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const session of sessions.values()) {
    if (session.ws.readyState !== WebSocket.OPEN) {
      continue;
    }

    if (!session.wsAlive) {
      console.warn(`[${new Date().toISOString()}] client session ${session.id} heartbeat timeout`);
      session.ws.close(4000, 'heartbeat timeout');
      continue;
    }

    session.wsAlive = false;
    try {
      session.ws.ping();
    } catch (error) {
      console.warn(
        `[${new Date().toISOString()}] client session ${session.id} heartbeat ping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      session.ws.close(4000, 'heartbeat ping failed');
    }
  }
}, WS_HEARTBEAT_INTERVAL_MS);

heartbeatTimer.unref?.();

const mirrorReconcileTimer = setInterval(() => {
  for (const mirror of mirrors.values()) {
    if (mirror.state !== 'connected') {
      continue;
    }
    if (!shouldRunFallbackReconcile(mirror)) {
      continue;
    }
    scheduleMirrorFlush(mirror);
  }
}, MIRROR_RECONCILE_POLL_MS);

mirrorReconcileTimer.unref?.();

let shutdownInFlight = false;

function shutdownDaemon(reason: string, exitCode = 0) {
  if (shutdownInFlight) {
    return;
  }
  shutdownInFlight = true;

  console.log(`[${new Date().toISOString()}] daemon shutdown start: ${reason}`);
  clearInterval(heartbeatTimer);
  clearInterval(mirrorReconcileTimer);
  clearInterval(memoryGuardTimer);
  scheduleEngine.dispose();

  for (const session of sessions.values()) {
    try {
      if (session.ws.readyState < WebSocket.CLOSING) {
        session.ws.close(1001, reason);
      }
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] failed to close websocket for session ${session.id}:`, error);
    }
  }

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
  clearInterval(mirrorReconcileTimer);
  clearInterval(memoryGuardTimer);
  scheduleEngine.dispose();
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
  console.log(`[${new Date().toISOString()}] zterm tmux bridge listening on ws://${HOST}:${PORT}`);
  console.log(`  - health: http://${HOST}:${PORT}/health`);
  console.log(`  - updates manifest: http://${HOST}:${PORT}/updates/latest.json`);
  console.log(`  - updates dir: ${UPDATES_DIR}`);
  console.log(`  - tmux binary: ${TMUX_BINARY}`);
  console.log(`  - default session: ${DEFAULT_SESSION_NAME}`);
  console.log(`  - active logs: ${LOG_DIR}`);
  console.log(`  - auth: ${REQUIRED_AUTH_TOKEN ? `enabled (${DAEMON_CONFIG.authSource})` : 'disabled'}`);
  console.log(`  - config: ${DAEMON_CONFIG.configFound ? WTERM_CONFIG_DISPLAY_PATH : `${WTERM_CONFIG_DISPLAY_PATH} (not found)`}`);
  console.log(`  - terminal cache lines: ${MAX_CAPTURED_SCROLLBACK_LINES}`);
});

process.on('SIGINT', () => shutdownDaemon('SIGINT', 0));
process.on('SIGTERM', () => shutdownDaemon('SIGTERM', 0));
process.on('SIGHUP', () => shutdownDaemon('SIGHUP', 0));
