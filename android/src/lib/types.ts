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
  tailscaleHost?: string;
  ipv6Host?: string;
  ipv4Host?: string;
  signalUrl?: string;
  transportMode?: 'auto' | 'websocket' | 'webrtc';
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

export interface TerminalCursorState {
  rowIndex: number;   // absolute buffer row index
  col: number;        // grid column inside the row
  visible: boolean;
}

export type TerminalWidthMode = 'adaptive-phone' | 'mirror-fixed';

export interface SessionBufferState {
  lines: TerminalCell[][];          // sparse cached window rows; gap rows are [] and described by gapRanges
  gapRanges: TerminalGapRange[];    // absolute missing spans inside [startIndex, endIndex)
  startIndex: number;               // absolute index for the first locally cached row
  endIndex: number;                 // exclusive absolute index for the last locally cached row
  bufferHeadStartIndex: number;     // authoritative available buffer head start on daemon
  bufferTailEndIndex: number;       // exclusive absolute row index for local buffer tail / follow anchor
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
  updateKind: 'replace' | 'append' | 'prepend' | 'patch';
  revision: number;
}

export type TerminalViewportMode = 'follow' | 'reading';
export type TerminalSplitPaneId = 'primary' | 'secondary';

export interface TerminalLayoutState {
  splitEnabled: boolean;
  splitSecondarySessionId: string | null;
  splitPaneAssignments: Partial<Record<string, TerminalSplitPaneId>>;
}

export interface TerminalViewportState {
  mode: TerminalViewportMode;
  viewportEndIndex: number;
  viewportRows: number;
}

export interface TerminalViewportSize {
  cols: number;
  rows: number;
}

export type TerminalResizeHandler = (sessionId: string, cols: number, rows: number) => void;
export type TerminalWidthModeHandler = (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
export type TerminalViewportChangeHandler = (sessionId: string, viewState: TerminalViewportState) => void;

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
  resolvedPath?: 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-direct' | 'rtc-relay';
  resolvedEndpoint?: string;
  lastConnectStage?: string;
  state: SessionState;
  hasUnread: boolean;        // 是否有未读输出
  customName?: string;       // 用户重命名的名称
  buffer: SessionBufferState;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
  reconnectAttempt?: number;
  lastError?: string;
  createdAt: number;         // 创建时间戳
}

