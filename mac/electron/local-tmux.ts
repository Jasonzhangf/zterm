import { BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LOCAL_TMUX_EVENT = 'zterm:local-tmux-event';
const ACTIVE_POLL_INTERVAL_MS = 33;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface LocalBufferSyncRequestPayload {
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  requestStartIndex: number;
  requestEndIndex: number;
  missingRanges?: Array<{ startIndex: number; endIndex: number }>;
}

interface LocalTerminalBufferPayload {
  revision: number;
  startIndex: number;
  endIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  lines: Array<{ index: number; cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> }>;
}

interface LocalBufferHeadPayload {
  sessionId: string;
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
}

interface LocalTmuxCapturePayload {
  cols: number;
  rows: number;
  viewport: Array<Array<{ char: number; fg: number; bg: number; flags: number; width: number }>>;
  cursor: { row: number; col: number; visible: boolean };
  cursorKeysApp: boolean;
  scrollbackLines?: string[];
  scrollbackStartIndex?: number;
}

type LocalTmuxMessage =
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'buffer-head'; payload: LocalBufferHeadPayload }
  | { type: 'buffer-sync'; payload: LocalTerminalBufferPayload };

type LocalTmuxActivityMode = 'active' | 'idle';

interface LocalTmuxClient {
  clientId: string;
  sessionName: string;
  cols: number;
  rows: number;
  activityMode: LocalTmuxActivityMode;
  timer: NodeJS.Timeout | null;
  refreshInFlight: boolean;
  refreshQueued: boolean;
  disposed: boolean;
  revision: number;
  lastCaptureFingerprint: string;
  lastHeadPayload: LocalBufferHeadPayload | null;
  lastTitle: string;
}

function updateHash(hash: number, value: number) {
  let next = hash ^ (value & 0xff);
  next = Math.imul(next, 16777619);
  next ^= (value >>> 8) & 0xff;
  next = Math.imul(next, 16777619);
  next ^= (value >>> 16) & 0xff;
  next = Math.imul(next, 16777619);
  next ^= (value >>> 24) & 0xff;
  return Math.imul(next, 16777619) >>> 0;
}

function updateHashWithString(hash: number, value: string) {
  let next = hash;
  for (const char of value) {
    next = updateHash(next, char.codePointAt(0) || 0);
  }
  return next;
}

function rowsEqual(
  left: Array<{ char: number; fg: number; bg: number; flags: number; width: number }>,
  right: Array<{ char: number; fg: number; bg: number; flags: number; width: number }>,
) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.flags !== b.flags || a.width !== b.width) {
      return false;
    }
  }
  return true;
}

function fingerprintCapture(snapshot: LocalTmuxCapturePayload) {
  let hash = 2166136261;
  hash = updateHash(hash, snapshot.cols);
  hash = updateHash(hash, snapshot.rows);
  hash = updateHash(hash, snapshot.cursor.row);
  hash = updateHash(hash, snapshot.cursor.col);
  hash = updateHash(hash, snapshot.cursor.visible ? 1 : 0);
  hash = updateHash(hash, snapshot.cursorKeysApp ? 1 : 0);
  hash = updateHash(hash, snapshot.scrollbackStartIndex ?? -1);
  for (const line of snapshot.scrollbackLines || []) {
    hash = updateHashWithString(hash, line);
    hash = updateHash(hash, 10);
  }
  for (const row of snapshot.viewport) {
    for (const cell of row) {
      hash = updateHash(hash, cell.char);
      hash = updateHash(hash, cell.fg);
      hash = updateHash(hash, cell.bg);
      hash = updateHash(hash, cell.flags);
      hash = updateHash(hash, cell.width);
    }
    hash = updateHash(hash, 13);
  }
  return hash.toString(16);
}

