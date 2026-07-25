import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  TerminalBufferPayload,
} from './types';
import type { ScheduleErrorPayload, ScheduleEventPayload, ScheduleJobDraft, ScheduleStatePayload } from '../schedule/types';
import type { TerminalWidthMode } from './bridge-settings';

// ─── Remote screenshot / file transfer types ───

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
  totalChunks?: number;
}

export interface FileUploadCompletePayload {
  requestId: string;
  filePath?: string;
  bytes?: number;
}

export interface FileUploadErrorPayload {
  requestId: string;
  error: string;
}

export interface RemoteScreenshotRequestPayload {
  requestId: string;
  target?: {
    kind: 'remote-window';
    target: RemoteWindowStreamTargetManifest;
  };
}

export interface RemoteScreenshotStatusPayload {
  requestId: string;
  phase: 'capturing' | 'transferring' | 'failed';
  fileName?: string;
  receivedChunks?: number;
  totalChunks?: number;
  totalBytes?: number;
  errorMessage?: string;
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

export interface RemoteScreenshotCapture {
  fileName: string;
  mimeType: 'image/png';
  dataBase64: string;
  dataBytes?: Uint8Array;
  totalBytes: number;
}

// ─── Remote window stream target catalog types ───

export interface RemoteWindowStreamRequestPayload {
  requestId: string;
  includeAppWindows?: boolean;
  includeIterm2?: boolean;
  forceRefresh?: boolean;
}

export interface RemoteWindowStreamRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RemoteWindowStreamTargetManifest {
  streamTargetId: string;
  videoTarget: {
    kind: 'app-window' | 'iterm2-pane';
    appBundleId: string;
    pid: number;
    windowId: string;
    title: string;
    windowBoundsTopLeftPx: RemoteWindowStreamRect;
    paneRectInContentPx?: RemoteWindowStreamRect;
    cropRectTopLeftPx?: RemoteWindowStreamRect;
    contentTopInsetPx?: number;
  };
  inputTarget: {
    kind: 'app-window' | 'iterm2-pane' | 'tmux-pane';
    itermSessionId?: string;
    tty?: string;
    tmuxSession?: string;
    tmuxWindowId?: string;
    tmuxPaneId?: string;
  };
  streamMode: 'view' | 'interactive';
  focusPolicy: 'bring-to-focus' | 'no-focus-steal';
  inputRoute: 'os-event' | 'iterm2-api' | 'tmux-input';
  capture: {
    source: 'ScreenCaptureKit';
    coordinateSpace: 'macos-top-left-px';
    displayId?: string;
    displayBoundsTopLeftPx?: RemoteWindowStreamRect;
    scale: number;
    createdAt: string;
  };
}

export interface RemoteWindowStreamTargetsResponsePayload {
  requestId: string;
  targets: RemoteWindowStreamTargetManifest[];
  errors?: RemoteWindowStreamErrorPayload[];
}

export interface RemoteWindowStreamErrorPayload {
  requestId: string;
  streamId?: string;
  code: string;
  message: string;
}

export interface RemoteWindowStreamRtcDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface RemoteWindowStreamIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type RemoteWindowVideoBitratePreset =
  | '2mbps'
  | '5mbps'
  | '10mbps'
  | '20mbps'
  | 'fullscreen';

export interface RemoteWindowVideoBitrateConfig {
  preset: RemoteWindowVideoBitratePreset;
  bitrateMbps: 2 | 5 | 10 | 20;
  maxBitrateBps: number;
  maxFrameRateFps?: 5 | 8 | 10 | 12 | 15 | 30 | 60;
}

export interface RemoteWindowStreamStartRequestPayload {
  requestId: string;
  streamId: string;
  target: RemoteWindowStreamTargetManifest;
  offer: RemoteWindowStreamRtcDescription;
  iceServers?: Array<Record<string, unknown>>;
  videoBitrate?: RemoteWindowVideoBitrateConfig;
}

export interface RemoteWindowStreamStartedPayload {
  requestId: string;
  streamId: string;
  targetId: string;
  answer: RemoteWindowStreamRtcDescription;
  capture: {
    source: 'ScreenCaptureKit';
    frameWidth: number;
    frameHeight: number;
    frameRate: number;
    maxBitrateBps?: number;
    targetKind: 'app-window' | 'iterm2-pane';
  };
  transport: {
    kind: 'webrtc-video';
    selectedRoute?: string;
  };
}

export interface RemoteWindowStreamIceCandidatePayload {
  requestId?: string;
  streamId: string;
  candidate: RemoteWindowStreamIceCandidate;
}

export interface RemoteWindowStreamStatusPayload {
  requestId?: string;
  streamId: string;
  phase: 'starting' | 'streaming' | 'stopped';
  framesSent?: number;
  frameWidth?: number;
  frameHeight?: number;
  message?: string;
}

export interface RemoteWindowStreamStopRequestPayload {
  requestId: string;
  streamId: string;
}

export interface RemoteWindowStreamQualityRequestPayload {
  requestId: string;
  streamId: string;
  targetId: string;
  videoBitrate: RemoteWindowVideoBitrateConfig;
}

export interface RemoteWindowStreamQualityResultPayload {
  requestId: string;
  streamId: string;
  targetId: string;
  accepted: boolean;
  videoBitrate: RemoteWindowVideoBitrateConfig;
}

export interface RemoteWindowInputEventPayload {
  requestId: string;
  streamId: string;
  targetId: string;
  clientSentAt?: number;
  event:
    | {
        kind: 'focus';
      }
    | {
        kind: 'pointer';
        phase: 'move' | 'down' | 'up';
        pointerId: number;
        button: 'left' | 'middle' | 'right' | 'none';
        buttons: number;
        x: number;
        y: number;
        normalizedX: number;
        normalizedY: number;
      }
    | {
        kind: 'click';
        pointerId: number;
        button: 'left' | 'middle' | 'right';
        x: number;
        y: number;
        normalizedX: number;
        normalizedY: number;
        clickCount?: number;
      }
    | {
        kind: 'scroll';
        unit: 'pixel';
        deltaX: number;
        deltaY: number;
        x: number;
        y: number;
        normalizedX: number;
        normalizedY: number;
      }
    | {
        kind: 'gesture';
        gesture: 'swipe';
        phase: 'end';
        unit: 'pixel';
        pointerId: number;
        startX: number;
        startY: number;
        x: number;
        y: number;
        startNormalizedX: number;
        startNormalizedY: number;
        normalizedX: number;
        normalizedY: number;
        deltaX: number;
        deltaY: number;
        durationMs: number;
        velocityX: number;
        velocityY: number;
      }
    | {
        kind: 'window-resize';
        width: number;
        height: number;
      }
    | {
        kind: 'key';
        phase: 'down' | 'up';
        key: string;
        code: string;
        text?: string;
        repeat?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
      };
}

export interface RemoteWindowInputResultPayload {
  requestId: string;
  streamId: string;
  targetId: string;
  accepted: boolean;
}

export interface TerminalReliableInputPayload {
  version: 1;
  seq: string;
  data: string;
  sentAt: number;
  attempt: number;
}

export interface TerminalInputAckPayload {
  version: 1;
  seq: string;
  accepted: boolean;
  bytes: number;
  error?: string;
}

export interface TerminalSessionCapabilitiesPayload {
  reliableInput?: {
    version: 1;
  };
}

export interface HostConfigMessage {
  /**
   * Client-generated one-shot request identity for the control -> session attach handshake.
   * It exists only so the client can match `session-ticket` / `session-open-failed` replies
   * back to its local open intent. It is not daemon-owned business truth.
   */
  openRequestId: string;
  /**
   * Legacy client-owned session identity kept only for wire compatibility with
   * pre-openRequestId clients. Daemon must not promote it into daemon-owned
   * business truth.
   */
  clientSessionId?: string;
  /**
   * One-shot attach proof for the second phase of the transport handshake.
   * It is opaque wire material, not daemon-owned business truth.
   */
  sessionTransportToken?: string;
  sessionName: string;
  cols?: number;
  rows?: number;
  widthMode?: TerminalWidthMode;
  autoCommand?: string;
}

export interface PasteImageStartPayload {
  name: string;
  mimeType: string;
  byteLength: number;
  pasteSequence?: string;
  pasteTarget?: {
    kind: 'remote-window';
    streamId: string;
    targetId: string;
  };
}

export interface PasteImagePayload {
  name: string;
  mimeType: string;
  dataBase64: string;
  pasteSequence?: string;
  pasteTarget?: {
    kind: 'remote-window';
    streamId: string;
    targetId: string;
  };
}

export interface AttachFileStartPayload {
  name: string;
  mimeType: string;
  byteLength: number;
}

export type BridgeClientMessage =
  | { type: 'session-open'; payload: HostConfigMessage }
  | { type: 'connect'; payload: HostConfigMessage }
  | { type: 'resize'; payload: { cols?: number; rows?: number; widthMode?: TerminalWidthMode } }
  | { type: 'body-subscription'; payload: { version: 1; subscribed: boolean } }
  | { type: 'buffer-head-request' }
  | { type: 'buffer-sync-request'; payload: BufferSyncRequestPayload }
  | { type: 'debug-log'; payload: { entries: Array<{ seq: number; ts: string; scope: string; payload?: string }> } }
  | { type: 'debug-snapshot'; payload: { snapshot: unknown } }
  | { type: 'list-sessions' }
  | { type: 'schedule-list'; payload: { sessionName: string } }
  | { type: 'schedule-upsert'; payload: { job: ScheduleJobDraft } }
  | { type: 'schedule-delete'; payload: { jobId: string } }
  | { type: 'schedule-toggle'; payload: { jobId: string; enabled: boolean } }
  | { type: 'schedule-run-now'; payload: { jobId: string } }
  | { type: 'tmux-create-session'; payload: { sessionName: string; cwd?: string } }
  | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string } }
  | { type: 'tmux-kill-session'; payload: { sessionName: string } }
  | { type: 'input'; payload: string | TerminalReliableInputPayload }
  | { type: 'paste-image-start'; payload: PasteImageStartPayload }
  | { type: 'paste-image'; payload: PasteImagePayload }
  | { type: 'attach-file-start'; payload: AttachFileStartPayload }
  | { type: 'remote-screenshot-request'; payload: RemoteScreenshotRequestPayload }
  | { type: 'remote-window-targets-request'; payload: RemoteWindowStreamRequestPayload }
  | { type: 'remote-window-stream-start-request'; payload: RemoteWindowStreamStartRequestPayload }
  | { type: 'remote-window-stream-ice-candidate'; payload: RemoteWindowStreamIceCandidatePayload }
  | { type: 'remote-window-stream-stop-request'; payload: RemoteWindowStreamStopRequestPayload }
  | { type: 'remote-window-stream-quality-request'; payload: RemoteWindowStreamQualityRequestPayload }
  | { type: 'remote-window-input'; payload: RemoteWindowInputEventPayload }
  | { type: 'file-list-request'; payload: FileListRequestPayload }
  | { type: 'file-create-directory-request'; payload: { requestId: string; path: string; name: string } }
  | { type: 'file-download-request'; payload: FileDownloadRequestPayload }
  | { type: 'file-upload-start'; payload: FileUploadStartPayload }
  | { type: 'file-upload-chunk'; payload: FileUploadChunkPayload }
  | { type: 'file-upload-end'; payload: FileUploadEndPayload }
  | { type: 'ping' }
  | { type: 'close' };

