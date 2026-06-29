import type { TerminalCell } from '../lib/types';
import { spawnSync } from 'child_process';
import { normalizeCapturedLineBlock, trimCanonicalBufferWindow } from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';

export interface WezTermPaneRecord {
  winId: number;
  tabId: number;
  paneId: number;
  workspace: string;
  cols: number;
  rows: number;
  title: string;
  cwd: string;
}

export interface WezTermMirrorSnapshot {
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cols: number;
  rows: number;
  cursorKeysApp: false;
  cursor: null;
}

export interface WezTermInputContract {
  verified: true;
  mode: 'send-text-no-paste-stdin';
  args: string[];
  limitations: string[];
}

export interface WezTermBackendSession {
  sessionName: string;
  paneId: number;
  workspace: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface WezTermCommandRunner {
  run: (args: string[]) => string;
  runWithInput: (args: string[], input: Buffer | string) => void;
}

export interface WezTermBackendRuntimeOptions {
  runner: WezTermCommandRunner;
  workspacePrefix?: string;
  defaultCommand?: string[];
  maxMirrorLines?: number;
}

export interface WezTermBackendRuntime {
  listSessions: () => WezTermBackendSession[];
  createSession: (input?: { sessionName?: string; cwd?: string; command?: string[] }) => WezTermBackendSession;
  readSnapshot: (sessionName: string) => Promise<WezTermMirrorSnapshot>;
  writeInput: (sessionName: string, input: Buffer | string) => void;
  closeSession: (sessionName: string) => void;
  readCurrentPath: (sessionName: string) => string;
}

export function createWezTermCommandRunner(executable: string): WezTermCommandRunner {
  function normalizeError(stderr: string, code: number | null) {
    const trimmed = stderr.trim();
    return trimmed || `${executable} exited with status ${code ?? 'unknown'}`;
  }

  function runSpawn(args: string[], input?: Buffer | string) {
    const result = spawnSync(executable, args, {
      encoding: 'utf-8',
      input,
      shell: false,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(normalizeError(result.stderr || '', result.status));
    }
    return result.stdout || '';
  }

  return {
    run: (args: string[]) => runSpawn(args),
    runWithInput: (args: string[], input: Buffer | string) => {
      runSpawn(args, input);
    },
  };
}

export interface BuildWezTermMirrorSnapshotOptions {
  pane: WezTermPaneRecord;
  revision: number;
  previousStartIndex?: number;
  previousLineCount?: number;
  getTextEscapes: string;
  maxMirrorLines?: number;
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid wezterm ${label}: ${value}`);
  }
  return parsed;
}

function parseSize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid wezterm pane size: ${value}`);
  }
  return {
    cols: parsePositiveInteger(match[1]!, 'cols'),
    rows: parsePositiveInteger(match[2]!, 'rows'),
  };
}

export function parseWezTermPaneList(raw: string): WezTermPaneRecord[] {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const body = /^WINID\s+TABID\s+PANEID\s+WORKSPACE\s+SIZE\s+TITLE\s+CWD$/i.test(lines[0]!)
    ? lines.slice(1)
    : lines;

  return body.map((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 7) {
      throw new Error(`invalid wezterm pane row: ${line}`);
    }
    const [winIdRaw, tabIdRaw, paneIdRaw, workspace, sizeRaw, title, ...cwdParts] = parts;
    const size = parseSize(sizeRaw!);
    return {
      winId: parsePositiveInteger(winIdRaw!, 'winId'),
      tabId: parsePositiveInteger(tabIdRaw!, 'tabId'),
      paneId: parsePositiveInteger(paneIdRaw!, 'paneId'),
      workspace: workspace!,
      cols: size.cols,
      rows: size.rows,
      title: title!,
      cwd: cwdParts.join(' '),
    };
  });
}

function stripAnsiControlSequences(line: string) {
  return line.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
}

function normalizeWezTermGetTextLines(raw: string) {
  const lines = normalizeCapturedLineBlock(raw);
  let end = lines.length;
  while (end > 0 && stripAnsiControlSequences(lines[end - 1]!).trim().length === 0) {
    end -= 1;
  }
  return end === lines.length ? lines : lines.slice(0, end);
}

