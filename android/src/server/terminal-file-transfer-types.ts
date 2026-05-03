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
import type { ClientSession, SessionMirror } from './terminal-runtime-types';

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
  sendMessage: (session: ClientSession, message: ServerMessage) => void;
  getClientMirror: (session: ClientSession) => SessionMirror | null;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  readTmuxPaneCurrentPath: (sessionName: string) => string;
  runCommand: (command: string, args: string[]) => void;
  logTimePrefix: () => string;
}

export interface TerminalFileTransferRuntime {
  handlePasteImage: (session: ClientSession, payload: PasteImagePayload) => void;
  handleFileListRequest: (session: ClientSession, payload: FileListRequestPayload) => void;
  handleFileCreateDirectoryRequest: (session: ClientSession, payload: FileCreateDirectoryRequestPayload) => void;
  handleFileDownloadRequest: (session: ClientSession, payload: FileDownloadRequestPayload) => void;
  handleRemoteScreenshotRequest: (session: ClientSession, payload: RemoteScreenshotRequestPayload) => Promise<void>;
  handleFileUploadStart: (session: ClientSession, payload: FileUploadStartPayload) => void;
  handleFileUploadChunk: (session: ClientSession, payload: FileUploadChunkPayload) => void;
  handleFileUploadEnd: (session: ClientSession, payload: FileUploadEndPayload) => void;
  handleBinaryPayload: (session: ClientSession, buffer: Buffer) => void;
}