export type BridgeBufferMessage =
  | { type: 'buffer-sync'; payload: TerminalBufferPayload };

export type BridgeServerControlMessage =
  | {
      /**
       * Compatibility-only control reply for opening a session transport.
       * The payload may be echoed back by the client, but it must not become
       * daemon-side client/session state truth.
       */
      type: 'session-ticket';
      payload: {
        openRequestId: string;
        clientSessionId?: string;
        sessionTransportToken: string;
        sessionName: string;
      };
    }
  | {
      /**
       * Compatibility-only handshake failure for the two-phase attach flow.
       */
      type: 'session-open-failed';
      payload: {
        openRequestId: string;
        clientSessionId?: string;
        message: string;
        code?: string;
      };
    }
  | {
      type: 'connected';
      payload: {
        sessionId: string;
        daemonHostId?: string;
        capabilities?: TerminalSessionCapabilitiesPayload;
        appUpdate?: {
          versionCode: number;
          versionName: string;
          manifestUrl?: string;
        };
      };
    }
  | { type: 'buffer-head'; payload: BufferHeadPayload }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'schedule-error'; payload: ScheduleErrorPayload }
  | { type: 'debug-control'; payload: { enabled: boolean; reason?: string } }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'file-attached'; payload: { name: string; path: string; bytes: number } }
  | { type: 'file-create-directory-complete'; payload: { requestId: string; path: string; name: string } }
  | { type: 'file-create-directory-error'; payload: { requestId: string; error: string } }
  | { type: 'remote-screenshot-status'; payload: RemoteScreenshotStatusPayload }
  | { type: 'remote-window-targets-response'; payload: RemoteWindowStreamTargetsResponsePayload }
  | { type: 'remote-window-stream-started'; payload: RemoteWindowStreamStartedPayload }
  | { type: 'remote-window-stream-ice-candidate'; payload: RemoteWindowStreamIceCandidatePayload }
  | { type: 'remote-window-stream-status'; payload: RemoteWindowStreamStatusPayload }
  | { type: 'remote-window-stream-quality-result'; payload: RemoteWindowStreamQualityResultPayload }
  | { type: 'remote-window-input-result'; payload: RemoteWindowInputResultPayload }
  | { type: 'input-ack'; payload: TerminalInputAckPayload }
  | { type: 'remote-window-error'; payload: RemoteWindowStreamErrorPayload }
  | { type: 'file-download-chunk'; payload: FileDownloadChunkPayload }
  | { type: 'file-download-complete'; payload: FileDownloadCompletePayload }
  | { type: 'file-download-error'; payload: FileDownloadErrorPayload }
  | { type: 'file-list-response'; payload: FileListResponsePayload }
  | { type: 'file-list-error'; payload: FileListErrorPayload }
  | { type: 'file-upload-progress'; payload: FileUploadProgressPayload }
  | { type: 'file-upload-complete'; payload: FileUploadCompletePayload }
  | { type: 'file-upload-error'; payload: FileUploadErrorPayload }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