function resolveNextStartIndex(options: {
  previousStartIndex: number;
  previousLineCount: number;
  nextLineCount: number;
  trimmedLineCount: number;
}) {
  const previousStartIndex = Math.max(0, Math.floor(options.previousStartIndex || 0));
  const previousLineCount = Math.max(0, Math.floor(options.previousLineCount || 0));
  const nextLineCount = Math.max(0, Math.floor(options.nextLineCount || 0));
  const trimmedLineCount = Math.max(0, Math.floor(options.trimmedLineCount || 0));

  if (trimmedLineCount > 0) {
    const previousEndIndex = previousStartIndex + previousLineCount;
    const nextEndIndex = Math.max(previousEndIndex, previousStartIndex + nextLineCount);
    return Math.max(0, nextEndIndex - (nextLineCount - trimmedLineCount));
  }

  return previousStartIndex;
}

export async function buildWezTermMirrorSnapshot(
  options: BuildWezTermMirrorSnapshotOptions,
): Promise<WezTermMirrorSnapshot> {
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1000));
  const rawLines = normalizeWezTermGetTextLines(options.getTextEscapes);
  const canonicalLines = await canonicalizeCapturedMirrorLines(rawLines, options.pane.cols);
  const trimmed = trimCanonicalBufferWindow(0, canonicalLines, maxMirrorLines);
  const trimmedLineCount = canonicalLines.length - trimmed.lines.length;
  const bufferStartIndex = resolveNextStartIndex({
    previousStartIndex: options.previousStartIndex || 0,
    previousLineCount: options.previousLineCount || 0,
    nextLineCount: canonicalLines.length,
    trimmedLineCount,
  });

  return {
    revision: Math.max(0, Math.floor(options.revision || 0)),
    bufferStartIndex,
    bufferLines: trimmed.lines,
    cols: options.pane.cols,
    rows: options.pane.rows,
    cursorKeysApp: false,
    cursor: null,
  };
}

export function buildWezTermSendTextArgs(paneId: number): string[] {
  const normalizedPaneId = Math.max(0, Math.floor(paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for input: ${paneId}`);
  }
  return ['cli', '--prefer-mux', 'send-text', '--pane-id', String(normalizedPaneId), '--no-paste'];
}

export function buildWezTermListArgs(): string[] {
  return ['cli', '--prefer-mux', 'list'];
}

export function buildWezTermSpawnArgs(input: {
  workspace: string;
  cwd?: string;
  command: string[];
}): string[] {
  const workspace = input.workspace.trim();
  if (!workspace) {
    throw new Error('wezterm workspace is required');
  }
  if (input.command.length === 0 || input.command.some((item) => !item.trim())) {
    throw new Error('wezterm spawn command is required');
  }
  const args = ['cli', '--prefer-mux', 'spawn', '--new-window', '--workspace', workspace];
  if (input.cwd?.trim()) {
    args.push('--cwd', input.cwd.trim());
  }
  args.push('--', ...input.command);
  return args;
}

export function buildWezTermGetTextArgs(input: {
  paneId: number;
  startLine?: number;
  endLine?: number;
}): string[] {
  const normalizedPaneId = Math.max(0, Math.floor(input.paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for get-text: ${input.paneId}`);
  }
  return [
    'cli',
    '--prefer-mux',
    'get-text',
    '--pane-id',
    String(normalizedPaneId),
    '--start-line',
    String(input.startLine ?? -1000),
    '--end-line',
    String(input.endLine ?? 1000),
    '--escapes',
  ];
}