function isWideCodePoint(codePoint: number) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function createBlankCell() {
  return {
    char: 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function lineToCells(line: string, cols: number) {
  const cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> = [];

  for (const char of Array.from(line)) {
    const codePoint = char.codePointAt(0) || 32;
    const width = isWideCodePoint(codePoint) ? 2 : 1;
    if (width === 2 && cells.length <= cols - 2) {
      cells.push({
        char: codePoint,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 2,
      });
      cells.push({
        char: 32,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 0,
      });
      continue;
    }

    if (cells.length >= cols) {
      break;
    }

    cells.push({
      char: codePoint,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    });
  }

  while (cells.length < cols) {
    cells.push(createBlankCell());
  }

  return cells.slice(0, cols);
}

interface WrappedLineResult {
  segments: string[];
  cursorSegmentIndex?: number;
  cursorSegmentCol?: number;
}

function wrapLineToSegments(line: string, cols: number, cursorCol?: number): WrappedLineResult {
  const safeCols = Math.max(1, cols);
  const segments: string[] = [];
  let current = '';
  let currentWidth = 0;
  let cursorSegmentIndex: number | undefined;
  let cursorSegmentCol: number | undefined;
  let consumedWidth = 0;

  const flush = () => {
    segments.push(current);
    current = '';
    currentWidth = 0;
  };

  for (const char of Array.from(line)) {
    const codePoint = char.codePointAt(0) || 32;
    const charWidth = isWideCodePoint(codePoint) ? 2 : 1;

    if (currentWidth > 0 && currentWidth + charWidth > safeCols) {
      flush();
    }

    if (cursorCol !== undefined && cursorSegmentIndex === undefined && cursorCol < consumedWidth + charWidth) {
      cursorSegmentIndex = segments.length;
      cursorSegmentCol = currentWidth;
    }

    current += char;
    currentWidth += charWidth;
    consumedWidth += charWidth;

    if (currentWidth >= safeCols) {
      flush();
    }
  }

  if (cursorCol !== undefined && cursorSegmentIndex === undefined) {
    cursorSegmentIndex = segments.length;
    cursorSegmentCol = Math.max(0, Math.min(safeCols - 1, currentWidth));
  }

  if (current.length > 0 || segments.length === 0) {
    flush();
  }

  if (cursorCol !== undefined && cursorSegmentIndex === undefined) {
    cursorSegmentIndex = Math.max(0, segments.length - 1);
    cursorSegmentCol = 0;
  }

  return { segments, cursorSegmentIndex, cursorSegmentCol };
}

async function runTmux(args: string[]) {
  const { stdout } = await execFileAsync('tmux', args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function listSessions() {
  try {
    const stdout = await runTmux(['list-sessions', '-F', '#S']);
    return stdout
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [] as string[];
  }
}

async function readSessionCapture(sessionName: string, requestedCols: number, requestedRows: number, options?: { visibleOnly?: boolean }) {
  const target = sessionName;
  const metricsRaw = await runTmux([
    'display-message',
    '-p',
    '-t',
    target,
    '#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{?cursor_flag,1,0}\t#{session_name}\t#{window_name}\t#{pane_title}\t#{history_size}',
  ]);
  const [
    paneWidthText,
    paneHeightText,
    cursorXText,
    cursorYText,
    cursorVisibleText,
    resolvedSessionName,
    windowName,
    paneTitle,
    historySizeText,
  ] = metricsRaw.trimEnd().split('\t');

  const paneCols = Math.max(1, Number.parseInt(paneWidthText || '', 10) || requestedCols || DEFAULT_COLS);
  const paneRows = Math.max(1, Number.parseInt(paneHeightText || '', 10) || requestedRows || DEFAULT_ROWS);
  const cols = Math.max(1, requestedCols || paneCols || DEFAULT_COLS);
  const rows = Math.max(1, requestedRows || paneRows || DEFAULT_ROWS);
  const cursorCol = Math.max(0, Number.parseInt(cursorXText || '', 10) || 0);
  const cursorRow = Math.max(0, Number.parseInt(cursorYText || '', 10) || 0);
  const cursorVisible = (cursorVisibleText || '0') === '1';
  const historySize = Math.max(0, Number.parseInt(historySizeText || '', 10) || 0);
  const title = [resolvedSessionName, windowName, paneTitle].filter(Boolean).join(' · ') || sessionName;

  const captureStart = options?.visibleOnly ? `-${paneRows}` : `-${historySize}`;
  const captureRaw = await runTmux(['capture-pane', '-p', '-t', target, '-S', captureStart, '-E', '-1']);
  const normalized = captureRaw.replace(/\r\n/g, '\n');
  const capturedLines = normalized.length === 0 ? [] : normalized.split('\n');
  const wrappedLines: string[] = [];
  const visibleLineStart = Math.max(0, capturedLines.length - paneRows);
  let cursorWrappedIndex = 0;
  let cursorWrappedCol = Math.max(0, Math.min(cols - 1, cursorCol));

  if (capturedLines.length === 0) {
    wrappedLines.push('');
  } else {
    capturedLines.forEach((line, index) => {
      const wrapped = wrapLineToSegments(
        line,
        cols,
        index === visibleLineStart + Math.min(Math.max(cursorRow, 0), Math.max(0, paneRows - 1)) ? cursorCol : undefined,
      );
      if (
        index === visibleLineStart + Math.min(Math.max(cursorRow, 0), Math.max(0, paneRows - 1))
        && wrapped.cursorSegmentIndex !== undefined
        && wrapped.cursorSegmentCol !== undefined
      ) {
        cursorWrappedIndex = wrappedLines.length + wrapped.cursorSegmentIndex;
        cursorWrappedCol = wrapped.cursorSegmentCol;
      }
      wrappedLines.push(...wrapped.segments);
    });
  }

  const totalLines = Math.max(rows, wrappedLines.length);
  const viewportTextLines = wrappedLines.slice(-rows);
  const viewportLines = Array.from({ length: rows }, (_, index) => viewportTextLines[index] || '');
  const scrollbackLines = wrappedLines.slice(0, Math.max(0, wrappedLines.length - rows));
  const viewportStartIndex = Math.max(0, wrappedLines.length - rows);
  const viewportCursorRow = Math.max(0, Math.min(rows - 1, cursorWrappedIndex - viewportStartIndex));

  return {
    title,
    snapshot: {
      cols,
      rows,
      viewport: viewportLines.map((line) => lineToCells(line, cols)),
      cursor: {
        row: viewportCursorRow,
        col: Math.max(0, Math.min(cols - 1, cursorWrappedCol)),
        visible: cursorVisible,
      },
      cursorKeysApp: false,
      scrollbackLines,
      scrollbackStartIndex: totalLines > rows ? 0 : undefined,
    },
  };
}

function parseTmuxSpecialKey(input: string, index: number) {
  const next = input.slice(index);
  if (next.startsWith('\x1b[A')) return { consumed: 3, key: 'Up' };
  if (next.startsWith('\x1b[B')) return { consumed: 3, key: 'Down' };
  if (next.startsWith('\x1b[C')) return { consumed: 3, key: 'Right' };
  if (next.startsWith('\x1b[D')) return { consumed: 3, key: 'Left' };

  const char = input[index];
  if (char === '\r' || char === '\n') return { consumed: 1, key: 'Enter' };
  if (char === '\t') return { consumed: 1, key: 'Tab' };
  if (char === '\x7f') return { consumed: 1, key: 'BSpace' };
  if (char === '\x1b') return { consumed: 1, key: 'Escape' };

  const code = char.charCodeAt(0);
  if (code >= 1 && code <= 26) {
    return { consumed: 1, key: `C-${String.fromCharCode(code + 96)}` };
  }

  return null;
}

function buildBufferHeadPayload(sessionName: string, revision: number, payload: LocalTerminalBufferPayload): LocalBufferHeadPayload {
  return {
    sessionId: `local:${sessionName}`,
    revision,
    latestEndIndex: payload.endIndex,
    availableStartIndex: payload.availableStartIndex,
    availableEndIndex: payload.availableEndIndex,
  };
}

function captureToBufferPayload(snapshot: LocalTmuxCapturePayload, revision: number): LocalTerminalBufferPayload {
  const scrollbackStartIndex = Number.isFinite(snapshot.scrollbackStartIndex)
    ? Math.max(0, Math.floor(snapshot.scrollbackStartIndex || 0))
    : 0;
  const indexedLines = [
    ...(snapshot.scrollbackLines || []).map((line, offset) => ({
      index: scrollbackStartIndex + offset,
      cells: lineToCells(line, snapshot.cols),
    })),
    ...snapshot.viewport.map((cells, offset) => ({
      index: scrollbackStartIndex + (snapshot.scrollbackLines?.length || 0) + offset,
      cells,
    })),
  ];
  const endIndex = scrollbackStartIndex + indexedLines.length;

  return {
    revision,
    startIndex: scrollbackStartIndex,
    endIndex,
    availableStartIndex: scrollbackStartIndex,
    availableEndIndex: endIndex,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorKeysApp: snapshot.cursorKeysApp,
    lines: indexedLines,
  };
}

function slicePayloadLines(payload: LocalTerminalBufferPayload, startIndex: number, endIndex: number) {
  return payload.lines.filter((line) => line.index >= startIndex && line.index < endIndex);
}

function normalizeMissingRanges(
  missingRanges: LocalBufferSyncRequestPayload['missingRanges'],
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

function buildRequestedBufferPayload(
  payload: LocalTerminalBufferPayload,
  request: LocalBufferSyncRequestPayload,
): LocalTerminalBufferPayload | null {
  const requestedStartIndex = Math.max(
    payload.startIndex,
    Math.min(payload.endIndex, Math.floor(request.requestStartIndex || payload.startIndex)),
  );
  const requestedEndIndex = Math.max(
    requestedStartIndex,
    Math.min(payload.endIndex, Math.floor(request.requestEndIndex || requestedStartIndex)),
  );
  if (requestedEndIndex <= requestedStartIndex) {
    return null;
  }
  const ranges = normalizeMissingRanges(request.missingRanges, requestedStartIndex, requestedEndIndex);
  const responseRanges = ranges.length > 0
    ? ranges
    : [{ startIndex: requestedStartIndex, endIndex: requestedEndIndex }];

  return {
    ...payload,
    startIndex: requestedStartIndex,
    endIndex: requestedEndIndex,
    lines: responseRanges.flatMap((range) => slicePayloadLines(payload, range.startIndex, range.endIndex)),
  };
}

async function sendInputToSession(sessionName: string, input: string) {
  const target = sessionName;
  let buffer = '';

  const flushLiteral = async () => {
    if (!buffer) {
      return;
    }
    await runTmux(['send-keys', '-t', target, '-l', buffer]);
    buffer = '';
  };

  for (let index = 0; index < input.length; ) {
    const special = parseTmuxSpecialKey(input, index);
    if (special) {
      await flushLiteral();
      await runTmux(['send-keys', '-t', target, special.key]);
      index += special.consumed;
      continue;
    }

    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    buffer += char;
    index += char.length;
  }

  await flushLiteral();
}

export class LocalTmuxManager {
  private clients = new Map<string, LocalTmuxClient>();

  async listSessions() {
    return listSessions();
  }

  private emit(clientId: string, message: LocalTmuxMessage) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(LOCAL_TMUX_EVENT, { clientId, message });
    }
  }

  private clearClientTimer(client: LocalTmuxClient) {
    if (client.timer) {
      clearTimeout(client.timer);
      client.timer = null;
    }
  }

  private scheduleRefresh(client: LocalTmuxClient) {
    this.clearClientTimer(client);
    if (client.activityMode !== 'active' || client.disposed) {
      return;
    }
    client.timer = setTimeout(() => {
      client.timer = null;
      void this.refreshClient(client);
    }, ACTIVE_POLL_INTERVAL_MS);
  }

  private async refreshClient(client: LocalTmuxClient) {
    if (client.disposed) {
      return;
    }
    if (client.refreshInFlight) {
      client.refreshQueued = true;
      return;
    }

    client.refreshInFlight = true;
    try {
      const { title, snapshot } = await readSessionCapture(client.sessionName, client.cols, client.rows, { visibleOnly: true });
      if (client.disposed) {
        return;
      }
      const captureFingerprint = fingerprintCapture(snapshot);

      if (title !== client.lastTitle) {
        client.lastTitle = title;
        this.emit(client.clientId, { type: 'title', payload: title });
      }

      if (captureFingerprint !== client.lastCaptureFingerprint) {
        client.lastCaptureFingerprint = captureFingerprint;
        client.revision += 1;
      }

      const headPayload = buildBufferHeadPayload(
        client.sessionName,
        client.revision,
        captureToBufferPayload(snapshot, client.revision),
      );
      const previousHead = client.lastHeadPayload;
      if (
        !previousHead
        || previousHead.revision !== headPayload.revision
        || previousHead.latestEndIndex !== headPayload.latestEndIndex
        || previousHead.availableStartIndex !== headPayload.availableStartIndex
        || previousHead.availableEndIndex !== headPayload.availableEndIndex
      ) {
        client.lastHeadPayload = headPayload;
        this.emit(client.clientId, {
          type: 'buffer-head',
          payload: headPayload,
        });
      }
    } catch (error) {
      if (!client.disposed) {
        this.emit(client.clientId, {
          type: 'error',
          payload: {
            message: error instanceof Error ? error.message : String(error),
            code: 'local_tmux_refresh_failed',
          },
        });
      }
    } finally {
      client.refreshInFlight = false;
      if (client.disposed) {
        return;
      }
      if (client.refreshQueued) {
        client.refreshQueued = false;
        void this.refreshClient(client);
        return;
      }
      this.scheduleRefresh(client);
    }
  }

  async connect(clientId: string, sessionName: string, cols: number, rows: number, mode: LocalTmuxActivityMode = 'active') {
    await this.disconnect(clientId);

    const available = await this.listSessions();
    if (!available.includes(sessionName)) {
      throw new Error(`Local tmux session not found: ${sessionName}`);
    }

    const client: LocalTmuxClient = {
      clientId,
      sessionName,
      cols: Math.max(1, Math.floor(cols || DEFAULT_COLS)),
      rows: Math.max(1, Math.floor(rows || DEFAULT_ROWS)),
      activityMode: mode,
      timer: null,
      refreshInFlight: false,
      refreshQueued: false,
      disposed: false,
      revision: 0,
      lastCaptureFingerprint: '',
      lastHeadPayload: null,
      lastTitle: '',
    };

    this.clients.set(clientId, client);
    this.emit(clientId, { type: 'connected', payload: { sessionId: `local:${sessionName}` } });
    await this.refreshClient(client);
    this.scheduleRefresh(client);
  }

  async disconnect(clientId: string) {
    const current = this.clients.get(clientId);
    if (!current) {
      return;
    }
    current.disposed = true;
    current.refreshQueued = false;
    this.clearClientTimer(current);
    this.clients.delete(clientId);
    this.emit(clientId, { type: 'closed', payload: { reason: 'local tmux disconnected' } });
  }

  async sendInput(clientId: string, input: string) {
    const client = this.clients.get(clientId);
    if (!client || !input) {
      return;
    }
    await sendInputToSession(client.sessionName, input);
    await this.refreshClient(client);
  }

  async setActivityMode(clientId: string, mode: LocalTmuxActivityMode) {
    const client = this.clients.get(clientId);
    if (!client || client.activityMode === mode) {
      return;
    }
    client.activityMode = mode;
    client.refreshQueued = false;
    this.scheduleRefresh(client);
    if (mode === 'active') {
      await this.refreshClient(client);
    }
  }

  async resize(clientId: string, cols: number, rows: number) {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    client.cols = Math.max(1, Math.floor(cols || client.cols));
    client.rows = Math.max(1, Math.floor(rows || client.rows));
    await this.refreshClient(client);
  }

  async requestBufferHead(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client) {
      return null;
    }

    const { snapshot } = await readSessionCapture(client.sessionName, client.cols, client.rows, { visibleOnly: true });
    const captureFingerprint = fingerprintCapture(snapshot);
    if (captureFingerprint !== client.lastCaptureFingerprint) {
      client.lastCaptureFingerprint = captureFingerprint;
      client.revision += 1;
    }
    const payload = captureToBufferPayload(snapshot, client.revision);
    const headPayload = buildBufferHeadPayload(client.sessionName, client.revision, payload);
    client.lastHeadPayload = headPayload;
    return headPayload;
  }

  async requestBufferSync(clientId: string, request: LocalBufferSyncRequestPayload) {
    const client = this.clients.get(clientId);
    if (!client) {
      return null;
    }

    const { snapshot } = await readSessionCapture(client.sessionName, client.cols, client.rows, { visibleOnly: false });
    const payload = captureToBufferPayload(snapshot, Math.max(client.revision, client.lastHeadPayload?.revision || 0));
    return buildRequestedBufferPayload(payload, request);
  }

  async dispose() {
    const ids = [...this.clients.keys()];
    for (const clientId of ids) {
      await this.disconnect(clientId);
    }
  }
}

export { LOCAL_TMUX_EVENT };
