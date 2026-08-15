/**
 * zterm Android 类型定义
 *
 * 基于 android/docs/spec.md 的主机/会话范围定义
 */

import type {
  RelayEndpointCandidate,
  RelayTmuxSessionSnapshot,
} from '@zterm/shared/relay-directory';
import type {
  BridgeClientMessage,
  BridgeServerMessage,
} from '@zterm/shared/protocol';
import type {
  SessionBufferState as SharedSessionBufferState,
  TerminalCursorState,
  TerminalGapRange,
} from '@zterm/shared/types';
import type {
  ConnectionConfigShareQuickAction,
  ConnectionConfigShareShortcutAction,
  WorkspacePane,
  WorkspaceState,
  WorkspaceTab,
} from '@zterm/shared';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { createDefaultShortcutActions } from './terminal-shortcut-actions';

export { DEFAULT_BRIDGE_PORT } from './mobile-config';
import type { Host, TerminalCell, TerminalIndexedLine } from '@zterm/shared/types';
export type { Host, TerminalCell, TerminalIndexedLine };
export type {
  FileUploadCompletePayload,
  FileUploadProgressPayload,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
} from '@zterm/shared/protocol';

// Wire payload truth lives in @zterm/shared (Protocol freeze gate). Re-exports below keep legacy import paths working.
export type {
  AttachFileStartPayload,
  FileCreateDirectoryRequestPayload,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  FileDownloadRequestPayload,
  FileEntry,
  FileListErrorPayload,
  FileListRequestPayload,
  FileListResponsePayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadErrorPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RuntimeDebugLogEntry,
  TransferDirection,
  TransferProgress,
} from '@zterm/shared/protocol';

export type { ScheduleErrorPayload, ScheduleEventPayload, ScheduleJob, ScheduleJobDraft, ScheduleStatePayload, SessionScheduleState } from '@zterm/shared/schedule-types';

// ============================================
// Host 配置
// ============================================

// ============================================
// Session 状态
// ============================================

export type SessionState =
  | 'idle'        // 未连接
  | 'connecting'  // 正在建立连接
  | 'connected'   // 已连接，可交互
  | 'disconnected' // transport 断开，runtime 仍保留，需显式恢复
  | 'reconnecting' // 断线重连中
  | 'error'       // 连接失败
  | 'closed';     // 已关闭

export type {
  HostConfigMessage,
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
  TerminalSessionCapabilitiesPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowInputResultPayload,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowStreamFocusResultPayload,
  RemoteWindowStreamFocusPhase,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamRect,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartRequestPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamStopRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
  RemoteWindowVideoBitratePreset,
} from '@zterm/shared/protocol';
export type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  CompactIndexedLine,
  TerminalBufferPayload,
  TerminalCursorState,
  TerminalGapRange,
  WireIndexedLine,
} from '@zterm/shared/types';

export type TerminalWidthMode = 'adaptive-phone' | 'mirror-fixed';

