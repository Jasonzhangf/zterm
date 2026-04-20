/**
 * wterm-mobile WebSocket 服务端
 *
 * 目标：tmux/daemon 作为 authoritative terminal truth，移动端只接收低带宽镜像。
 * 连接时先发“最后一屏 + 少量尾部历史”，随后后台渐进补更早历史；运行时仅发 viewport 增量和 scrollback 增量。
 *
 * 修正：buffer 真源按 tmux session mirror 维护，而不是按 websocket/tab 各自维护。
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { WasmBridge } from '@wterm/core';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { homedir } from 'os';
import type {
  PasteImagePayload,
  TerminalCell,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportRowPatch,
  TerminalViewportUpdate,
} from '../lib/types';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_SESSION_NAME,
  WTERM_CONFIG_DISPLAY_PATH,
} from '../lib/mobile-config';
import { getWtermHomeDir, resolveDaemonRuntimeConfig } from './daemon-config';

interface TmuxConnectPayload {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  autoCommand?: string;
}

interface ClientSession {
  id: string;
  ws: WebSocket;
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
  lastScrollbackCount: number;
  capturedStartIndex: number;
  capturedScrollbackLines: string[];
  lastOutputAt: number;
  lastViewportCols: number;
  lastViewportRows: number;
  lastCursorRow: number;
  lastCursorCol: number;
  lastCursorVisible: boolean;
  lastCursorKeysApp: boolean;
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
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'ping' }
  | { type: 'close' };

type ServerMessage =
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'snapshot'; payload: TerminalSnapshot }
  | { type: 'viewport-update'; payload: TerminalViewportUpdate }
  | { type: 'scrollback-update'; payload: TerminalScrollbackUpdate }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

const DAEMON_CONFIG = resolveDaemonRuntimeConfig();
const PORT = DAEMON_CONFIG.port || DEFAULT_BRIDGE_PORT;
const HOST = DAEMON_CONFIG.host || DEFAULT_DAEMON_HOST;

function resolveTmuxBinary() {
  const override = process.env.WTERM_MOBILE_TMUX_BINARY?.trim();
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
const DEFAULT_SESSION_NAME = process.env.WTERM_MOBILE_DEFAULT_SESSION || 'wterm-mobile';
const DAEMON_SESSION_NAME = DAEMON_CONFIG.sessionName || buildDaemonSessionName(PORT);
const HIDDEN_TMUX_SESSIONS = new Set([DAEMON_SESSION_NAME, DEFAULT_DAEMON_SESSION_NAME]);
const AUTO_COMMAND_DELAY_MS = 180;
const REQUIRED_AUTH_TOKEN = DAEMON_CONFIG.authToken;
const INITIAL_SCROLLBACK_TAIL_LINES = 192;
const SCROLLBACK_BACKFILL_CHUNK_LINES = 64;
const FLUSH_INTERVAL_MS = 180;
const IDLE_STREAM_INTERVAL_MS = 1200;
const BACKFILL_INTERVAL_MS = 260;
const IDLE_BEFORE_BACKFILL_MS = 250;
const MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
const WTERM_HOME_DIR = getWtermHomeDir(homedir());
const UPLOAD_DIR = join(WTERM_HOME_DIR, 'uploads');
const LOG_DIR = join(WTERM_HOME_DIR, 'logs');
const WS_HEARTBEAT_INTERVAL_MS = 30000;

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

function createClientSession(ws: WebSocket): ClientSession {
  const session: ClientSession = {
    id: uuidv4(),
    ws,
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
    lastScrollbackCount: -1,
    capturedStartIndex: 0,
    capturedScrollbackLines: [],
    lastOutputAt: 0,
    lastViewportCols: 0,
    lastViewportRows: 0,
    lastCursorRow: -1,
    lastCursorCol: -1,
    lastCursorVisible: false,
    lastCursorKeysApp: false,
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

function cellsToLine(cells: TerminalCell[]) {
  let line = '';
  for (const cell of cells) {
    if (cell.width === 0) {
      continue;
    }
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
  }
  return line.replace(/\s+$/u, '');
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
  return cellsToLine(cells);
}

function readScrollbackRangeByOldestIndex(bridge: WasmBridge, startInclusive: number, endExclusive: number) {
  const totalCount = bridge.getScrollbackCount();
  if (totalCount <= 0 || endExclusive <= startInclusive) {
    return [];
  }

  const start = Math.max(0, Math.min(startInclusive, totalCount));
  const end = Math.max(start, Math.min(endExclusive, totalCount));
  const lines: string[] = [];
  for (let oldestIndex = start; oldestIndex < end; oldestIndex += 1) {
    lines.push(readScrollbackLineByOldestIndex(bridge, totalCount, oldestIndex));
  }
  return lines;
}

function captureTmuxLines(sessionName: string, limit: number) {
  const captureLimit = Math.max(0, Math.floor(limit));
  if (captureLimit <= 0) {
    return [];
  }

  try {
    const result = runTmux(['capture-pane', '-p', '-t', sessionName, '-S', `-${captureLimit}`]);
    return result.stdout
      .replace(/\r/g, '')
      .split('\n')
      .filter((line, index, source) => !(index === source.length - 1 && line === ''));
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] capture-pane fallback for ${sessionName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function refreshMirrorCapturedScrollback(mirror: SessionMirror) {
  const bridge = mirror.bridge;
  if (!bridge) {
    return;
  }

  const currentScrollbackCount = bridge.getScrollbackCount();
  const capturedLines = captureTmuxLines(mirror.sessionName, MAX_CAPTURED_SCROLLBACK_LINES + bridge.getRows());
  const totalCapturedScrollback = Math.max(0, capturedLines.length - bridge.getRows());
  mirror.capturedScrollbackLines = totalCapturedScrollback > 0 ? capturedLines.slice(0, totalCapturedScrollback) : [];
  mirror.capturedStartIndex = Math.max(0, currentScrollbackCount - totalCapturedScrollback);
  mirror.lastScrollbackCount = currentScrollbackCount;
}

function buildSnapshotFromMirrorForClient(session: ClientSession, mirror: SessionMirror): TerminalSnapshot | null {
  const bridge = mirror.bridge;
  if (!bridge) {
    return null;
  }

  const totalCaptured = mirror.capturedScrollbackLines.length;
  const tailCount = Math.min(totalCaptured, INITIAL_SCROLLBACK_TAIL_LINES);
  const tailLocalStart = totalCaptured - tailCount;
  const tailAbsoluteStart = mirror.capturedStartIndex + tailLocalStart;
  session.backfillCursor = tailAbsoluteStart;

  return {
    cols: bridge.getCols(),
    rows: bridge.getRows(),
    viewport: buildViewport(bridge),
    cursor: bridge.getCursor(),
    cursorKeysApp: bridge.cursorKeysApp(),
    scrollbackLines: mirror.capturedScrollbackLines.slice(tailLocalStart, totalCaptured),
    scrollbackStartIndex: tailAbsoluteStart,
  };
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
    const startOffset = Math.max(0, startAbsolute - nextMirror.capturedStartIndex);
    const endOffset = Math.max(startOffset, endAbsolute - nextMirror.capturedStartIndex);
    const lines = nextMirror.capturedScrollbackLines.slice(startOffset, endOffset);
    session.backfillCursor = startAbsolute;

    if (lines.length > 0) {
      sendMessage(session, {
        type: 'scrollback-update',
        payload: {
          mode: 'prepend',
          lines,
          startIndex: startAbsolute,
          remaining: Math.max(0, startAbsolute - nextMirror.capturedStartIndex),
        },
      });
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

function sendSnapshotToClient(session: ClientSession, mirror: SessionMirror, scheduleBackfill: boolean) {
  const snapshot = buildSnapshotFromMirrorForClient(session, mirror);
  if (!snapshot) {
    return;
  }

  session.title = mirror.title;
  session.sessionName = mirror.sessionName;
  session.idleDirty = false;
  if (session.state !== 'connected') {
    session.state = 'connected';
    sendMessage(session, { type: 'connected', payload: { sessionId: session.id } });
  }
  sendMessage(session, { type: 'title', payload: mirror.title });
  sendMessage(session, { type: 'snapshot', payload: snapshot });
  mirror.lastViewportCols = snapshot.cols;
  mirror.lastViewportRows = snapshot.rows;
  mirror.lastCursorRow = snapshot.cursor.row;
  mirror.lastCursorCol = snapshot.cursor.col;
  mirror.lastCursorVisible = snapshot.cursor.visible;
  mirror.lastCursorKeysApp = snapshot.cursorKeysApp;

  if (scheduleBackfill) {
    scheduleClientBackfill(session);
  }
}

function scheduleIdleSnapshot(session: ClientSession) {
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
    sendSnapshotToClient(session, nextMirror, false);
  }, IDLE_STREAM_INTERVAL_MS);
}

function markIdleSessionDirty(session: ClientSession) {
  session.idleDirty = true;
  scheduleIdleSnapshot(session);
}

function sendInitialSnapshotToClient(session: ClientSession, mirror: SessionMirror) {
  sendSnapshotToClient(session, mirror, true);
}

function broadcastMirrorSnapshotReset(mirror: SessionMirror) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }
    clearClientBackfillTimer(session);
    sendInitialSnapshotToClient(session, mirror);
  }
}

function broadcastMirrorViewportUpdate(mirror: SessionMirror, payload: TerminalViewportUpdate) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      continue;
    }
    if (session.streamMode === 'active') {
      sendMessage(session, { type: 'viewport-update', payload });
    } else {
      markIdleSessionDirty(session);
    }
  }
}

function broadcastMirrorScrollbackAppend(mirror: SessionMirror, lines: string[], startIndex: number) {
  for (const sessionId of mirror.subscribers) {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      continue;
    }
    if (session.streamMode === 'active') {
      sendMessage(session, {
        type: 'scrollback-update',
        payload: {
          mode: 'append',
          lines,
          startIndex,
          remaining: session.backfillCursor === null ? 0 : Math.max(0, session.backfillCursor - mirror.capturedStartIndex),
        },
      });
    } else {
      markIdleSessionDirty(session);
    }
  }
}

function buildViewportUpdate(bridge: WasmBridge): TerminalViewportUpdate {
  const rowsPatch: TerminalViewportRowPatch[] = [];
  const rows = bridge.getRows();
  const cols = bridge.getCols();

  for (let row = 0; row < rows; row += 1) {
    if (!bridge.isDirtyRow(row)) {
      continue;
    }
    const cells: TerminalCell[] = [];
    for (let col = 0; col < cols; col += 1) {
      cells.push(serializeCell(bridge.getCell(row, col)));
    }
    rowsPatch.push({ row, cells });
  }

  return {
    cols,
    rows,
    rowsPatch,
    cursor: bridge.getCursor(),
    cursorKeysApp: bridge.cursorKeysApp(),
  };
}

function syncMirrorScrollbackAppend(mirror: SessionMirror, startIndex: number, lines: string[]) {
  const expectedNextIndex = mirror.capturedStartIndex + mirror.capturedScrollbackLines.length;
  if (startIndex !== expectedNextIndex) {
    return false;
  }

  mirror.capturedScrollbackLines.push(...lines);
  if (mirror.capturedScrollbackLines.length > MAX_CAPTURED_SCROLLBACK_LINES) {
    const trimCount = mirror.capturedScrollbackLines.length - MAX_CAPTURED_SCROLLBACK_LINES;
    mirror.capturedScrollbackLines.splice(0, trimCount);
    mirror.capturedStartIndex += trimCount;
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
    broadcastMirrorSnapshotReset(mirror);
    return;
  }

  const newScrollbackLines = currentScrollbackCount - mirror.lastScrollbackCount;
  if (newScrollbackLines > 0) {
    const startIndex = currentScrollbackCount - newScrollbackLines;
    const appended = readScrollbackRangeByOldestIndex(bridge, startIndex, currentScrollbackCount);
    if (appended.length > 0) {
      if (syncMirrorScrollbackAppend(mirror, startIndex, appended)) {
        broadcastMirrorScrollbackAppend(mirror, appended, startIndex);
      } else {
        refreshMirrorCapturedScrollback(mirror);
        bridge.clearDirty();
        broadcastMirrorSnapshotReset(mirror);
        return;
      }
    }
  }

  const viewportUpdate = buildViewportUpdate(bridge);
  const cursorChanged =
    viewportUpdate.cols !== mirror.lastViewportCols ||
    viewportUpdate.rows !== mirror.lastViewportRows ||
    viewportUpdate.cursor.row !== mirror.lastCursorRow ||
    viewportUpdate.cursor.col !== mirror.lastCursorCol ||
    viewportUpdate.cursor.visible !== mirror.lastCursorVisible ||
    viewportUpdate.cursorKeysApp !== mirror.lastCursorKeysApp;
  if (viewportUpdate.rowsPatch.length > 0 || cursorChanged) {
    broadcastMirrorViewportUpdate(mirror, viewportUpdate);
    mirror.lastViewportCols = viewportUpdate.cols;
    mirror.lastViewportRows = viewportUpdate.rows;
    mirror.lastCursorRow = viewportUpdate.cursor.row;
    mirror.lastCursorCol = viewportUpdate.cursor.col;
    mirror.lastCursorVisible = viewportUpdate.cursor.visible;
    mirror.lastCursorKeysApp = viewportUpdate.cursorKeysApp;
  }

  mirror.lastScrollbackCount = currentScrollbackCount;
  bridge.clearDirty();
}

function scheduleMirrorFlush(mirror: SessionMirror) {
  if (mirror.flushTimer || mirror.state !== 'connected') {
    return;
  }

  mirror.flushTimer = setTimeout(() => flushMirrorUpdates(mirror), FLUSH_INTERVAL_MS);
}

async function startMirror(mirror: SessionMirror, autoCommand?: string) {
  if (mirror.state === 'connected' || mirror.state === 'connecting') {
    return;
  }

  mirror.state = 'connecting';
  mirror.title = mirror.sessionName;
  mirror.lastScrollbackCount = -1;
  mirror.capturedStartIndex = 0;
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
    broadcastMirrorSnapshotReset(mirror);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] initial snapshot failed for ${mirror.sessionName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    try {
      const fallbackSnapshot: TerminalSnapshot = {
        cols: mirror.bridge.getCols(),
        rows: mirror.bridge.getRows(),
        viewport: buildViewport(mirror.bridge),
        cursor: mirror.bridge.getCursor(),
        cursorKeysApp: mirror.bridge.cursorKeysApp(),
        scrollbackLines: [],
        scrollbackStartIndex: 0,
      };
      mirror.lastScrollbackCount = mirror.bridge.getScrollbackCount();
      mirror.capturedStartIndex = mirror.lastScrollbackCount;
      mirror.capturedScrollbackLines = [];
      mirror.bridge.clearDirty();
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        session.title = mirror.title;
        session.sessionName = mirror.sessionName;
        session.backfillCursor = 0;
        if (session.state !== 'connected') {
          session.state = 'connected';
          sendMessage(session, { type: 'connected', payload: { sessionId: session.id } });
        }
        sendMessage(session, { type: 'title', payload: mirror.title });
        sendMessage(session, { type: 'snapshot', payload: fallbackSnapshot });
      }
    } catch (fallbackError) {
      console.error(
        `[${new Date().toISOString()}] fallback snapshot failed for ${mirror.sessionName}: ${
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

  const previousMirror = getClientMirror(session);
  if (previousMirror) {
    previousMirror.subscribers.delete(session.id);
  }

  session.state = 'connecting';
  session.title = nextSessionName;
  session.sessionName = nextSessionName;
  session.mirrorKey = nextMirrorKey;
  session.backfillCursor = null;

  let mirror = mirrors.get(nextMirrorKey);
  if (!mirror) {
    mirror = createMirror(nextSessionName);
  }

  mirror.subscribers.add(session.id);
  sendMessage(session, { type: 'title', payload: mirror.title });

  if (mirror.state === 'connected' && mirror.bridge) {
    sendInitialSnapshotToClient(session, mirror);
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
  mirror.capturedStartIndex = 0;
  mirror.capturedScrollbackLines = [];
  clearMirrorFlushTimer(mirror);
  refreshMirrorCapturedScrollback(mirror);
  mirror.bridge.clearDirty();
  broadcastMirrorSnapshotReset(mirror);
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
      sendSnapshotToClient(session, mirror, true);
    }
    return;
  }

  clearClientBackfillTimer(session);
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

const wss = new WebSocketServer({
  port: PORT,
  host: HOST,
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

  const session = createClientSession(ws);
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

wss.on('listening', () => {
  console.log(`[${new Date().toISOString()}] wterm-mobile tmux bridge listening on ws://${HOST}:${PORT}`);
  console.log(`  - tmux binary: ${TMUX_BINARY}`);
  console.log(`  - default session: ${DEFAULT_SESSION_NAME}`);
  console.log(`  - active logs: ${LOG_DIR}`);
  console.log(`  - auth: ${REQUIRED_AUTH_TOKEN ? `enabled (${DAEMON_CONFIG.authSource})` : 'disabled'}`);
  console.log(`  - config: ${DAEMON_CONFIG.configFound ? WTERM_CONFIG_DISPLAY_PATH : `${WTERM_CONFIG_DISPLAY_PATH} (not found)`}`);
  console.log(`  - terminal cache lines: ${MAX_CAPTURED_SCROLLBACK_LINES}`);
});
