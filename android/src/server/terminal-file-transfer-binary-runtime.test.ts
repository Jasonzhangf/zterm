import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalFileTransferBinaryRuntime } from './terminal-file-transfer-binary-runtime';
import type { SessionMirror, TerminalSession } from './terminal-runtime-types';
import type { ServerMessage } from '../lib/types';

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
