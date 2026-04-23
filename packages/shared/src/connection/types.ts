import { DEFAULT_BRIDGE_PORT } from './mobile-config';

export interface Host {
  id: string;
  createdAt: number;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
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

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  viewport: TerminalCell[][];
  cursor: TerminalCursor;
  cursorKeysApp: boolean;
  scrollbackLines?: string[];
  scrollbackStartIndex?: number;
}

export interface TerminalIndexedLine {
  index: number;
  cells: TerminalCell[];
}

export interface TerminalGapRange {
  startIndex: number;
  endIndex: number;
}

export interface TerminalBufferPayload {
  revision: number;
  startIndex: number;
  endIndex: number;
  viewportEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  lines: TerminalIndexedLine[];
}

export interface BufferSyncRequestPayload {
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
  mode: 'follow' | 'reading';
  prefetch?: boolean;
  missingRanges?: TerminalGapRange[];
}

export interface BufferHeadPayload {
  sessionId: string;
  revision: number;
  latestEndIndex: number;
}

export interface SessionBufferState {
  lines: TerminalCell[][];
  gapRanges: TerminalGapRange[];
  startIndex: number;
  endIndex: number;
  viewportEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
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
  sessionName: '',
  authToken: '',
  authType: 'password',
  password: '',
  privateKey: '',
  tags: [],
  pinned: false,
  autoCommand: '',
};