export type BridgeServerMessage = BridgeBufferMessage | BridgeServerControlMessage;

export function isBridgeBufferMessage(message: BridgeServerMessage): message is BridgeBufferMessage {
  return message.type === 'buffer-sync';
}

export const TERMINAL_MUX_PROTOCOL_VERSION = 1 as const;

export type TerminalMuxErrorCode =
  | 'daemon_multiplex_upgrade_required'
  | 'mux_version_unsupported'
  | 'mux_protocol_invalid'
  | 'mux_unwrapped_session_message'
  | 'mux_unknown_channel'
  | 'mux_channel_mismatch'
  | 'mux_duplicate_channel'
  | 'mux_channel_closed';

export interface TerminalMuxCapabilities {
  version: typeof TERMINAL_MUX_PROTOCOL_VERSION;
  channelEnvelope: true;
  targetMessages: true;
  boundedBodyScheduler: true;
  reliableInput?: TerminalSessionCapabilitiesPayload['reliableInput'];
  relayPeerResume?: {
    version: 1;
    idleTimeoutMs: number;
  };
}

export type TerminalMuxTargetClientMessageType =
  | 'list-sessions'
  | 'tmux-create-session'
  | 'tmux-rename-session'
  | 'tmux-kill-session';

export type TerminalMuxLegacyClientMessageType =
  | 'session-open'
  | 'connect'
  | 'ping'
  | 'close';

