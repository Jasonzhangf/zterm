/**
 * zterm Android WebSocket 服务端
 *
 * 目标：tmux/daemon 作为 authoritative terminal truth，移动端只接收低带宽镜像。
 * 连接时先发“最后一屏 + 少量尾部历史”，随后后台渐进补更早历史；运行时仅发 viewport 增量和 scrollback 增量。
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
  PasteImagePayload,
  TerminalBufferPayload,
  TerminalCell,
  TerminalIndexedLine,
} from '../lib/types';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  WTERM_CONFIG_DISPLAY_PATH,
} from '../lib/mobile-config';
import { reconcileAbsoluteScrollbackRange } from '../lib/scrollback-buffer';
import { getWtermHomeDir, getWtermUpdatesDir, resolveDaemonRuntimeConfig } from './daemon-config';

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
  title: string;
  sessionName: string;
  mirrorKey: string | null;
  cols: number;
  rows: number;
  backfillCursor: number | null;
  backfillTimer: ReturnType<typeof setTimeout> | null;
  wsAlive: boolean;
  streamMode: 'active' | 'idle';
  idleDirty: boolean;
  idleSnapshotTimer: ReturnType<typeof setTimeout> | null;
}

interface SessionMirror {
  key: string;
  sessionName: string;
  ptyProcess: pty.IPty | null;
  bridge: WasmBridge | null;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
  title: string;
  cols: number;
  rows: number;
  revision: number;
  lastScrollbackCount: number;
  scrollbackBaseIndex: number;
  scrollbackNextIndex: number;
  capturedStartIndex: number;
  capturedScrollbackLines: TerminalCell[][];
  lastOutputAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<string>;
}

type ClientMessage =
  | { type: 'connect'; payload: TmuxConnectPayload }
  | { type: 'stream-mode'; payload: { mode: 'active' | 'idle' } }
  | { type: 'list-sessions' }
  | { type: 'tmux-create-session'; payload: { sessionName: string } }
  | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string } }
  | { type: 'tmux-kill-session'; payload: { sessionName: string } }
  | { type: 'input'; payload: string }
  | { type: 'paste-image'; payload: PasteImagePayload }
  | { type: 'request-buffer-range'; payload: { startIndex: number; endIndex: number } }
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
  | { type: 'buffer-delta'; payload: TerminalBufferPayload }
  | { type: 'buffer-range'; payload: TerminalBufferPayload }
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
const INITIAL_SCROLLBACK_TAIL_LINES = 100;
const SCROLLBACK_BACKFILL_CHUNK_LINES = 100;
const ACTIVE_STREAM_TURBO_INTERVAL_MS = 34;
const ACTIVE_STREAM_FAST_INTERVAL_MS = 42;
const ACTIVE_STREAM_BALANCED_INTERVAL_MS = 55;
const ACTIVE_STREAM_SLOW_INTERVAL_MS = 80;
const INACTIVE_STREAM_INTERVAL_MS = 320;
const IDLE_STREAM_INTERVAL_MS = 1200;
const BACKFILL_INTERVAL_MS = 260;
const IDLE_BEFORE_BACKFILL_MS = 250;
const MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
const WTERM_HOME_DIR = getWtermHomeDir(homedir());
const UPDATES_DIR = getWtermUpdatesDir(homedir());
const UPLOAD_DIR = join(WTERM_HOME_DIR, 'uploads');
const LOG_DIR = join(WTERM_HOME_DIR, 'logs');
const APP_UPDATE_VERSION_CODE = Number.parseInt(process.env.ZTERM_APP_UPDATE_VERSION_CODE || '', 10);
const APP_UPDATE_VERSION_NAME = (process.env.ZTERM_APP_UPDATE_VERSION_NAME || '').trim();
const APP_UPDATE_MANIFEST_URL = (process.env.ZTERM_APP_UPDATE_MANIFEST_URL || '').trim();
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const RECENT_OUTPUT_WINDOW_MS = 900;

const sessions = new Map<string, ClientSession>();
const mirrors = new Map<string, SessionMirror>();

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

function sendMessage(session: ClientSession, message: ServerMessage) {
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(message));
  }
}

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
    serveJson(response, {
      ok: true,
      wsUrl: `ws://${request.headers.host || `${HOST}:${PORT}`}`,
      updatesUrl: `${origin}/updates/latest.json`,
      updatesDir: UPDATES_DIR,
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

function persistClipboardImage(payload: PasteImagePayload) {
  ensureUploadDir();
  const safeName = sanitizeUploadFileName(payload.name || 'upload');
  const explicitExt = extname(safeName);
  const sourceExt = explicitExt || (payload.mimeType === 'image/jpeg' ? '.jpg' : payload.mimeType === 'image/png' ? '.png' : payload.mimeType === 'image/gif' ? '.gif' : '');
  const sourcePath = join(UPLOAD_DIR, `${safeName.replace(/\.[^.]+$/u, '')}-${Date.now()}${sourceExt}`);
  const buffer = Buffer.from(payload.dataBase64, 'base64');
  writeFileSync(sourcePath, buffer);
  const pngPath = normalizeImageToPng(sourcePath, safeName.replace(/\.[^.]+$/u, ''));
  writeImageToClipboard(pngPath);
  return { sourcePath, pngPath, bytes: buffer.byteLength };
}

function listTmuxSessions() {
  const result = runTmux(['list-sessions', '-F', '#S']);

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !HIDDEN_TMUX_SESSIONS.has(line));
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

function clearClientBackfillTimer(session: ClientSession) {
  if (session.backfillTimer) {
    clearTimeout(session.backfillTimer);
    session.backfillTimer = null;
  }
}

function clearMirrorFlushTimer(mirror: SessionMirror) {
  if (mirror.flushTimer) {
    clearTimeout(mirror.flushTimer);
    mirror.flushTimer = null;
  }
}

function createClientSession(ws: WebSocket, requestOrigin: string): ClientSession {
  const session: ClientSession = {
    id: uuidv4(),
    ws,
    requestOrigin,
    state: 'idle',
    title: 'Terminal',
    sessionName: DEFAULT_SESSION_NAME,
    mirrorKey: null,
    cols: 80,
    rows: 24,
    backfillCursor: null,
    backfillTimer: null,
    wsAlive: true,
    streamMode: 'active',
    idleDirty: false,
    idleSnapshotTimer: null,
  };
  sessions.set(session.id, session);
  return session;
}

function createMirror(sessionName: string): SessionMirror {
  const key = getMirrorKey(sessionName);
  const mirror: SessionMirror = {
    key,
    sessionName: key,
    ptyProcess: null,
    bridge: null,
    state: 'idle',
    title: key,
    cols: 80,
    rows: 24,
    revision: 0,
    lastScrollbackCount: -1,
    scrollbackBaseIndex: 0,
    scrollbackNextIndex: 0,
    capturedStartIndex: 0,
    capturedScrollbackLines: [],
    lastOutputAt: 0,
    flushTimer: null,
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

  clearClientBackfillTimer(session);
  clearIdleSnapshotTimer(session);
  const mirror = getClientMirror(session);
  if (mirror) {
    mirror.subscribers.delete(session.id);
  }

  session.mirrorKey = null;
  session.backfillCursor = null;
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
      clearClientBackfillTimer(client);
      clearIdleSnapshotTimer(client);
      client.mirrorKey = null;
      client.backfillCursor = null;
      client.state = 'closed';
      sendMessage(client, { type: 'closed', payload: { reason } });
    }
  }

  mirror.subscribers.clear();
  mirror.bridge = null;
  mirror.capturedScrollbackLines = [];
  mirror.capturedStartIndex = 0;
  mirror.lastScrollbackCount = -1;
  mirror.scrollbackBaseIndex = 0;
  mirror.scrollbackNextIndex = 0;
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
  return cells;
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

function refreshMirrorCapturedScrollback(mirror: SessionMirror) {
  const bridge = mirror.bridge;
  if (!bridge) {
    return;
  }

  const currentScrollbackCount = bridge.getScrollbackCount();
  const absoluteRange = reconcileAbsoluteScrollbackRange(
    {
      lastScrollbackCount: mirror.lastScrollbackCount,
      nextIndex: mirror.scrollbackNextIndex,
    },
    currentScrollbackCount,
  );

  const capturedCount = Math.min(MAX_CAPTURED_SCROLLBACK_LINES, currentScrollbackCount);
  const oldestStartIndex = Math.max(0, currentScrollbackCount - capturedCount);
  mirror.capturedScrollbackLines =
    capturedCount > 0
      ? readScrollbackRangeByOldestIndex(bridge, oldestStartIndex, currentScrollbackCount)
      : [];
  mirror.scrollbackBaseIndex = absoluteRange.startIndex;
  mirror.scrollbackNextIndex = absoluteRange.nextIndex;
  mirror.capturedStartIndex = Math.max(
    absoluteRange.startIndex,
    absoluteRange.nextIndex - mirror.capturedScrollbackLines.length,
  );
  mirror.lastScrollbackCount = currentScrollbackCount;
}

function toIndexedLines(startIndex: number, lines: TerminalCell[][]): TerminalIndexedLine[] {
  return lines.map((cells, offset) => ({
    index: startIndex + offset,
    cells,
  }));
}

function buildBufferPayload(
  mirror: SessionMirror,
  lines: TerminalIndexedLine[],
  startIndex: number,
  endIndex: number,
): TerminalBufferPayload | null {
  const bridge = mirror.bridge;
  if (!bridge) {
    return null;
  }

  const cursor = bridge.getCursor();
  const cols = bridge.getCols();
  const rows = bridge.getRows();
  const viewportStartIndex = mirror.scrollbackNextIndex;

  return {
    revision: mirror.revision,
    startIndex,
    endIndex,
    cols,
    rows,
    cursorRow: viewportStartIndex + cursor.row,
    cursorCol: cursor.col,
    cursorVisible: cursor.visible,
    cursorKeysApp: bridge.cursorKeysApp(),
    lines,
  };
}

function buildInitialBufferSyncPayload(session: ClientSession, mirror: SessionMirror): TerminalBufferPayload | null {
  const bridge = mirror.bridge;
  if (!bridge) {
    return null;
  }

  const viewport = buildViewport(bridge);
  const totalCaptured = mirror.capturedScrollbackLines.length;
  const tailCount = Math.min(totalCaptured, INITIAL_SCROLLBACK_TAIL_LINES);
  const tailLocalStart = totalCaptured - tailCount;
  const tailAbsoluteStart = mirror.capturedStartIndex + tailLocalStart;
  const indexedLines = [
    ...toIndexedLines(tailAbsoluteStart, mirror.capturedScrollbackLines.slice(tailLocalStart, totalCaptured)),
    ...toIndexedLines(mirror.scrollbackNextIndex, viewport),
  ];
  session.backfillCursor = tailAbsoluteStart;
  return buildBufferPayload(mirror, indexedLines, tailAbsoluteStart, mirror.scrollbackNextIndex + viewport.length);
}

function buildBackfillRangePayload(
  mirror: SessionMirror,
  startAbsolute: number,
  endAbsolute: number,
): TerminalBufferPayload | null {
  const bridge = mirror.bridge;
  if (!bridge) {
    return null;
  }

  const startOffset = Math.max(0, startAbsolute - mirror.capturedStartIndex);
  const endOffset = Math.max(startOffset, endAbsolute - mirror.capturedStartIndex);
  const indexedLines = toIndexedLines(startAbsolute, mirror.capturedScrollbackLines.slice(startOffset, endOffset));
  return buildBufferPayload(mirror, indexedLines, startAbsolute, mirror.scrollbackNextIndex + bridge.getRows());
}

function scheduleClientBackfill(session: ClientSession) {
  const mirror = getClientMirror(session);
  if (!mirror || !mirror.bridge || session.state !== 'connected' || session.backfillCursor === null) {
    return;
  }

  if (session.backfillTimer || session.backfillCursor <= mirror.capturedStartIndex) {
    return;
  }

  session.backfillTimer = setTimeout(() => {
    session.backfillTimer = null;
    const nextMirror = getClientMirror(session);
    if (!nextMirror || !nextMirror.bridge || session.state !== 'connected' || session.backfillCursor === null) {
      return;
    }

    if (Date.now() - nextMirror.lastOutputAt < IDLE_BEFORE_BACKFILL_MS) {
      scheduleClientBackfill(session);
      return;
    }

    const endAbsolute = session.backfillCursor;
    const startAbsolute = Math.max(nextMirror.capturedStartIndex, endAbsolute - SCROLLBACK_BACKFILL_CHUNK_LINES);
    session.backfillCursor = startAbsolute;

    const payload = buildBackfillRangePayload(nextMirror, startAbsolute, endAbsolute);
    if (payload && payload.lines.length > 0) {
      sendMessage(session, { type: 'buffer-range', payload });
    }

    if (session.backfillCursor > nextMirror.capturedStartIndex) {
      scheduleClientBackfill(session);
    }
  }, BACKFILL_INTERVAL_MS);
}

function clearIdleSnapshotTimer(session: ClientSession) {
  if (session.idleSnapshotTimer) {
    clearTimeout(session.idleSnapshotTimer);
    session.idleSnapshotTimer = null;
  }
}

function sendBufferSyncToClient(session: ClientSession, mirror: SessionMirror, scheduleBackfill: boolean) {
  const payload = buildInitialBufferSyncPayload(session, mirror);
  if (!payload) {
    return;
  }

  session.title = mirror.title;
  session.sessionName = mirror.sessionName;
  session.idleDirty = false;
  if (session.state !== 'connected') {
    session.state = 'connected';
    sendMessage(session, { type: 'connected', payload: buildConnectedPayload(session.id, session.requestOrigin) });
  }
  sendMessage(session, { type: 'title', payload: mirror.title });
  sendMessage(session, { type: 'buffer-sync', payload });

  if (scheduleBackfill) {
    scheduleClientBackfill(session);
  }
}

function scheduleIdleBufferSync(session: ClientSession) {
  if (session.streamMode !== 'idle' || session.idleSnapshotTimer || session.state !== 'connected') {
    return;
  }

  session.idleSnapshotTimer = setTimeout(() => {
    session.idleSnapshotTimer = null;
    if (session.streamMode !== 'idle' || !session.idleDirty || session.state !== 'connected') {
      return;
    }
    const nextMirror = getClientMirror(session);
    if (!nextMirror || !nextMirror.bridge || nextMirror.state !== 'connected') {
      return;
    }
    sendBufferSyncToClient(session, nextMirror, false);
  }, IDLE_STREAM_INTERVAL_MS);
}

function markIdleSessionDirty(session: ClientSession) {
  session.idleDirty = true;
  scheduleIdleBufferSync(session);
}

function sendInitialBufferSyncToClient(session: ClientSession, mirror: SessionMirror) {
  sendBufferSyncToClient(session, mirror, true);
}

function broadcastMirrorBufferReset(mirror: SessionMirror) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }
    clearClientBackfillTimer(session);
    sendInitialBufferSyncToClient(session, mirror);
  }
}

function broadcastMirrorBufferDelta(mirror: SessionMirror, payload: TerminalBufferPayload) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      continue;
    }
    if (session.streamMode === 'active') {
      sendMessage(session, { type: 'buffer-delta', payload });
    } else {
      markIdleSessionDirty(session);
    }
  }
}

function syncMirrorScrollbackAppend(
  mirror: SessionMirror,
  startIndex: number,
  lines: TerminalCell[][],
  currentScrollbackCount: number,
) {
  const expectedNextIndex = mirror.scrollbackNextIndex;
  if (startIndex !== expectedNextIndex) {
    return false;
  }

  mirror.capturedScrollbackLines.push(...lines);
  mirror.scrollbackNextIndex = startIndex + lines.length;
  mirror.scrollbackBaseIndex = Math.max(0, mirror.scrollbackNextIndex - Math.max(0, currentScrollbackCount));
  if (mirror.capturedScrollbackLines.length > MAX_CAPTURED_SCROLLBACK_LINES) {
    const trimCount = mirror.capturedScrollbackLines.length - MAX_CAPTURED_SCROLLBACK_LINES;
    mirror.capturedScrollbackLines.splice(0, trimCount);
    mirror.capturedStartIndex += trimCount;
    mirror.scrollbackBaseIndex += trimCount;
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || session.backfillCursor === null) {
        continue;
      }
      session.backfillCursor = Math.max(session.backfillCursor, mirror.capturedStartIndex);
    }
  }

  return true;
}

function flushMirrorUpdates(mirror: SessionMirror) {
  mirror.flushTimer = null;

  const bridge = mirror.bridge;
  if (!bridge || mirror.state !== 'connected') {
    return;
  }

  const currentScrollbackCount = bridge.getScrollbackCount();
  if (mirror.lastScrollbackCount < 0 || currentScrollbackCount < mirror.lastScrollbackCount) {
    refreshMirrorCapturedScrollback(mirror);
    bridge.clearDirty();
    mirror.revision += 1;
    broadcastMirrorBufferReset(mirror);
    return;
  }

  const appendedLines: TerminalIndexedLine[] = [];
  const newScrollbackLines = currentScrollbackCount - mirror.lastScrollbackCount;
  if (newScrollbackLines > 0) {
    const startIndex = mirror.scrollbackNextIndex;
    const appended = readScrollbackRangeByOldestIndex(
      bridge,
      currentScrollbackCount - newScrollbackLines,
      currentScrollbackCount,
    );
    if (appended.length > 0) {
      if (syncMirrorScrollbackAppend(mirror, startIndex, appended, currentScrollbackCount)) {
        appendedLines.push(...toIndexedLines(startIndex, appended));
      } else {
        refreshMirrorCapturedScrollback(mirror);
        bridge.clearDirty();
        mirror.revision += 1;
        broadcastMirrorBufferReset(mirror);
        return;
      }
    }
  }

  const viewportStartIndex = mirror.scrollbackNextIndex;
  const viewport = buildViewport(bridge);
  const deltaPayload = buildBufferPayload(
    mirror,
    [...appendedLines, ...toIndexedLines(viewportStartIndex, viewport)],
    mirror.capturedStartIndex,
    viewportStartIndex + viewport.length,
  );
  if (deltaPayload && deltaPayload.lines.length > 0) {
    mirror.revision += 1;
    deltaPayload.revision = mirror.revision;
    broadcastMirrorBufferDelta(mirror, deltaPayload);
  }

  mirror.lastScrollbackCount = currentScrollbackCount;
  bridge.clearDirty();
}

function computeMirrorFlushInterval(mirror: SessionMirror) {
  let activeSubscribers = 0;
  let maxBufferedAmount = 0;

  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'connected' || session.streamMode !== 'active') {
      continue;
    }

    activeSubscribers += 1;
    maxBufferedAmount = Math.max(maxBufferedAmount, session.ws.bufferedAmount || 0);
  }

  if (activeSubscribers === 0) {
    return INACTIVE_STREAM_INTERVAL_MS;
  }

  const outputIsHot = Date.now() - mirror.lastOutputAt <= RECENT_OUTPUT_WINDOW_MS;

  if (outputIsHot && activeSubscribers === 1 && maxBufferedAmount <= 4 * 1024) {
    return ACTIVE_STREAM_TURBO_INTERVAL_MS;
  }

  if (maxBufferedAmount <= 16 * 1024) {
    return ACTIVE_STREAM_FAST_INTERVAL_MS;
  }

  if (maxBufferedAmount <= 64 * 1024) {
    return ACTIVE_STREAM_BALANCED_INTERVAL_MS;
  }

  return ACTIVE_STREAM_SLOW_INTERVAL_MS;
}

function scheduleMirrorFlush(mirror: SessionMirror) {
  if (mirror.flushTimer || mirror.state !== 'connected') {
    return;
  }

  mirror.flushTimer = setTimeout(() => flushMirrorUpdates(mirror), computeMirrorFlushInterval(mirror));
}

async function startMirror(mirror: SessionMirror, autoCommand?: string) {
  if (mirror.state === 'connected' || mirror.state === 'connecting') {
    return;
  }

  mirror.state = 'connecting';
  mirror.title = mirror.sessionName;
  mirror.lastScrollbackCount = -1;
  mirror.capturedScrollbackLines = [];
  clearMirrorFlushTimer(mirror);

  try {
    mirror.bridge = await WasmBridge.load();
    mirror.bridge.init(mirror.cols, mirror.rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mirror.state = 'error';
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      session.state = 'error';
      sendMessage(session, { type: 'error', payload: { message: `Failed to initialize terminal mirror: ${message}`, code: 'mirror_init_failed' } });
    }
    return;
  }

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(TMUX_BINARY, ['new-session', '-A', '-s', mirror.sessionName], {
      name: 'xterm-256color',
      cols: mirror.cols,
      rows: mirror.rows,
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

  ptyProcess.onData((data: string) => {
    mirror.bridge?.writeString(data);
    mirror.lastOutputAt = Date.now();
    scheduleMirrorFlush(mirror);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const reason = `pty exited (code=${exitCode}, signal=${signal ?? 'none'})`;
    destroyMirror(mirror, reason);
  });

  try {
    refreshMirrorCapturedScrollback(mirror);
    mirror.bridge.clearDirty();
    mirror.revision += 1;
    broadcastMirrorBufferReset(mirror);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] initial buffer sync failed for ${mirror.sessionName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    try {
      const viewport = buildViewport(mirror.bridge);
      mirror.lastScrollbackCount = mirror.bridge.getScrollbackCount();
      mirror.scrollbackNextIndex = Math.max(mirror.scrollbackNextIndex, mirror.lastScrollbackCount);
      mirror.scrollbackBaseIndex = Math.max(0, mirror.scrollbackNextIndex - mirror.lastScrollbackCount);
      mirror.capturedStartIndex = mirror.scrollbackNextIndex;
      mirror.capturedScrollbackLines = [];
      mirror.bridge.clearDirty();
      mirror.revision += 1;
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        session.title = mirror.title;
        session.sessionName = mirror.sessionName;
        session.backfillCursor = mirror.scrollbackNextIndex;
        if (session.state !== 'connected') {
          session.state = 'connected';
          sendMessage(session, { type: 'connected', payload: buildConnectedPayload(session.id, session.requestOrigin) });
        }
        sendMessage(session, { type: 'title', payload: mirror.title });
        const fallbackPayload = buildBufferPayload(
          mirror,
          toIndexedLines(mirror.scrollbackNextIndex, viewport),
          mirror.scrollbackNextIndex,
          mirror.scrollbackNextIndex + viewport.length,
        );
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
  clearClientBackfillTimer(session);
  const nextSessionName = sanitizeSessionName(payload.sessionName || payload.name);
  const nextMirrorKey = getMirrorKey(nextSessionName);
  const requestedCols =
    typeof payload.cols === 'number' && Number.isFinite(payload.cols) ? Math.max(1, Math.floor(payload.cols)) : session.cols;
  const requestedRows =
    typeof payload.rows === 'number' && Number.isFinite(payload.rows) ? Math.max(1, Math.floor(payload.rows)) : session.rows;

  const previousMirror = getClientMirror(session);
  if (previousMirror) {
    previousMirror.subscribers.delete(session.id);
  }

  session.state = 'connecting';
  session.title = nextSessionName;
  session.sessionName = nextSessionName;
  session.mirrorKey = nextMirrorKey;
  session.backfillCursor = null;
  session.cols = requestedCols;
  session.rows = requestedRows;

  let mirror = mirrors.get(nextMirrorKey);
  if (!mirror) {
    mirror = createMirror(nextSessionName);
  }
  if (mirror.state !== 'connected') {
    mirror.cols = requestedCols;
    mirror.rows = requestedRows;
  }

  mirror.subscribers.add(session.id);
  sendMessage(session, { type: 'title', payload: mirror.title });

  if (mirror.state === 'connected' && mirror.bridge) {
    sendInitialBufferSyncToClient(session, mirror);
    return;
  }

  await startMirror(mirror, payload.autoCommand);
}

function handleResize(session: ClientSession, cols: number, rows: number) {
  session.cols = cols;
  session.rows = rows;
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.ptyProcess || !mirror.bridge) {
    return;
  }

  mirror.cols = cols;
  mirror.rows = rows;
  mirror.ptyProcess.resize(cols, rows);
  mirror.bridge.resize(cols, rows);
  mirror.lastScrollbackCount = -1;
  mirror.capturedScrollbackLines = [];
  clearMirrorFlushTimer(mirror);
  refreshMirrorCapturedScrollback(mirror);
  mirror.bridge.clearDirty();
  mirror.revision += 1;
  broadcastMirrorBufferReset(mirror);
}

function handleInput(session: ClientSession, data: string) {
  const mirror = getClientMirror(session);
  if (mirror?.state === 'connected' && mirror.ptyProcess) {
    mirror.ptyProcess.write(data);
  }
}

function handleStreamMode(session: ClientSession, mode: 'active' | 'idle') {
  session.streamMode = mode;
  if (mode === 'active') {
    clearIdleSnapshotTimer(session);
    session.idleDirty = false;
    const mirror = getClientMirror(session);
    if (mirror && mirror.bridge && mirror.state === 'connected') {
      clearClientBackfillTimer(session);
      sendBufferSyncToClient(session, mirror, true);
    }
    return;
  }

  clearClientBackfillTimer(session);
}

function handleBufferRangeRequest(session: ClientSession, startIndex: number, endIndex: number) {
  const mirror = getClientMirror(session);
  if (!mirror || mirror.state !== 'connected' || !mirror.bridge) {
    sendMessage(session, { type: 'error', payload: { message: 'Session is not ready for buffer sync', code: 'buffer_not_ready' } });
    return;
  }

  refreshMirrorCapturedScrollback(mirror);

  const normalizedStart = Math.max(0, Math.floor(startIndex));
  const normalizedEnd = Math.max(normalizedStart, Math.floor(endIndex));
  const availableStart = mirror.capturedStartIndex;
  const availableEnd = mirror.scrollbackNextIndex;
  const actualStart = Math.max(availableStart, normalizedStart);
  const actualEnd = Math.min(availableEnd, normalizedEnd);
  const payload = buildBackfillRangePayload(mirror, actualStart, actualEnd);
  if (payload) {
    sendMessage(session, { type: 'buffer-range', payload });
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

function handleMessage(session: ClientSession, rawData: RawData) {
  const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');

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
    case 'connect':
      void attachTmux(session, message.payload);
      break;
    case 'stream-mode':
      handleStreamMode(session, message.payload.mode);
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
    case 'request-buffer-range':
      handleBufferRangeRequest(session, message.payload.startIndex, message.payload.endIndex);
      break;
    case 'resize':
      handleResize(session, message.payload.cols, message.payload.rows);
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

  ws.on('message', (rawData) => {
    session.wsAlive = true;
    handleMessage(session, rawData);
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

wss.on('close', () => {
  clearInterval(heartbeatTimer);
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
