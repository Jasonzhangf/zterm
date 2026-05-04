import type {
  FileCreateDirectoryRequestPayload,
  FileDownloadRequestPayload,
  FileListRequestPayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  RemoteScreenshotRequestPayload,
  ServerMessage,
} from '../lib/types';
import type { TerminalSession, SessionMirror } from './terminal-runtime-types';

export const FILE_CHUNK_SIZE = 256 * 1024;
export const REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS = 15000;

export interface PendingUploadState {
  targetDir: string;
  fileName: string;
  fileSize: number;
  chunks: Map<number, Buffer>;
  totalChunks: number;
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
