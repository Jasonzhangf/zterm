import {
  FILE_TRANSFER_WIRE_CHUNK_BYTES,
  type BridgeServerMessage as ServerMessage,
  type FileCreateDirectoryRequestPayload,
  type FileDownloadRequestPayload,
  type FileListRequestPayload,
  type FileUploadChunkPayload,
  type FileUploadEndPayload,
  type FileUploadStartPayload,
  type PasteImagePayload,
  type PasteImageStartPayload,
  type RemoteScreenshotRequestPayload,
  type RemoteWindowStreamRect,
} from '@zterm/shared/protocol';
import type { TerminalSession, SessionMirror } from './terminal-runtime-types';

export const FILE_CHUNK_SIZE = FILE_TRANSFER_WIRE_CHUNK_BYTES;
export const REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS = 15000;

export interface RemoteScreenshotCaptureOptions {
  outputPath: string;
  timeoutMs: number;
  windowId?: string;
  rect?: RemoteWindowStreamRect;
}

export interface PendingUploadState {
  targetDir: string;
  fileName: string;
  fileSize: number;
  chunks: Map<number, Buffer>;
  totalChunks: number;
  /** Number of unique chunks in the contiguous prefix [0, receivedChunks). */
  receivedChunks: number;
}

export interface TerminalFileTransferRuntimeDeps {
  uploadDir: string;
  downloadsDir: string;
  wtermHomeDir: string;
  platform: NodeJS.Platform;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  readTmuxPaneCurrentPath: (sessionName: string) => string;
  runCommand: (command: string, args: string[]) => void;
  pasteImageToRemoteWindow?: (
    session: TerminalSession,
    target: NonNullable<PasteImageStartPayload['pasteTarget']>,
    image: { name: string; mimeType: string; bytes: number },
  ) => Promise<void> | void;
  captureRemoteScreenshot: (options: RemoteScreenshotCaptureOptions) => Promise<{ outputPath: string }>;
  logTimePrefix: () => string;
}

export interface TerminalFileTransferRuntime {
  handlePasteImage: (session: TerminalSession, payload: PasteImagePayload) => void;
  handleFileListRequest: (session: TerminalSession, payload: FileListRequestPayload) => void;
  handleFileCreateDirectoryRequest: (session: TerminalSession, payload: FileCreateDirectoryRequestPayload) => void;
  handleFileDownloadRequest: (session: TerminalSession, payload: FileDownloadRequestPayload) => void;
  handleRemoteScreenshotRequest: (session: TerminalSession, payload: RemoteScreenshotRequestPayload) => Promise<void>;
  handleFileUploadStart: (session: TerminalSession, payload: FileUploadStartPayload) => void;
  handleFileUploadChunk: (session: TerminalSession, payload: FileUploadChunkPayload) => void;
  handleFileUploadEnd: (session: TerminalSession, payload: FileUploadEndPayload) => void;
  handleBinaryPayload: (session: TerminalSession, buffer: Buffer) => void;
}
