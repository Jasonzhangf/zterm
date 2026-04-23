/**
 * zterm Android 类型定义
 *
 * 基于 android/docs/spec.md 的主机/会话范围定义
 */

import type {
  ScheduleEventPayload,
  ScheduleJobDraft,
  ScheduleStatePayload,
} from '@zterm/shared';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';

export { DEFAULT_BRIDGE_PORT } from './mobile-config';
export type { ScheduleEventPayload, ScheduleJob, ScheduleJobDraft, ScheduleStatePayload, SessionScheduleState } from '@zterm/shared';

// ============================================
// Host 配置
// ============================================

export interface Host {
  id: string;
  createdAt: number;        // 创建时间戳
  name: string;
  bridgeHost: string;        // Bridge 主机地址（IP / Tailscale 域名 / ws URL）
  bridgePort: number;        // Bridge 端口，默认取统一配置
  sessionName: string;       // tmux session 名，留空时回退到 name
  authToken?: string;        // daemon / websocket bridge 鉴权 token
  authType: 'password' | 'key';
  password?: string;         // 暂不加密存储
  privateKey?: string;       // 暂不加密存储
  tags: string[];            // 分组标签
  pinned: boolean;           // 是否置顶首页
  lastConnected?: number;    // 最后连接时间戳
  autoCommand?: string;      // 连接后自动执行的命令
}

// ============================================
// Session 状态
// ============================================

export type SessionState =
  | 'idle'        // 未连接
  | 'connecting'  // 正在建立连接
  | 'connected'   // 已连接，可交互
  | 'reconnecting' // 断线重连中
  | 'error'       // 连接失败
  | 'closed';     // 已关闭

export interface TerminalGapRange {
  startIndex: number;
  endIndex: number;
}

export interface SessionBufferState {
  lines: TerminalCell[][];          // sparse cached window rows; gap rows are [] and described by gapRanges
  gapRanges: TerminalGapRange[];    // absolute missing spans inside [startIndex, endIndex)
  startIndex: number;               // absolute index for the first locally cached row
  endIndex: number;                 // exclusive absolute index for the last locally cached row
  viewportEndIndex: number;         // exclusive absolute row index for viewport tail
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  updateKind: 'replace' | 'append' | 'prepend' | 'patch';
  revision: number;
}

export interface Session {
  id: string;
  hostId: string;
  connectionName: string;    // connection 配置名
  bridgeHost: string;        // 当前连接的 bridge server
  bridgePort: number;        // 当前连接的 bridge port
  sessionName: string;       // 当前 attach 的 tmux session
  authToken?: string;
  autoCommand?: string;
  title: string;             // 动态标题（来自 tmux / 远端 terminal）
  ws: WebSocket | null;
  state: SessionState;
  hasUnread: boolean;        // 是否有未读输出
  customName?: string;       // 用户重命名的名称
  buffer: SessionBufferState;
  reconnectAttempt?: number;
  lastError?: string;
  createdAt: number;         // 创建时间戳
}

export interface TerminalCell {
  char: number;
  fg: number;
  bg: number;
  flags: number;
  width: number; // 0=continuation, 1=single, 2=double-width lead
}

export interface TerminalIndexedLine {
  index: number;
  cells: TerminalCell[];
}

