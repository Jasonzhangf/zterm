import { DEFAULT_BRIDGE_PORT } from './mobile-config';

export interface Host {
  id: string;
  createdAt: number;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  sessionName: string;
  authToken?: string;
  relayHostId?: string;
  relayDeviceId?: string;
  tailscaleHost?: string;
  ipv6Host?: string;
  ipv4Host?: string;
  signalUrl?: string;
  transportMode?: 'auto' | 'websocket' | 'webrtc';
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  tags: string[];
  pinned: boolean;
  lastConnected?: number;
  autoCommand?: string;
}

export type EditableHost = Omit<Host, 'id' | 'createdAt'>;

export interface TerminalCell {
  char: number;
  fg: number;
  bg: number;
  flags: number;
  width: number;
}

export interface TerminalCursor {
  row: number;
  col: number;
  visible: boolean;
}

export interface TerminalIndexedLine {
  index: number;
  cells: TerminalCell[];
}

/**
 * Terminal cursor state — matches daemon/Android wire truth.
 */
export interface TerminalCursorState {
  rowIndex: number;
  col: number;
  visible: boolean;
}

/**
 * Compact wire format for a single line.
 * Replaces TerminalIndexedLine on the wire to cut payload size ~95%.
 *
 *   i = absolute line index
 *   t = text content (codePoints, width-0 continuation cells skipped)
 *   w = optional width per codepoint (omitted = all 1; needed for CJK double-width)
 *   s = optional sparse style spans [startCol, endCol, fg, bg, flags]
 */
export interface CompactIndexedLine {
  i: number;
  t: string;
  w?: number[];
  s?: [number, number, number, number, number][];
}

/** Wire format: either compact (new) or legacy full-cell (old). */
export type WireIndexedLine = CompactIndexedLine | TerminalIndexedLine;

export interface TerminalGapRange {
  startIndex: number;
  endIndex: number;
}

export interface TerminalBufferPayload {
  revision: number;
  startIndex: number;
  endIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor?: TerminalCursorState | null;
  lines: WireIndexedLine[];
}

export interface BufferSyncRequestPayload {
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  requestStartIndex: number;
  requestEndIndex: number;
  missingRanges?: TerminalGapRange[];
}

export interface BufferHeadPayload {
  sessionId: string;
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cursorKeysApp?: boolean;
  cursor?: TerminalCursorState | null;
}

export interface SessionBufferState {
  lines: TerminalCell[][];
  gapRanges: TerminalGapRange[];
  startIndex: number;
  endIndex: number;
  bufferHeadStartIndex: number;
  bufferTailEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
  updateKind: 'replace' | 'append' | 'prepend' | 'patch';
  revision: number;
}

export interface TerminalRenderBufferProjection {
  lines: TerminalCell[][];
  gapRanges: TerminalGapRange[];
  startIndex: number;
  endIndex: number;
  viewportEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
}

export const STORAGE_KEYS = {
  HOSTS: 'zterm:hosts',
  BRIDGE_SETTINGS: 'zterm:bridge-settings',
  SESSION_HISTORY: 'zterm:session-history',
  SESSION_GROUPS: 'zterm:session-groups',
  OPEN_TABS: 'zterm:open-tabs',
  QUICK_ACTIONS: 'zterm:quick-actions',
  SESSION_DRAFTS: 'zterm:session-drafts',
  WEBDAV_CONFIG: 'zterm:webdav-config',
  COMMAND_HISTORY: 'zterm:command-history',
  ACTIVE_SESSION: 'zterm:active-session',
} as const;

export const DEFAULT_HOST_DRAFT: EditableHost = {
  name: '',
  bridgeHost: '',
  bridgePort: DEFAULT_BRIDGE_PORT,
  daemonHostId: '',
  sessionName: '',
  authToken: '',
  relayHostId: '',
  relayDeviceId: '',
  tailscaleHost: '',
  ipv6Host: '',
  ipv4Host: '',
  signalUrl: '',
  transportMode: 'auto',
  authType: 'password',
  password: '',
  privateKey: '',
  tags: [],
  pinned: false,
  autoCommand: '',
};