export type TerminalMuxTargetClientMessage = Extract<
  BridgeClientMessage,
  { type: TerminalMuxTargetClientMessageType }
>;

export type TerminalMuxLegacyClientMessage = Extract<
  BridgeClientMessage,
  { type: TerminalMuxLegacyClientMessageType }
>;

export type TerminalMuxChannelClientMessage = Exclude<
  BridgeClientMessage,
  TerminalMuxTargetClientMessage | TerminalMuxLegacyClientMessage
>;

export type TerminalMuxTargetServerMessageType =
  | 'sessions'
  | 'debug-control'
  | 'error'
  | 'pong';

export type TerminalMuxTargetServerMessage = Extract<
  BridgeServerMessage,
  { type: TerminalMuxTargetServerMessageType }
>;

export type TerminalMuxChannelServerMessage = BridgeServerMessage;

export type TerminalMuxClientFrame =
  | { type: 'mux-hello'; payload: { version: typeof TERMINAL_MUX_PROTOCOL_VERSION; clientInstanceId: string } }
  | { type: 'mux-target-message'; payload: { requestId?: string; message: TerminalMuxTargetClientMessage } }
  | { type: 'mux-channel-open'; payload: { channelId: string; sessionName: string; cols?: number; rows?: number; widthMode?: TerminalWidthMode; autoCommand?: string; bodySubscribed?: boolean } }
  | { type: 'mux-channel-message'; payload: { channelId: string; message: TerminalMuxChannelClientMessage } }
  | { type: 'mux-channel-binary'; payload: { channelId: string; dataBase64: string } }
  | { type: 'mux-channel-close'; payload: { channelId: string; reason?: string } }
  | { type: 'mux-ping'; payload: { sentAt: number } };

