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

export interface TerminalViewportRowPatch {
  row: number;
  cells: TerminalCell[];
}

export interface TerminalViewportUpdate {
  cols: number;
  rows: number;
  rowsPatch: TerminalViewportRowPatch[];
  cursor: TerminalCursor;
  cursorKeysApp: boolean;
}

export interface TerminalScrollbackUpdate {
  mode: 'append' | 'prepend' | 'reset';
  lines: string[];
  startIndex?: number;
  remaining?: number;
}

export interface SessionBufferState {
  lines: string[];
  scrollbackStartIndex?: number;
  updateKind: 'replace' | 'append' | 'prepend' | 'viewport';
  revision: number;
  remoteSnapshot?: TerminalSnapshot;
}

export interface TerminalRenderBufferProjection {
  lines: string[];
  scrollbackStartIndex?: number;
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
