import { describe, expect, it, vi } from 'vitest';
import type { TerminalTransportServerFrame } from '@zterm/shared/protocol';
import {
  createTerminalFileTransferMessageRuntime,
  type TerminalFileTransferClientMessage,
} from './terminal-file-transfer-message-runtime';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import type {
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';

function createTransport(): TerminalSessionTransport {
  return {
    kind: 'ws',
    readyState: 1,
    requestOrigin: 'http://127.0.0.1:3333',
    connectedSent: false,
    sendText: vi.fn(),
    close: vi.fn(),
  };
}

function createConnection(boundSubscriberId: string | null = null): TerminalTransportConnection {
  return {
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: boundSubscriberId ? 'session' : 'pending',
    boundSubscriberId,
  };
}

function createSession(): TerminalSession {
  return {
    id: 'session-1',
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    sessionName: 'demo',
    mirrorKey: 'demo',
    bodySubscribed: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createFileTransferRuntimeStub(): TerminalFileTransferRuntime {
  return {
    handlePasteImage: vi.fn(),
    handleFileListRequest: vi.fn(),
    handleFileCreateDirectoryRequest: vi.fn(),
    handleFileDownloadRequest: vi.fn(),
    handleRemoteScreenshotRequest: vi.fn(async () => {}),
    handleFileUploadStart: vi.fn(),
    handleFileUploadChunk: vi.fn(),
    handleFileUploadEnd: vi.fn(),
    handleBinaryPayload: vi.fn(),
  };
}

function createRuntime() {
  const fileTransferRuntime = createFileTransferRuntimeStub();
  const sendTransportMessage = vi.fn(
    (_transport: TerminalSessionTransport | null | undefined, _message: TerminalTransportServerFrame) => {},
  );
  const runtime = createTerminalFileTransferMessageRuntime({
    fileTransferRuntime,
    sendTransportMessage,
  });
  return {
    runtime,
    fileTransferRuntime,
    sendTransportMessage,
  };
}

describe('terminal file transfer message runtime ownership', () => {
  it('owns paste and attach binary start projection before file bytes arrive', async () => {
    const { runtime, fileTransferRuntime } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);

    await runtime.handleMessage(session, connection, {
      type: 'paste-image-start',
      payload: {
        name: 'proof.png',
        mimeType: 'image/png',
        byteLength: 5,
      },
    });
    await runtime.handleMessage(session, connection, {
      type: 'attach-file-start',
      payload: {
        name: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 4,
      },
    });

    expect(session.pendingPasteImage).toMatchObject({
      receivedBytes: 0,
      chunks: [],
      payload: { name: 'proof.png', byteLength: 5 },
    });
    expect(session.pendingAttachFile).toMatchObject({
      receivedBytes: 0,
      chunks: [],
      payload: { name: 'notes.txt', byteLength: 4 },
    });
    expect(fileTransferRuntime.handlePasteImage).not.toHaveBeenCalled();
  });

  it('routes every file transfer message to the daemon file transfer owner', async () => {
    const { runtime, fileTransferRuntime } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);

    const messages: TerminalFileTransferClientMessage[] = [
      {
        type: 'paste-image',
        payload: {
          name: 'proof.png',
          mimeType: 'image/png',
          dataBase64: 'aGk=',
        },
      },
      {
        type: 'file-list-request',
        payload: {
          requestId: 'list-1',
          path: '/tmp',
          showHidden: true,
        },
      },
      {
        type: 'file-create-directory-request',
        payload: {
          requestId: 'mkdir-1',
          path: '/tmp',
          name: 'new-dir',
        },
      },
      {
        type: 'file-download-request',
        payload: {
          requestId: 'download-1',
          remotePath: '/tmp/a.txt',
          fileName: 'a.txt',
          totalBytes: 2,
        },
      },
      {
        type: 'remote-screenshot-request',
        payload: {
          requestId: 'shot-1',
        },
      },
      {
        type: 'file-upload-start',
        payload: {
          requestId: 'upload-1',
          targetDir: '/tmp',
          fileName: 'a.bin',
          fileSize: 3,
          chunkCount: 1,
        },
      },
      {
        type: 'file-upload-chunk',
        payload: {
          requestId: 'upload-1',
          chunkIndex: 0,
          dataBase64: 'YWJj',
        },
      },
      {
        type: 'file-upload-end',
        payload: {
          requestId: 'upload-1',
        },
      },
    ];

    for (const message of messages) {
      await runtime.handleMessage(session, connection, message);
    }

    expect(fileTransferRuntime.handlePasteImage).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileListRequest).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileCreateDirectoryRequest).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileDownloadRequest).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleRemoteScreenshotRequest).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileUploadStart).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileUploadChunk).toHaveBeenCalledTimes(1);
    expect(fileTransferRuntime.handleFileUploadEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects file transfer messages without an attached session before owner access', async () => {
    const { runtime, fileTransferRuntime, sendTransportMessage } = createRuntime();
    const connection = createConnection(null);
    const messages: TerminalFileTransferClientMessage[] = [
      {
        type: 'paste-image-start',
        payload: { name: 'a', mimeType: 'image/png', byteLength: 1 },
      },
      {
        type: 'paste-image',
        payload: { name: 'a', mimeType: 'image/png', dataBase64: 'aA==' },
      },
      {
        type: 'attach-file-start',
        payload: { name: 'a', mimeType: 'text/plain', byteLength: 1 },
      },
      {
        type: 'file-list-request',
        payload: { requestId: 'list-1', path: '/tmp', showHidden: false },
      },
      {
        type: 'file-create-directory-request',
        payload: { requestId: 'mkdir-1', path: '/tmp', name: 'x' },
      },
      {
        type: 'file-download-request',
        payload: { requestId: 'download-1', remotePath: '/tmp/a', fileName: 'a', totalBytes: 1 },
      },
      {
        type: 'remote-screenshot-request',
        payload: { requestId: 'shot-1' },
      },
      {
        type: 'file-upload-start',
        payload: { requestId: 'upload-1', targetDir: '/tmp', fileName: 'a', fileSize: 1, chunkCount: 1 },
      },
      {
        type: 'file-upload-chunk',
        payload: { requestId: 'upload-1', chunkIndex: 0, dataBase64: 'aA==' },
      },
      {
        type: 'file-upload-end',
        payload: { requestId: 'upload-1' },
      },
    ];

    for (const message of messages) {
      await runtime.handleMessage(null, connection, message);
    }

    expect(sendTransportMessage).toHaveBeenCalledTimes(messages.length);
    expect(sendTransportMessage.mock.calls.every(([, frame]) => (
      frame.type === 'error'
      && frame.payload.code === 'session_required'
    ))).toBe(true);
    expect(fileTransferRuntime.handlePasteImage).not.toHaveBeenCalled();
    expect(fileTransferRuntime.handleFileListRequest).not.toHaveBeenCalled();
    expect(fileTransferRuntime.handleFileUploadStart).not.toHaveBeenCalled();
  });

  it('routes raw binary chunks to the file transfer owner', () => {
    const { runtime, fileTransferRuntime } = createRuntime();
    const session = createSession();
    const buffer = Buffer.from('image-chunk');

    runtime.handleBinaryPayload(session, buffer);

    expect(fileTransferRuntime.handleBinaryPayload).toHaveBeenCalledWith(session, buffer);
  });
});