export type TerminalMuxServerFrame =
  | { type: 'mux-ready'; payload: { version: typeof TERMINAL_MUX_PROTOCOL_VERSION; daemonHostId?: string; capabilities: TerminalMuxCapabilities } }
  | { type: 'mux-target-message'; payload: { requestId?: string; message: TerminalMuxTargetServerMessage } }
  | { type: 'mux-channel-opened'; payload: { channelId: string; sessionName: string; capabilities?: TerminalSessionCapabilitiesPayload } }
  | { type: 'mux-channel-message'; payload: { channelId: string; message: TerminalMuxChannelServerMessage } }
  | { type: 'mux-channel-closed'; payload: { channelId: string; reason: string; code?: string } }
  | { type: 'mux-pong'; payload: { sentAt: number; receivedAt: number } }
  | { type: 'mux-error'; payload: { code: TerminalMuxErrorCode; message: string; channelId?: string } };

export const TERMINAL_MUX_TARGET_CLIENT_MESSAGE_TYPES: readonly TerminalMuxTargetClientMessageType[] = [
  'list-sessions',
  'tmux-create-session',
  'tmux-rename-session',
  'tmux-kill-session',
] as const;

export const TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_TYPES: readonly TerminalMuxLegacyClientMessageType[] = [
  'session-open',
  'connect',
  'ping',
  'close',
] as const;