export interface TerminalBufferPayload {
  revision: number;
  startIndex: number;               // authoritative available window start on daemon
  endIndex: number;                 // authoritative available window end on daemon (exclusive)
  viewportEndIndex: number;         // authoritative viewport end absolute row
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  lines: TerminalIndexedLine[];     // concrete rows carried by this message; may be full window or subset
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

export interface PasteImagePayload {
  name: string;
  mimeType: string;
  dataBase64: string;
  pasteSequence?: string;
}

export interface PasteImageStartPayload {
  name: string;
  mimeType: string;
  byteLength: number;
  pasteSequence?: string;
}

export interface RuntimeDebugLogEntry {
  seq: number;
  ts: string;
  scope: string;
  payload?: string;
}

// ============================================
// 快捷键配置
// ============================================

export interface QuickAction {
  id: string;
  label: string;             // 显示名称，如 "git status"
  sequence: string;          // 保存好的字符串文本，点击后原样注入
  order: number;             // 排序顺序
}

export interface TerminalShortcutAction {
  id: string;
  label: string;
  sequence: string;
  order: number;
  row: 'top-scroll' | 'bottom-scroll';
}

export type SessionDraftMap = Record<string, string>;

// ============================================
// WebDAV 配置
// ============================================

export interface WebDAVConfig {
  url: string;
  username: string;
  password?: string;
  enabled: boolean;
  syncInterval: number;      // 同步间隔（毫秒），默认 30分钟
}

export interface SessionHistoryEntry {
  id: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
  lastOpenedAt: number;
}

export interface SessionGroupHistory {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
  sessionNames: string[];
  lastOpenedAt: number;
}

export interface PersistedOpenTab {
  sessionId: string;
  hostId: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
  autoCommand?: string;
  customName?: string;
  createdAt: number;
}

export interface SavedTabList {
  id: string;
  name: string;
  tabs: PersistedOpenTab[];
  activeSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================
// 命令历史
// ============================================

export interface CommandHistory {
  id: string;
  hostId: string;
  autoCommand: string;
  executedAt: number;
}

// ============================================
// WebSocket 消息协议
// ============================================

export type ClientMessage =
  | { type: 'connect'; payload: HostConfigMessage }
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

export type ServerMessage =
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
  | { type: 'data'; payload: string }
  | { type: 'buffer-sync'; payload: TerminalBufferPayload }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

// 用于 WebSocket 传输的 Host 配置（不含敏感信息的长期存储）
export interface HostConfigMessage {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  cols?: number;
  rows?: number;
  authToken?: string;
  autoCommand?: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
}

// ============================================
// Event 定义（Observability）
// ============================================

export type SessionEventType =
  | 'session_started'
  | 'session_connected'
  | 'session_failed'
  | 'session_closed'
  | 'session_reconnecting'
  | 'input_sent'
  | 'output_received';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: number;
  payload?: {
    message?: string;
    error?: Error;
    data?: string;
  };
}

// ============================================
// App 状态（运行时）
// ============================================

export interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  hosts: Host[];
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  webdavConfig: WebDAVConfig | null;
}

// ============================================
// 存储键名
// ============================================

export const STORAGE_KEYS = {
  HOSTS: 'zterm:hosts',
  BRIDGE_SETTINGS: 'zterm:bridge-settings',
  SESSION_HISTORY: 'zterm:session-history',
  SESSION_GROUPS: 'zterm:session-groups',
  OPEN_TABS: 'zterm:open-tabs',
  SAVED_TAB_LISTS: 'zterm:saved-tab-lists',
  QUICK_ACTIONS: 'zterm:quick-actions',
  SHORTCUT_ACTIONS: 'zterm:shortcut-actions',
  SESSION_DRAFTS: 'zterm:session-drafts',
  WEBDAV_CONFIG: 'zterm:webdav-config',
  COMMAND_HISTORY: 'zterm:command-history',
  ACTIVE_SESSION: 'zterm:active-session',
  ACTIVE_PAGE: 'zterm:active-page',
} as const;

// ============================================
// 默认值
// ============================================

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [];

export const DEFAULT_SHORTCUT_ACTIONS: TerminalShortcutAction[] = [
  { id: 'shortcut-continue', label: '继续', sequence: '继续执行\r', order: 0, row: 'top-scroll' },
  { id: 'shortcut-esc', label: 'Esc', sequence: '\x1b', order: 1, row: 'top-scroll' },
  { id: 'shortcut-backspace', label: 'Bksp', sequence: '\x7f', order: 2, row: 'top-scroll' },
  { id: 'shortcut-paste', label: 'Paste', sequence: '\x16', order: 3, row: 'top-scroll' },
  { id: 'shortcut-tab', label: 'Tab', sequence: '\t', order: 0, row: 'bottom-scroll' },
  { id: 'shortcut-enter', label: 'Enter', sequence: '\r', order: 1, row: 'bottom-scroll' },
  { id: 'shortcut-space', label: 'Space', sequence: ' ', order: 2, row: 'bottom-scroll' },
  { id: 'shortcut-shift-tab', label: 'S-Tab', sequence: '\x1b[Z', order: 3, row: 'bottom-scroll' },
  { id: 'shortcut-shift-enter', label: 'S-Enter', sequence: '\n', order: 4, row: 'bottom-scroll' },
];

export const DEFAULT_WEBDAV_CONFIG: WebDAVConfig = {
  url: '',
  username: '',
  password: '',
  enabled: false,
  syncInterval: 30 * 60 * 1000, // 30 分钟
};

export const DEFAULT_HOST: Partial<Host> = {
  bridgePort: DEFAULT_BRIDGE_PORT,
  sessionName: '',
  authToken: '',
  authType: 'password',
  tags: [],
  pinned: false,
};
