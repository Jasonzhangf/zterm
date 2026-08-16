import type {
  AttachFileStartPayload,
  BridgeClientMessage,
  FileCreateDirectoryRequestPayload,
  FileDownloadRequestPayload,
  FileListRequestPayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  PasteImageStartPayload,
  RemoteScreenshotRequestPayload,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import type {
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';

export type TerminalFileTransferClientMessage = Extract<
  BridgeClientMessage,
  | { type: 'paste-image-start' }
  | { type: 'paste-image' }
  | { type: 'attach-file-start' }
  | { type: 'remote-screenshot-request' }
  | { type: 'file-list-request' }
  | { type: 'file-create-directory-request' }
  | { type: 'file-download-request' }
  | { type: 'file-upload-start' }
  | { type: 'file-upload-chunk' }
  | { type: 'file-upload-end' }
>;

export interface TerminalFileTransferMessageRuntimeDeps {
  fileTransferRuntime: TerminalFileTransferRuntime;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

export interface TerminalFileTransferMessageRuntime {
  handleMessage: (
    session: TerminalSession | null,
    connection: TerminalTransportConnection,
    message: TerminalFileTransferClientMessage,
  ) => Promise<void>;
  handleBinaryPayload: (session: TerminalSession, buffer: Buffer) => void;
}

function sendSessionRequiredError(
  deps: TerminalFileTransferMessageRuntimeDeps,
  connection: TerminalTransportConnection,
  operation: string,
) {
  deps.sendTransportMessage(connection.transport, {
    type: 'error',
    payload: { message: `${operation} requires an attached session transport`, code: 'session_required' },
  });
}

export function createTerminalFileTransferMessageRuntime(
  deps: TerminalFileTransferMessageRuntimeDeps,
): TerminalFileTransferMessageRuntime {
  function requireSession(
    session: TerminalSession | null,
    connection: TerminalTransportConnection,
    operation: string,
  ): session is TerminalSession {
    if (session) {
      return true;
    }
    sendSessionRequiredError(deps, connection, operation);
    return false;
  }

  async function handleMessage(
    session: TerminalSession | null,
    connection: TerminalTransportConnection,
    message: TerminalFileTransferClientMessage,
  ) {
    switch (message.type) {
      case 'paste-image-start':
        if (!requireSession(session, connection, 'paste-image-start')) {
          break;
        }
        session.pendingPasteImage = {
          payload: message.payload as PasteImageStartPayload,
          receivedBytes: 0,
          chunks: [],
        };
        break;
      case 'attach-file-start':
        if (!requireSession(session, connection, 'attach-file-start')) {
          break;
        }
        session.pendingAttachFile = {
          payload: message.payload as AttachFileStartPayload,
          receivedBytes: 0,
          chunks: [],
        };
        break;
      case 'paste-image':
        if (!requireSession(session, connection, 'paste-image')) {
          break;
        }
        deps.fileTransferRuntime.handlePasteImage(session, message.payload as PasteImagePayload);
        break;
      case 'file-list-request':
        if (!requireSession(session, connection, 'file-list-request')) {
          break;
        }
        deps.fileTransferRuntime.handleFileListRequest(session, message.payload as FileListRequestPayload);
        break;
      case 'file-create-directory-request':
        if (!requireSession(session, connection, 'file-create-directory-request')) {
          break;
        }
        deps.fileTransferRuntime.handleFileCreateDirectoryRequest(
          session,
          message.payload as FileCreateDirectoryRequestPayload,
        );
        break;
      case 'file-download-request':
        if (!requireSession(session, connection, 'file-download-request')) {
          break;
        }
        deps.fileTransferRuntime.handleFileDownloadRequest(session, message.payload as FileDownloadRequestPayload);
        break;
      case 'remote-screenshot-request':
        if (!requireSession(session, connection, 'remote-screenshot-request')) {
          break;
        }
        void deps.fileTransferRuntime.handleRemoteScreenshotRequest(
          session,
          message.payload as RemoteScreenshotRequestPayload,
        );
        break;
      case 'file-upload-start':
        if (!requireSession(session, connection, 'file-upload-start')) {
          break;
        }
        deps.fileTransferRuntime.handleFileUploadStart(session, message.payload as FileUploadStartPayload);
        break;
      case 'file-upload-chunk':
        if (!requireSession(session, connection, 'file-upload-chunk')) {
          break;
        }
        deps.fileTransferRuntime.handleFileUploadChunk(session, message.payload as FileUploadChunkPayload);
        break;
      case 'file-upload-end':
        if (!requireSession(session, connection, 'file-upload-end')) {
          break;
        }
        deps.fileTransferRuntime.handleFileUploadEnd(session, message.payload as FileUploadEndPayload);
        break;
    }
  }

  function handleBinaryPayload(session: TerminalSession, buffer: Buffer) {
    deps.fileTransferRuntime.handleBinaryPayload(session, buffer);
  }

  return {
    handleMessage,
    handleBinaryPayload,
  };
}
