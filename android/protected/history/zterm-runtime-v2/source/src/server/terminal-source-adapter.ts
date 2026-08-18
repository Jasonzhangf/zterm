import type {
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';

export type TerminalSourceKind = 'tmux' | 'herdr' | 'wezterm';

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