export interface SessionBufferState extends Omit<SharedSessionBufferState, 'cursor'> {
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

export interface AndroidWorkspaceTab extends WorkspaceTab {
  sessionId: string;
}

export type AndroidWorkspacePane = WorkspacePane<AndroidWorkspaceTab>;
export type AndroidWorkspaceState = WorkspaceState<AndroidWorkspaceTab>;

export interface TerminalLayoutState {
  splitEnabled: boolean;
  splitSecondarySessionId: string | null;
  splitPaneAssignments: Partial<Record<string, TerminalSplitPaneId>>;
}

export interface TerminalViewportState {
  mode: TerminalViewportMode;
  viewportEndIndex: number;
  viewportRows: number;
  missingRanges?: TerminalGapRange[];
}

export interface TerminalVisibleRange {
  startIndex: number;
  endIndex: number;
  viewportRows: number;
}

export interface TerminalViewportSize {
  cols: number;
  rows: number;
}

export type TerminalResizeHandler = (sessionId: string, cols: number, rows: number) => void;
export type TerminalWidthModeHandler = (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
export type TerminalViewportChangeHandler = (sessionId: string, viewState: TerminalViewportState) => void;
export type TerminalVisibleRangeChangeHandler = (sessionId: string, visibleRange: TerminalVisibleRange) => void;

export interface SessionRenderBufferSnapshot {
  lines: TerminalCell[][];
  gapRanges: TerminalGapRange[];
  startIndex: number;
  endIndex: number;
  bufferHeadStartIndex: number;
  bufferTailEndIndex: number;
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
  revision: number;
}

export interface Session {
  id: string;
  hostId: string;
  connectionName: string;    // connection 配置名
  bridgeHost: string;        // 当前连接的 bridge server
  bridgePort: number;        // 当前连接的 bridge port
  daemonHostId?: string;     // daemon 稳定身份；同一 tmux daemon 不因 transport path 改变
  sessionName: string;       // 当前 attach 的 tmux session
  terminalBackend?: 'tmux' | 'herdr';
  authToken?: string;
  autoCommand?: string;
  title: string;             // 动态标题（来自 tmux / 远端 terminal）
  ws: WebSocket | null;
  reliableInputSupported?: boolean;
  resolvedPath?: 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
  resolvedRelayTransport?: 'direct' | 'turn';
  resolvedEndpoint?: string;
  selectedIcePair?: {
    local?: {
      id?: string;
      candidateType?: string;
      address?: string;
      port?: number;
      protocol?: string;
      networkType?: string;
      relayProtocol?: string;
      url?: string;
    };
    remote?: {
      id?: string;
      candidateType?: string;
      address?: string;
      port?: number;
      protocol?: string;
      networkType?: string;
      relayProtocol?: string;
      url?: string;
    };
    roundTripTimeMs?: number;
  };
  lastConnectStage?: string;
  state: SessionState;
  hasUnread: boolean;        // 是否有未读输出
  customName?: string;       // 用户重命名的名称
  reconnectAttempt?: number;
  lastError?: string;
  remoteMissing?: boolean;  // daemon confirms this tmux session no longer exists
  createdAt: number;         // 创建时间戳
}

export interface SessionDebugOverlayMetrics {
  uplinkBps: number;
  downlinkBps: number;
  renderHz: number;
  pullHz: number;
  transportBufferedBytes: number;
  transportBackpressured: boolean;
  lastRenderCommitAt: number;
  bufferPullActive: boolean;
  status: 'waiting' | 'refreshing' | 'loading' | 'reconnecting' | 'error' | 'closed' | 'connecting';
  active: boolean;
  updatedAt: number;
}

export type TwoFingerWheelDebugSnapshot = {
  active: boolean;
  lockedDirection: "up" | "down" | null;
  initialSpanPx: number;
  accumulatedDeltaPx: number;
  lastSentDirection: "up" | "down" | null;
  lastSentAt: number | null;
  startCalls: number;
  moveCalls: number;
  endCalls: number;
  abortedCount: number;
  sentCount: number;
  lastReason: string;
  lastEventAt: number;
};

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
// ============================================
// File Transfer (Epic-007)
// ============================================

export interface FileCreateDirectoryCompletePayload {
  requestId: string;
  path: string;
  name: string;
}

export interface FileCreateDirectoryErrorPayload {
  requestId: string;
  error: string;
}

export interface TraversalRelayUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface TraversalRelayDeviceSnapshot {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  updatedAt: string;
  client: {
    connected: boolean;
    lastSeenAt: string;
  };
  daemon: {
    connected: boolean;
    lastSeenAt: string;
    hostId: string;
    version: string;
    endpoints?: RelayEndpointCandidate[];
    sessions?: RelayTmuxSessionSnapshot[];
  };
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

export type ConfigShareQuickAction = ConnectionConfigShareQuickAction;
export type ConfigShareShortcutAction = ConnectionConfigShareShortcutAction;

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

export interface SessionGroupHistory {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  terminalBackend?: 'tmux' | 'herdr';
  authToken?: string;
  relayEndpointCandidates?: RelayEndpointCandidate[];
  sessionNames: string[];
  missingSessionNames?: string[];
  lastOpenedSessionName?: string;
  lastOpenedAt: number;
}

export interface PersistedOpenTab {
  sessionId: string;
  hostId: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  sessionName: string;
  terminalBackend?: 'tmux' | 'herdr';
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

export type ClientMessage = BridgeClientMessage;
export type ServerMessage = BridgeServerMessage;

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

// Persisted storage key truth lives in @zterm/shared (single source across android/mac/win).
export { STORAGE_KEYS } from '@zterm/shared/types';

// ============================================
// 默认值
// ============================================

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [];

export const DEFAULT_SHORTCUT_ACTIONS: TerminalShortcutAction[] = createDefaultShortcutActions();

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