export function buildWezTermKillPaneArgs(paneId: number): string[] {
  const normalizedPaneId = Math.max(0, Math.floor(paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for kill-pane: ${paneId}`);
  }
  return ['cli', '--prefer-mux', 'kill-pane', '--pane-id', String(normalizedPaneId)];
}

function sanitizeWezTermSessionName(input: string, fallback: string) {
  const normalized = input.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function paneToBackendSession(pane: WezTermPaneRecord, workspacePrefix: string): WezTermBackendSession {
  const fallback = `wezterm-pane-${pane.paneId}`;
  const workspaceName = pane.workspace.startsWith(workspacePrefix)
    ? pane.workspace.slice(workspacePrefix.length)
    : pane.workspace;
  return {
    sessionName: sanitizeWezTermSessionName(workspaceName, fallback),
    paneId: pane.paneId,
    workspace: pane.workspace,
    title: pane.title,
    cwd: pane.cwd,
    cols: pane.cols,
    rows: pane.rows,
  };
}

function pickSpawnPaneId(output: string) {
  const matches = output.match(/\b\d+\b/g);
  if (!matches?.length) {
    throw new Error(`wezterm spawn did not return a pane id: ${output}`);
  }
  return Number.parseInt(matches[matches.length - 1]!, 10);
}

export function createWezTermBackendRuntime(options: WezTermBackendRuntimeOptions): WezTermBackendRuntime {
  const workspacePrefix = options.workspacePrefix || 'zterm-';
  const defaultCommand = options.defaultCommand || ['cmd.exe'];
  const maxMirrorLines = options.maxMirrorLines || 1000;
  const sessionPaneIds = new Map<string, number>();
  const snapshotState = new Map<string, {
    revision: number;
    previousStartIndex: number;
    previousLineCount: number;
  }>();

  function listPaneRecords() {
    return parseWezTermPaneList(options.runner.run(buildWezTermListArgs()));
  }

  function listSessions() {
    return listPaneRecords().map((pane) => paneToBackendSession(pane, workspacePrefix));
  }

  function resolveSession(sessionName: string) {
    const normalizedSessionName = sanitizeWezTermSessionName(sessionName, '');
    if (!normalizedSessionName) {
      throw new Error('wezterm sessionName is required');
    }
    const explicitPaneId = sessionPaneIds.get(normalizedSessionName);
    const sessions = listSessions();
    const matched = explicitPaneId
      ? sessions.find((session) => session.paneId === explicitPaneId)
      : sessions.find((session) => session.sessionName === normalizedSessionName);
    if (!matched) {
      throw new Error(`wezterm session not found: ${normalizedSessionName}`);
    }
    sessionPaneIds.set(normalizedSessionName, matched.paneId);
    return matched;
  }

  function createSession(input?: { sessionName?: string; cwd?: string; command?: string[] }) {
    const sessionName = sanitizeWezTermSessionName(input?.sessionName || 'cmd', 'cmd');
    const workspace = `${workspacePrefix}${sessionName}`;
    const paneId = pickSpawnPaneId(options.runner.run(buildWezTermSpawnArgs({
      workspace,
      cwd: input?.cwd,
      command: input?.command?.length ? input.command : defaultCommand,
    })));
    sessionPaneIds.set(sessionName, paneId);
    const pane = listPaneRecords().find((candidate) => candidate.paneId === paneId);
    if (!pane) {
      throw new Error(`created wezterm pane is not listed: ${paneId}`);
    }
    return paneToBackendSession(pane, workspacePrefix);
  }

  async function readSnapshot(sessionName: string) {
    const session = resolveSession(sessionName);
    const state = snapshotState.get(session.sessionName) || {
      revision: 0,
      previousStartIndex: 0,
      previousLineCount: 0,
    };
    const text = options.runner.run(buildWezTermGetTextArgs({ paneId: session.paneId }));
    const snapshot = await buildWezTermMirrorSnapshot({
      pane: {
        winId: 0,
        tabId: 0,
        paneId: session.paneId,
        workspace: session.workspace,
        cols: session.cols,
        rows: session.rows,
        title: session.title,
        cwd: session.cwd,
      },
      revision: state.revision + 1,
      previousStartIndex: state.previousStartIndex,
      previousLineCount: state.previousLineCount,
      getTextEscapes: text,
      maxMirrorLines,
    });
    snapshotState.set(session.sessionName, {
      revision: snapshot.revision,
      previousStartIndex: snapshot.bufferStartIndex,
      previousLineCount: snapshot.bufferLines.length,
    });
    return snapshot;
  }

  function writeInput(sessionName: string, input: Buffer | string) {
    const session = resolveSession(sessionName);
    options.runner.runWithInput(buildWezTermSendTextArgs(session.paneId), input);
  }

  function closeSession(sessionName: string) {
    const session = resolveSession(sessionName);
    options.runner.run(buildWezTermKillPaneArgs(session.paneId));
    sessionPaneIds.delete(session.sessionName);
    snapshotState.delete(session.sessionName);
  }

  function readCurrentPath(sessionName: string) {
    return resolveSession(sessionName).cwd;
  }

  return {
    listSessions,
    createSession,
    readSnapshot,
    writeInput,
    closeSession,
    readCurrentPath,
  };
}

export function requireWezTermInputContract(): WezTermInputContract {
  return {
    verified: true,
    mode: 'send-text-no-paste-stdin',
    args: ['cli', '--prefer-mux', 'send-text', '--pane-id', '<paneId>', '--no-paste'],
    limitations: [
      'write raw bytes to stdin; do not pass input through shell arguments',
      'verified for Enter, Backspace/DEL, arrow escape sequences, raw-mode TUI bytes, and Codex TUI text entry',
      'Ctrl+C is delivered as ETX to raw-mode programs, but does not interrupt cmd.exe ping as a Windows console control event',
    ],
  };
}