const TERMINAL_MUX_TARGET_CLIENT_MESSAGE_SET = new Set<string>(TERMINAL_MUX_TARGET_CLIENT_MESSAGE_TYPES);
const TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_SET = new Set<string>(TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function hasFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isTerminalMuxTargetClientMessageType(type: string): type is TerminalMuxTargetClientMessageType {
  return TERMINAL_MUX_TARGET_CLIENT_MESSAGE_SET.has(type);
}

export function isTerminalMuxLegacyClientMessageType(type: string): type is TerminalMuxLegacyClientMessageType {
  return TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_SET.has(type);
}

export function classifyTerminalMuxClientMessage(message: Pick<BridgeClientMessage, 'type'>) {
  if (isTerminalMuxTargetClientMessageType(message.type)) {
    return 'target' as const;
  }
  if (isTerminalMuxLegacyClientMessageType(message.type)) {
    return 'legacy' as const;
  }
  return 'channel' as const;
}

export function buildTerminalMuxCapabilities(
  options: Partial<Omit<TerminalMuxCapabilities, 'version' | 'channelEnvelope' | 'targetMessages' | 'boundedBodyScheduler'>> = {},
): TerminalMuxCapabilities {
  return {
    version: TERMINAL_MUX_PROTOCOL_VERSION,
    channelEnvelope: true,
    targetMessages: true,
    boundedBodyScheduler: true,
    ...options,
  };
}

export function buildTerminalMuxHello(clientInstanceId: string): TerminalMuxClientFrame {
  const normalizedClientInstanceId = asNonEmptyString(clientInstanceId);
  if (!normalizedClientInstanceId) {
    throw new Error('terminal mux clientInstanceId is required');
  }
  return {
    type: 'mux-hello',
    payload: {
      version: TERMINAL_MUX_PROTOCOL_VERSION,
      clientInstanceId: normalizedClientInstanceId,
    },
  };
}

export function buildTerminalMuxReady(options: {
  daemonHostId?: string;
  capabilities?: TerminalMuxCapabilities;
} = {}): TerminalMuxServerFrame {
  return {
    type: 'mux-ready',
    payload: {
      version: TERMINAL_MUX_PROTOCOL_VERSION,
      ...(asNonEmptyString(options.daemonHostId) ? { daemonHostId: asNonEmptyString(options.daemonHostId) } : {}),
      capabilities: options.capabilities || buildTerminalMuxCapabilities(),
    },
  };
}

export function buildTerminalMuxTargetMessage(
  message: TerminalMuxTargetClientMessage,
  requestId?: string,
): TerminalMuxClientFrame {
  if (classifyTerminalMuxClientMessage(message) !== 'target') {
    throw new Error(`terminal mux target message cannot carry ${message.type}`);
  }
  return {
    type: 'mux-target-message',
    payload: {
      ...(asNonEmptyString(requestId) ? { requestId: asNonEmptyString(requestId) } : {}),
      message,
    },
  };
}

export function buildTerminalMuxChannelOpen(
  payload: Extract<TerminalMuxClientFrame, { type: 'mux-channel-open' }>['payload'],
): TerminalMuxClientFrame {
  const channelId = asNonEmptyString(payload.channelId);
  const sessionName = asNonEmptyString(payload.sessionName);
  if (!channelId) {
    throw new Error('terminal mux channelId is required');
  }
  if (!sessionName) {
    throw new Error('terminal mux sessionName is required');
  }
  return {
    type: 'mux-channel-open',
    payload: {
      ...payload,
      channelId,
      sessionName,
    },
  };
}

export function buildTerminalMuxChannelMessage(
  channelId: string,
  message: TerminalMuxChannelClientMessage,
): TerminalMuxClientFrame {
  const normalizedChannelId = asNonEmptyString(channelId);
  if (!normalizedChannelId) {
    throw new Error('terminal mux channelId is required');
  }
  if (classifyTerminalMuxClientMessage(message) !== 'channel') {
    throw new Error(`terminal mux channel message cannot carry ${message.type}`);
  }
  return {
    type: 'mux-channel-message',
    payload: {
      channelId: normalizedChannelId,
      message,
    },
  };
}

export function buildTerminalMuxChannelBinary(
  channelId: string,
  dataBase64: string,
): TerminalMuxClientFrame {
  const normalizedChannelId = asNonEmptyString(channelId);
  if (!normalizedChannelId) {
    throw new Error('terminal mux channelId is required');
  }
  if (typeof dataBase64 !== 'string') {
    throw new Error('terminal mux channel binary dataBase64 is required');
  }
  return {
    type: 'mux-channel-binary',
    payload: {
      channelId: normalizedChannelId,
      dataBase64,
    },
  };
}

export function buildTerminalMuxServerChannelMessage(
  channelId: string,
  message: TerminalMuxChannelServerMessage,
): TerminalMuxServerFrame {
  const normalizedChannelId = asNonEmptyString(channelId);
  if (!normalizedChannelId) {
    throw new Error('terminal mux channelId is required');
  }
  return {
    type: 'mux-channel-message',
    payload: {
      channelId: normalizedChannelId,
      message,
    },
  };
}

export function buildTerminalMuxServerTargetMessage(
  message: TerminalMuxTargetServerMessage,
  requestId?: string,
): TerminalMuxServerFrame {
  return {
    type: 'mux-target-message',
    payload: {
      ...(asNonEmptyString(requestId) ? { requestId: asNonEmptyString(requestId) } : {}),
      message,
    },
  };
}

export function buildTerminalMuxError(
  code: TerminalMuxErrorCode,
  message: string,
  channelId?: string,
): TerminalMuxServerFrame {
  return {
    type: 'mux-error',
    payload: {
      code,
      message,
      ...(asNonEmptyString(channelId) ? { channelId: asNonEmptyString(channelId) } : {}),
    },
  };
}

export function buildTerminalMuxUnwrappedSessionMessageError(messageType: string): TerminalMuxServerFrame {
  return buildTerminalMuxError(
    'mux_unwrapped_session_message',
    `session-bound message ${messageType} must be sent inside mux-channel-message`,
  );
}

export function isTerminalMuxClientFrame(value: unknown): value is TerminalMuxClientFrame {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) {
    return false;
  }
  switch (value.type) {
    case 'mux-hello':
      return value.payload.version === TERMINAL_MUX_PROTOCOL_VERSION
        && Boolean(asNonEmptyString(value.payload.clientInstanceId));
    case 'mux-target-message':
      return isRecord(value.payload.message)
        && typeof value.payload.message.type === 'string'
        && isTerminalMuxTargetClientMessageType(value.payload.message.type);
    case 'mux-channel-open':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && Boolean(asNonEmptyString(value.payload.sessionName))
        && (typeof value.payload.bodySubscribed === 'undefined' || typeof value.payload.bodySubscribed === 'boolean');
    case 'mux-channel-message':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && isRecord(value.payload.message)
        && typeof value.payload.message.type === 'string'
        && classifyTerminalMuxClientMessage(value.payload.message as Pick<BridgeClientMessage, 'type'>) === 'channel';
    case 'mux-channel-binary':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && typeof value.payload.dataBase64 === 'string';
    case 'mux-channel-close':
      return Boolean(asNonEmptyString(value.payload.channelId));
    case 'mux-ping':
      return hasFiniteNumber(value.payload.sentAt);
    default:
      return false;
  }
}