export interface SessionDebugOverlayMetrics {
  uplinkBps: number;
  downlinkBps: number;
  renderHz: number;
  pullHz: number;
  bufferPullActive: boolean;
  status: 'waiting' | 'refreshing' | 'loading' | 'reconnecting' | 'error' | 'closed' | 'connecting';
  updatedAt: number;
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

/**
 * Compact wire format for a single line.
 * Replaces TerminalIndexedLine on the wire to cut payload size ~95%.
 *
 *   i = absolute line index
 *   t = text content (codePoints, width-0 continuation cells skipped, padding stripped)
 *   w = optional width per codepoint in t (omitted = all 1; needed for CJK double-width)
 *   s = optional sparse style spans [startCol, endCol, fg, bg, flags]
 *       absent or empty = all default (fg=256, bg=256, flags=0, width=1)
 */
export interface CompactIndexedLine {
  i: number;
  t: string;
  w?: number[];
  s?: [number, number, number, number, number][];
}

/** Wire format: either compact (new) or legacy full-cell (old). */
export type WireIndexedLine = CompactIndexedLine | TerminalIndexedLine;

export interface TerminalBufferPayload {
  revision: number;
  startIndex: number;               // authoritative available window start on daemon
  endIndex: number;                 // authoritative available window end on daemon (exclusive)
  availableStartIndex?: number;     // authoritative daemon buffer head start (independent from sparse payload window)
  availableEndIndex?: number;       // authoritative daemon buffer tail end (independent from sparse payload window)
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor?: TerminalCursorState | null;
  lines: WireIndexedLine[];         // concrete rows carried by this message; compact preferred, legacy accepted
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
  cursor?: TerminalCursorState | null;
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

export interface AttachFileStartPayload {
  name: string;
  mimeType: string;
  byteLength: number;
}

// ============================================
// File Transfer (Epic-007)
// ============================================

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
}

export type TransferDirection = 'upload' | 'download';

export interface TransferProgress {
  id: string;
  fileName: string;
  direction: TransferDirection;
  totalBytes: number;
  transferredBytes: number;
  status: 'pending' | 'transferring' | 'done' | 'error';
  error?: string;
}

export interface FileCreateDirectoryRequestPayload {
  requestId: string;
  path: string;
  name: string;
}

export interface FileCreateDirectoryCompletePayload {
  requestId: string;
  path: string;
  name: string;
}

export interface FileCreateDirectoryErrorPayload {
  requestId: string;
  error: string;
}

export interface FileListRequestPayload {
  requestId: string;
  path: string;
  showHidden: boolean;
}

export interface FileListResponsePayload {
  requestId: string;
  path: string;
  parentPath: string | null;
  entries: FileEntry[];
}

export interface FileListErrorPayload {
  requestId: string;
  error: string;
}

export interface FileDownloadRequestPayload {
  requestId: string;
  remotePath: string;
  fileName: string;
  totalBytes: number;
}

export interface RemoteScreenshotRequestPayload {
  requestId: string;
}

export interface RemoteScreenshotStatusPayload {
  requestId: string;
  phase: 'capturing' | 'transferring';
  fileName?: string;
  receivedChunks?: number;
  totalChunks?: number;
  totalBytes?: number;
}

export interface RemoteScreenshotCapture {
  fileName: string;
  mimeType: 'image/png';
  dataBase64: string;
  dataBytes?: Uint8Array;
  totalBytes: number;
}

export interface FileDownloadChunkPayload {
  requestId: string;
  chunkIndex: number;
  totalChunks: number;
  fileName: string;
  dataBase64: string;
}

export interface FileDownloadCompletePayload {
  requestId: string;
  fileName: string;
  totalBytes: number;
}

export interface FileDownloadErrorPayload {
  requestId: string;
  error: string;
}

export interface FileUploadStartPayload {
  requestId: string;
  targetDir: string;
  fileName: string;
  fileSize: number;
  chunkCount: number;
}

export interface FileUploadChunkPayload {
  requestId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface FileUploadEndPayload {
  requestId: string;
}

export interface FileUploadProgressPayload {
  requestId: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface FileUploadCompletePayload {
  requestId: string;
  filePath: string;
  bytes: number;
}

export interface FileUploadErrorPayload {
  requestId: string;
  error: string;
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
  | { type: 'session-open'; payload: HostConfigMessage }
  | { type: 'connect'; payload: HostConfigMessage }
  | { type: 'buffer-head-request' }
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
  | { type: 'attach-file-start'; payload: AttachFileStartPayload }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'terminal-width-mode'; payload: { mode: TerminalWidthMode; cols?: number } }
  | { type: 'file-list-request'; payload: FileListRequestPayload }
  | { type: 'file-download-request'; payload: FileDownloadRequestPayload }
  | { type: 'remote-screenshot-request'; payload: RemoteScreenshotRequestPayload }
  | { type: 'file-upload-start'; payload: FileUploadStartPayload }
  | { type: 'file-upload-chunk'; payload: FileUploadChunkPayload }
  | { type: 'file-upload-end'; payload: FileUploadEndPayload }
  | { type: 'ping' }
  | { type: 'close' };

export type ServerMessage =
  | {
      type: 'session-ticket';
      payload: {
        clientSessionId: string;
        sessionTransportToken: string;
        sessionName: string;
      };
    }
  | {
      type: 'session-open-failed';
      payload: {
        clientSessionId: string;
        message: string;
        code?: string;
      };
    }
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
  | { type: 'buffer-head'; payload: BufferHeadPayload }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'buffer-sync'; payload: TerminalBufferPayload }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'debug-control'; payload: { enabled: boolean; reason?: string } }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'file-attached'; payload: { name: string; path: string; bytes: number } }
  | { type: 'file-list-response'; payload: FileListResponsePayload }
  | { type: 'file-list-error'; payload: FileListErrorPayload }
  | { type: 'remote-screenshot-status'; payload: RemoteScreenshotStatusPayload }
  | { type: 'file-download-chunk'; payload: FileDownloadChunkPayload }
  | { type: 'file-download-complete'; payload: FileDownloadCompletePayload }
  | { type: 'file-download-error'; payload: FileDownloadErrorPayload }
  | { type: 'file-upload-progress'; payload: FileUploadProgressPayload }
  | { type: 'file-upload-complete'; payload: FileUploadCompletePayload }
  | { type: 'file-upload-error'; payload: FileUploadErrorPayload }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

// 用于 WebSocket 传输的 Host 配置（不含敏感信息的长期存储）
export interface HostConfigMessage {
  clientSessionId: string;
  sessionTransportToken?: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  cols?: number;
  rows?: number;
  terminalWidthMode?: TerminalWidthMode;
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
  TERMINAL_LAYOUT: 'zterm:terminal-layout',
  SHORTCUT_FREQUENCY: 'zterm:shortcut-frequency',
} as const;

// ============================================
// 默认值
// ============================================

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [];

export const DEFAULT_SHORTCUT_ACTIONS: TerminalShortcutAction[] = [
  { id: 'shortcut-esc', label: 'Esc', sequence: '\x1b', order: 0, row: 'top-scroll' },
  { id: 'shortcut-backspace', label: 'Bksp', sequence: '\x7f', order: 1, row: 'top-scroll' },
  { id: 'shortcut-tab', label: 'Tab', sequence: '\t', order: 2, row: 'top-scroll' },
  { id: 'shortcut-enter', label: 'Enter', sequence: '\r', order: 3, row: 'top-scroll' },
  { id: 'shortcut-space', label: 'Space', sequence: ' ', order: 4, row: 'top-scroll' },
  { id: 'shortcut-continue', label: '继续', sequence: '继续执行\r', order: 0, row: 'bottom-scroll' },
  { id: 'shortcut-paste', label: 'Paste', sequence: '\x16', order: 1, row: 'bottom-scroll' },
  { id: 'shortcut-shift-tab', label: 'S-Tab', sequence: '\x1b[Z', order: 2, row: 'bottom-scroll' },
  { id: 'shortcut-shift-enter', label: 'S-Enter', sequence: '\n', order: 3, row: 'bottom-scroll' },
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
  tailscaleHost: '',
  ipv6Host: '',
  ipv4Host: '',
  signalUrl: '',
  transportMode: 'auto',
  authType: 'password',
  tags: [],
  pinned: false,
};
