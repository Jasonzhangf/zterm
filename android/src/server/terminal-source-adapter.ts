import type {
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';

export type TerminalSourceKind = 'tmux' | 'herdr' | 'wezterm';
export type TerminalIdentityBackendKind = 'tmux' | 'herdr';

export interface TerminalSessionIdentity {
  backend: TerminalIdentityBackendKind;
  sessionName: string;
  stableId: string;
}

export interface TmuxTerminalSessionTarget {
  backend: 'tmux';
  sessionName: string;
  stableId: string;
  socketPath?: string;
  serverPid: string;
  sessionId: string;
  createdAt: number;
}

export interface HerdrTerminalSessionTarget {
  backend: 'herdr';
  sessionName: string;
  stableId: string;
  terminalId: string;
  paneId: string;
}

export type TerminalSessionNativeTarget =
  | TmuxTerminalSessionTarget
  | HerdrTerminalSessionTarget;

export interface ResolvedTerminalSession {
  identity: TerminalSessionIdentity;
  target: TerminalSessionNativeTarget;
}

export type TerminalSessionIdentityResolution =
  | { ok: true; session: ResolvedTerminalSession }
  | {
      ok: false;
      code: 'session_not_found' | 'session_identity_mismatch';
      message: string;
    };

export type ParsedTmuxSessionStableIdentity = {
  backend: 'tmux';
  socketPath?: string;
  serverPid: string;
  sessionId: string;
  createdAt: number;
};

export type ParsedHerdrSessionStableIdentity = {
  backend: 'herdr';
  terminalId: string;
  paneId: string;
};

export type ParsedTerminalSessionStableIdentity =
  | ParsedTmuxSessionStableIdentity
  | ParsedHerdrSessionStableIdentity;

const TMUX_STABLE_ID_PREFIX = 'tmux:v1:';
const HERDR_STABLE_ID_PREFIX = 'herdr:v1:';

function encodeStableIdentity(prefix: string, value: object) {
  return `${prefix}${encodeURIComponent(JSON.stringify(value))}`;
}

export function buildTmuxSessionStableId(value: {
  socketPath?: string;
  serverPid: string;
  sessionId: string;
  createdAt: number;
}) {
  return encodeStableIdentity(TMUX_STABLE_ID_PREFIX, {
    backend: 'tmux',
    ...(value.socketPath ? { socketPath: value.socketPath } : {}),
    serverPid: value.serverPid,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
  });
}

export function buildHerdrSessionStableId(value: {
  terminalId: string;
  paneId: string;
}) {
  return encodeStableIdentity(HERDR_STABLE_ID_PREFIX, {
    backend: 'herdr',
    terminalId: value.terminalId,
    paneId: value.paneId,
  });
}

export function parseTerminalSessionStableId(
  stableId: string,
): ParsedTerminalSessionStableIdentity | null {
  const prefix = stableId.startsWith(TMUX_STABLE_ID_PREFIX)
    ? TMUX_STABLE_ID_PREFIX
    : stableId.startsWith(HERDR_STABLE_ID_PREFIX)
      ? HERDR_STABLE_ID_PREFIX
      : null;
  if (!prefix) {
    return null;
  }
  try {
    const value = JSON.parse(
      decodeURIComponent(stableId.slice(prefix.length)),
    ) as Record<string, unknown>;
    if (prefix === TMUX_STABLE_ID_PREFIX && value.backend === 'tmux') {
      if (
        typeof value.serverPid !== 'string'
        || !value.serverPid
        || typeof value.sessionId !== 'string'
        || !value.sessionId
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || (value.socketPath !== undefined && typeof value.socketPath !== 'string')
      ) {
        return null;
      }
      return {
        backend: 'tmux',
        ...(value.socketPath ? { socketPath: value.socketPath as string } : {}),
        serverPid: value.serverPid,
        sessionId: value.sessionId,
        createdAt: value.createdAt,
      };
    }
    if (
      prefix === HERDR_STABLE_ID_PREFIX
      && value.backend === 'herdr'
      && typeof value.terminalId === 'string'
      && value.terminalId
      && typeof value.paneId === 'string'
      && value.paneId
    ) {
      return {
        backend: 'herdr',
        terminalId: value.terminalId,
        paneId: value.paneId,
      };
    }
  } catch {
    // Malformed opaque identities are a mismatch, not a fallback by name.
  }
  return null;
}

export interface TerminalSourceMirrorSnapshot {
  /**
   * Source-side informational revision. The mirror writer still owns zterm
   * mirror.revision; this value never drives the zterm revision broadcast.
   */
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
  lastScrollbackCount?: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  captureDurationMs?: number;
  canonicalizeDurationMs?: number;
  capturedLineCount?: number;
  canonicalLineCount?: number;
  totalAvailableLines?: number;
  visibleTopIndex?: number;
  capabilityGaps?: readonly string[];
  captureStartedAt?: number;
  captureDoneAt?: number;
  canonicalizeDoneAt?: number;
  source?: TerminalSourceKind;
}

export interface TerminalSourceSession {
  sessionName: string;
  paneId: number | string;
  stableId?: string;
  workspace?: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface TerminalSourceAdapter {
  kind?: TerminalSourceKind;
  listSessions: () => TerminalSourceSession[];
  createSession: (input?: { sessionName?: string; cwd?: string; command?: string[] }) => TerminalSourceSession;
  readSnapshot: (sessionName: string) => Promise<TerminalSourceMirrorSnapshot>;
  writeInput: (sessionName: string, input: Buffer | string) => void;
  resizeSession?: (sessionName: string, geometry: { cols: number; rows: number }) => void;
  supportsSessionRename?: boolean;
  renameSession?: (sessionName: string, nextSessionName: string) => string;
  closeSession: (sessionName: string) => void;
  readCurrentPath: (sessionName: string) => string;
  readSessionIdentity?: (sessionName: string) => TerminalSessionIdentity;
  resolveExistingSession?: (stableId: string) => ResolvedTerminalSession | null;
  bindResolvedSession?: (session: ResolvedTerminalSession) => void;
}

export function assertSupportedTerminalSourceKind(
  value: string | undefined,
): TerminalSourceKind {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'tmux' || normalized === 'herdr' || normalized === 'wezterm') {
    return normalized;
  }
  throw new Error(`unsupported terminal source kind: ${normalized || '<empty>'}`);
}
