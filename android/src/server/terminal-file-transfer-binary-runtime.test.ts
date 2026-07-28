import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalFileTransferBinaryRuntime } from './terminal-file-transfer-binary-runtime';
import type { SessionMirror, TerminalSession } from './terminal-runtime-types';
import type { ServerMessage } from '../lib/types';

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  statSyncMock.mockImplementation(actual.statSync);
  return { ...actual, statSync: statSyncMock };
});

function makeSession(): TerminalSession {
  return {
    id: 'session-1',
    transportId: 'transport-1',
    transport: null,
    sessionName: 'client-session-name',
    mirrorKey: 'mirror-1',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function makeReadyMirror(): SessionMirror {
  return {
    key: 'mirror-1',
    sessionName: 'tmux-main',
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 120,
    rows: 40,
    consecutiveFailures: 0,
    cursorKeysApp: false,
    revision: 1,
    lastScrollbackCount: 0,
    bufferStartIndex: 0,
    bufferLines: [],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    liveSyncTimer: null,
    subscribers: new Set(['session-1']),
  };
}

function makeRunCommandStub() {
  return vi.fn((command: string, args: string[]) => {
    if (command === 'sips') {
      const outputPath = args[args.length - 1];
      if (outputPath) {
        writeFileSync(outputPath, Buffer.from('png'));
      }
    }
  });
}

describe('terminal-file-transfer-binary-runtime', () => {
  let uploadDir: string | null = null;

  afterEach(() => {
    statSyncMock.mockClear();
    if (uploadDir) {
      rmSync(uploadDir, { recursive: true, force: true });
      uploadDir = null;
    }
  });

  it('writes uploaded file to remote target dir without injecting the final path into tmux input', () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'zterm-upload-'));
    const session = makeSession();
    const mirror = makeReadyMirror();
    const sentMessages: ServerMessage[] = [];
    const writeToTmuxSession = vi.fn();
    const scheduleMirrorLiveSync = vi.fn();
    const runtime = createTerminalFileTransferBinaryRuntime({
      uploadDir,
      downloadsDir: uploadDir,
      wtermHomeDir: uploadDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: () => mirror,
      scheduleMirrorLiveSync,
      writeToTmuxSession,
      writeToLiveMirror: vi.fn(() => true),
      readTmuxPaneCurrentPath: vi.fn(() => uploadDir!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-05-23 00:00:00',
    });

    runtime.handleFileUploadStart(session, {
      requestId: 'upload-1',
      targetDir: uploadDir,
      fileName: 'photo.png',
      fileSize: 5,
      chunkCount: 1,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-1',
      chunkIndex: 0,
      dataBase64: Buffer.from('image').toString('base64'),
    });
    runtime.handleFileUploadEnd(session, { requestId: 'upload-1' });

    const filePath = join(uploadDir, 'photo.png');
    expect(readFileSync(filePath, 'utf8')).toBe('image');
    expect(writeToTmuxSession).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).not.toHaveBeenCalled();
    expect(sentMessages).toContainEqual({
      type: 'file-upload-complete',
      payload: { requestId: 'upload-1', filePath, bytes: 5 },
    });
  });

  it('acknowledges only the unique contiguous upload prefix and rejects invalid completion', () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'zterm-upload-window-'));
    const session = makeSession();
    const sentMessages: ServerMessage[] = [];
    const runtime = createTerminalFileTransferBinaryRuntime({
      uploadDir,
      downloadsDir: uploadDir,
      wtermHomeDir: uploadDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: () => makeReadyMirror(),
      scheduleMirrorLiveSync: vi.fn(),
      writeToTmuxSession: vi.fn(),
      writeToLiveMirror: vi.fn(() => true),
      readTmuxPaneCurrentPath: vi.fn(() => uploadDir!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-28 00:00:00',
    });

    runtime.handleFileUploadStart(session, {
      requestId: 'upload-window',
      targetDir: uploadDir,
      fileName: 'ordered.bin',
      fileSize: 3,
      chunkCount: 3,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-window',
      chunkIndex: 2,
      dataBase64: Buffer.from('c').toString('base64'),
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-window',
      chunkIndex: 0,
      dataBase64: Buffer.from('a').toString('base64'),
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-window',
      chunkIndex: 0,
      dataBase64: Buffer.from('a').toString('base64'),
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-window',
      chunkIndex: 1,
      dataBase64: Buffer.from('b').toString('base64'),
    });

    const progress = sentMessages
      .filter((message) => message.type === 'file-upload-progress')
      .map((message) => message.payload.chunkIndex);
    expect(progress).toEqual([0, 0, 1, 1, 3]);

    runtime.handleFileUploadEnd(session, { requestId: 'upload-window' });
    expect(readFileSync(join(uploadDir, 'ordered.bin'), 'utf8')).toBe('abc');

    runtime.handleFileUploadStart(session, {
      requestId: 'upload-invalid',
      targetDir: uploadDir,
      fileName: 'invalid.bin',
      fileSize: 2,
      chunkCount: 2,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-invalid',
      chunkIndex: 2,
      dataBase64: Buffer.from('x').toString('base64'),
    });
    runtime.handleFileUploadEnd(session, { requestId: 'upload-invalid' });

    expect(sentMessages).toContainEqual({
      type: 'file-upload-error',
      payload: {
        requestId: 'upload-invalid',
        error: 'Invalid chunk index 2 for 2 chunks',
      },
    });
    expect(sentMessages).not.toContainEqual(expect.objectContaining({
      type: 'file-upload-complete',
      payload: expect.objectContaining({ requestId: 'upload-invalid' }),
    }));

    runtime.handleFileUploadStart(session, {
      requestId: 'upload-size-mismatch',
      targetDir: uploadDir,
      fileName: 'size-mismatch.bin',
      fileSize: 2,
      chunkCount: 1,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-size-mismatch',
      chunkIndex: 0,
      dataBase64: Buffer.from('x').toString('base64'),
    });
    runtime.handleFileUploadEnd(session, { requestId: 'upload-size-mismatch' });
    expect(sentMessages).toContainEqual({
      type: 'file-upload-error',
      payload: {
        requestId: 'upload-size-mismatch',
        error: 'Upload size mismatch: received 1 bytes, expected 2',
      },
    });
    expect(sentMessages).not.toContainEqual(expect.objectContaining({
      type: 'file-upload-complete',
      payload: expect.objectContaining({ requestId: 'upload-size-mismatch' }),
    }));
  });

  it('rejects completion when persisted file size differs from the exact upload truth', () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'zterm-upload-persisted-size-'));
    const session = makeSession();
    const sentMessages: ServerMessage[] = [];
    const runtime = createTerminalFileTransferBinaryRuntime({
      uploadDir,
      downloadsDir: uploadDir,
      wtermHomeDir: uploadDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: () => makeReadyMirror(),
      scheduleMirrorLiveSync: vi.fn(),
      writeToTmuxSession: vi.fn(),
      writeToLiveMirror: vi.fn(() => true),
      readTmuxPaneCurrentPath: vi.fn(() => uploadDir!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-28 00:00:00',
    });

    runtime.handleFileUploadStart(session, {
      requestId: 'upload-persisted-size-mismatch',
      targetDir: uploadDir,
      fileName: 'persisted-size.bin',
      fileSize: 1,
      chunkCount: 1,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-persisted-size-mismatch',
      chunkIndex: 0,
      dataBase64: Buffer.from('x').toString('base64'),
    });
    statSyncMock.mockReturnValueOnce({ ...statSync(uploadDir), size: 0 });
    runtime.handleFileUploadEnd(session, { requestId: 'upload-persisted-size-mismatch' });

    expect(sentMessages).toContainEqual({
      type: 'file-upload-error',
      payload: {
        requestId: 'upload-persisted-size-mismatch',
        error: 'Upload persisted size mismatch: wrote 0 bytes, expected 1',
      },
    });
    expect(sentMessages).not.toContainEqual(expect.objectContaining({
      type: 'file-upload-complete',
      payload: expect.objectContaining({ requestId: 'upload-persisted-size-mismatch' }),
    }));
  });

  it('routes remote-window image paste through macOS clipboard plus Command+V input without requiring tmux mirror readiness', async () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'zterm-paste-rw-'));
    const session = makeSession();
    const sentMessages: ServerMessage[] = [];
    const getSessionMirror = vi.fn(() => null);
    const writeToLiveMirror = vi.fn();
    const scheduleMirrorLiveSync = vi.fn();
    const pasteImageToRemoteWindow = vi.fn(async () => undefined);
    const runtime = createTerminalFileTransferBinaryRuntime({
      uploadDir,
      downloadsDir: uploadDir,
      wtermHomeDir: uploadDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror,
      scheduleMirrorLiveSync,
      writeToTmuxSession: vi.fn(),
      writeToLiveMirror,
      readTmuxPaneCurrentPath: vi.fn(() => uploadDir!),
      runCommand: makeRunCommandStub(),
      pasteImageToRemoteWindow,
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-20 00:00:00',
    });

    runtime.handlePasteImage(session, {
      name: 'proof.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('image').toString('base64'),
      pasteTarget: {
        kind: 'remote-window',
        streamId: 'stream-1',
        targetId: 'target-1',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSessionMirror).not.toHaveBeenCalled();
    expect(writeToLiveMirror).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).not.toHaveBeenCalled();
    expect(pasteImageToRemoteWindow).toHaveBeenCalledWith(
      session,
      {
        kind: 'remote-window',
        streamId: 'stream-1',
        targetId: 'target-1',
      },
      {
        name: 'proof.png',
        mimeType: 'image/png',
        bytes: 5,
      },
    );
    expect(sentMessages).toContainEqual({
      type: 'image-pasted',
      payload: { name: 'proof.png', mimeType: 'image/png', bytes: 5 },
    });
  });

  it('keeps terminal image paste on the live mirror Ctrl+V path', () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'zterm-paste-terminal-'));
    const session = makeSession();
    const mirror = makeReadyMirror();
    const sentMessages: ServerMessage[] = [];
    const writeToLiveMirror = vi.fn();
    const scheduleMirrorLiveSync = vi.fn();
    const pasteImageToRemoteWindow = vi.fn();
    const runtime = createTerminalFileTransferBinaryRuntime({
      uploadDir,
      downloadsDir: uploadDir,
      wtermHomeDir: uploadDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: () => mirror,
      scheduleMirrorLiveSync,
      writeToTmuxSession: vi.fn(),
      writeToLiveMirror,
      readTmuxPaneCurrentPath: vi.fn(() => uploadDir!),
      runCommand: makeRunCommandStub(),
      pasteImageToRemoteWindow,
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-20 00:00:00',
    });

    runtime.handlePasteImage(session, {
      name: 'proof.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('image').toString('base64'),
      pasteSequence: '\x16',
    });

    expect(pasteImageToRemoteWindow).not.toHaveBeenCalled();
    expect(writeToLiveMirror).toHaveBeenCalledWith('tmux-main', '\x16', false);
    expect(scheduleMirrorLiveSync).toHaveBeenCalledWith(mirror, 33);
    expect(sentMessages).toContainEqual({
      type: 'image-pasted',
      payload: { name: 'proof.png', mimeType: 'image/png', bytes: 5 },
    });
  });
});