export function isTerminalMuxServerFrame(value: unknown): value is TerminalMuxServerFrame {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) {
    return false;
  }
  switch (value.type) {
    case 'mux-ready':
      return value.payload.version === TERMINAL_MUX_PROTOCOL_VERSION
        && isRecord(value.payload.capabilities)
        && value.payload.capabilities.version === TERMINAL_MUX_PROTOCOL_VERSION
        && value.payload.capabilities.channelEnvelope === true
        && value.payload.capabilities.targetMessages === true;
    case 'mux-target-message':
      return isRecord(value.payload.message) && typeof value.payload.message.type === 'string';
    case 'mux-channel-opened':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && Boolean(asNonEmptyString(value.payload.sessionName));
    case 'mux-channel-message':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && isRecord(value.payload.message)
        && typeof value.payload.message.type === 'string';
    case 'mux-channel-closed':
      return Boolean(asNonEmptyString(value.payload.channelId))
        && typeof value.payload.reason === 'string';
    case 'mux-pong':
      return hasFiniteNumber(value.payload.sentAt)
        && hasFiniteNumber(value.payload.receivedAt);
    case 'mux-error':
      return typeof value.payload.code === 'string' && typeof value.payload.message === 'string';
    default:
      return false;
  }
}

export function validateTerminalMuxChannelEnvelope(
  frame: Pick<TerminalMuxClientFrame | TerminalMuxServerFrame, 'type' | 'payload'>,
  options: {
    hasChannel: (channelId: string) => boolean;
    expectedChannelId?: string;
  },
): { ok: true; channelId: string } | { ok: false; error: TerminalMuxServerFrame } {
  if (!isRecord(frame.payload) || !('channelId' in frame.payload)) {
    return {
      ok: false,
      error: buildTerminalMuxError('mux_protocol_invalid', 'mux frame is missing channelId'),
    };
  }
  const channelId = asNonEmptyString(frame.payload.channelId);
  if (!channelId) {
    return {
      ok: false,
      error: buildTerminalMuxError('mux_protocol_invalid', 'mux frame has empty channelId'),
    };
  }
  const expectedChannelId = asNonEmptyString(options.expectedChannelId);
  if (expectedChannelId && expectedChannelId !== channelId) {
    return {
      ok: false,
      error: buildTerminalMuxError('mux_channel_mismatch', `mux channel ${channelId} does not match expected channel ${expectedChannelId}`, channelId),
    };
  }
  if (!options.hasChannel(channelId)) {
    return {
      ok: false,
      error: buildTerminalMuxError('mux_unknown_channel', `mux channel ${channelId} is not open`, channelId),
    };
  }
  return { ok: true, channelId };
}
