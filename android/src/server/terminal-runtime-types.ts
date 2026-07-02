import type { WasmBridge } from '@jsonstudio/wtermmod-core';
import type {
  AttachFileStartPayload,
  PasteImageStartPayload,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';

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
  boundSessionId: string | null;
}

export interface PendingBinaryTransfer<TPayload extends { byteLength: number }> {
  payload: TPayload;
  receivedBytes: number;
  chunks: Buffer[];
}

export interface TerminalSession {
  id: string;
  transportId: string;
  transport: TerminalSessionTransport | null;
  closeTransport?: (reason: string) => void;
  sessionName: string;
  mirrorKey: string | null;
  pendingPasteImage: PendingBinaryTransfer<PasteImageStartPayload> | null;
  pendingAttachFile: PendingBinaryTransfer<AttachFileStartPayload> | null;
}

export interface SessionMirror {
  key: string;
  sessionName: string;
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
