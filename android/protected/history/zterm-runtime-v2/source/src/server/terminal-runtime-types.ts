import type { WasmBridge } from '@jsonstudio/wtermmod-core';
import type {
  AttachFileStartPayload,
  PasteImageStartPayload,
} from '@zterm/shared/protocol';
import type {
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';

export interface TerminalSessionTransport {
  kind: 'ws' | 'rtc';
  readyState: number;
  bufferedAmount?: number;
  lastSendAt?: number;
  lastSendBytes?: number;
  totalSendBytes?: number;
  lastSendError?: string | null;
  backpressureCount?: number;
  sendText: (text: string) => void;
  close: (reason?: string) => void;
  ping?: () => void;
  requestOrigin?: string;
  connectedSent?: boolean;
}

export interface TerminalTransportConnection {
  transportId: string;
  transport: TerminalSessionTransport;
  closeTransport: (reason: string) => void;
  requestOrigin: string;
  role: 'pending' | 'control' | 'session';
  boundSubscriberId: string | null;
  muxVersion?: number;
  muxClientInstanceId?: string | null;
  muxChannels?: Map<string, string>;
}

export interface PendingBinaryTransfer<TPayload extends { byteLength: number }> {
  payload: TPayload;
  receivedBytes: number;
  chunks: Buffer[];
}

export interface TerminalAbsoluteRange {
  startIndex: number;
  endIndex: number;
}

export type TerminalSubscriberBufferSyncResyncReason =
  | 'range-count'
  | 'span-lines'
  | 'age'
  | 'transport-generation';

export interface TerminalSubscriberBufferSyncState {
  lastSentRevision: number;
  pendingLatestRevision: number | null;
  pendingChangedAbsoluteRanges: TerminalAbsoluteRange[];
  pendingSince: number;
  pendingTransportId: string | null;
  highWaterActive: boolean;
  highWaterEnteredAt: number;
  resyncRequired: boolean;
  resyncReason: TerminalSubscriberBufferSyncResyncReason | null;
}

export interface TerminalTransportSubscriber {
  id: string;
  transportId: string;
  transport: TerminalSessionTransport | null;
  closeTransport?: (reason: string) => void;
  connectedSent?: boolean;
  muxChannelId?: string | null;
  muxParentTransportId?: string | null;
  sessionName: string;
  backend?: 'tmux' | 'herdr';
  mirrorKey: string | null;
  bodySubscribed?: boolean;
  adaptiveWidthCols?: number | null;
  adaptiveWidthRows?: number | null;
  adaptiveWidthHeartbeatAt?: number;
  pendingPasteImage: PendingBinaryTransfer<PasteImageStartPayload> | null;
  pendingAttachFile: PendingBinaryTransfer<AttachFileStartPayload> | null;
  bufferSyncState?: TerminalSubscriberBufferSyncState;
}

export type TerminalSession = TerminalTransportSubscriber;

export interface SessionMirror {
  key: string;
  sessionName: string;
  backend?: 'tmux' | 'herdr';
  scratchBridge: WasmBridge | null;
  lifecycle: 'idle' | 'booting' | 'ready' | 'failed' | 'destroyed';
  cols: number;
  rows: number;
  baselineCols?: number;
  baselineRows?: number;
  consecutiveFailures: number;
  cursorKeysApp: boolean;
  revision: number;
  lastScrollbackCount: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cursor: TerminalCursorState | null;
  lastFlushStartedAt: number;
  lastFlushCompletedAt: number;
  lastLiveActivityAt: number;
  // R14: last time a head payload was broadcast to any subscriber of this mirror.
  lastHeadBroadcastAt: number;
  lastCaptureDurationMs?: number;
  lastCanonicalizeDurationMs?: number;
  flushInFlight: boolean;
  flushPromise: Promise<boolean> | null;
  // Quiet-capture backoff: consecutive flushes with no content change push the
  // next live-sync capture out (33ms active -> up to 500ms), so an idle
  // terminal stops paying a full 1305-line tmux capture every 33ms.
  quietFlushStreak: number;
  lastFlushHadContentChanges: boolean;
  pendingStableCaptureSnapshot?: {
    rows: number;
    cols: number;
    cursorKeysApp: boolean;
    lastScrollbackCount: number;
    bufferStartIndex: number;
    bufferLines: TerminalCell[][];
    cursor: TerminalCursorState | null;
    capturedLineCount: number;
    canonicalLineCount: number;
    totalAvailableLines: number;
    visibleTopIndex: number;
  } | null;
  pendingPerformanceTraceCapture?: {
    captureStartedAt: number;
    captureDoneAt: number;
    canonicalizeDoneAt: number;
    capturedLineCount: number;
    canonicalLineCount: number;
  } | null;
  adaptiveWidthBaselineGeometry?: {
    cols: number;
    rows: number;
  } | null;
  adaptiveWidthAppliedCols?: number | null;
  adaptiveWidthAppliedRows?: number | null;
  adaptiveWidthLeaseTimer?: ReturnType<typeof setTimeout> | null;
  liveSyncTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<string>;
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export type TerminalWidthMode = 'adaptive-phone' | 'mirror-fixed';

export interface TerminalAttachPayload {
  sessionName: string;
  backend?: 'tmux' | 'herdr';
  cols?: number;
  rows?: number;
  autoCommand?: string;
  widthMode?: TerminalWidthMode;
}

export interface TmuxPaneMetrics {
  paneId: string;
  tmuxAvailableLineCountHint: number;
  paneRows: number;
  paneCols: number;
  alternateOn: boolean;
}

export interface TmuxCursorState {
  col: number;
  row: number;
  visible: boolean;
  cursorKeysApp: boolean;
}
