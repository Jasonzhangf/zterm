import type { WasmBridge } from '@jsonstudio/wtermmod-core';
import type {
  AttachFileStartPayload,
  PasteImageStartPayload,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';

export interface ClientSessionTransport {
  kind: 'ws' | 'rtc';
  readyState: number;
  sendText: (text: string) => void;
  close: (reason?: string) => void;
  ping?: () => void;
}

export interface TerminalTransportConnection {
  transportId: string;
  transport: ClientSessionTransport;
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

export interface ClientSession {
  id: string;
  clientSessionId: string;
  transportId: string | null;
  readyTransportId: string | null;
  transport: ClientSessionTransport | null;
  closeTransport?: (reason: string) => void;
  transportRequestOrigin: string;
  sessionName: string;
  mirrorKey: string | null;
  wsAlive: boolean;
  pendingPasteImage: PendingBinaryTransfer<PasteImageStartPayload> | null;
  pendingAttachFile: PendingBinaryTransfer<AttachFileStartPayload> | null;
  logicalSessionBound: boolean;
}

export interface SessionMirror {
  key: string;
  sessionName: string;
  scratchBridge: WasmBridge | null;
  lifecycle: 'idle' | 'booting' | 'ready' | 'failed' | 'destroyed';
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  revision: number;
  lastScrollbackCount: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cursor: TerminalCursorState | null;
  lastFlushStartedAt: number;
  lastFlushCompletedAt: number;
  flushInFlight: boolean;
  flushPromise: Promise<boolean> | null;
  liveSyncTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<string>;
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export interface TerminalAttachPayload {
  name: string;
  sessionName: string;
  cols?: number;
  rows?: number;
  autoCommand?: string;
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
