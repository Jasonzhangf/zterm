import { mkdtempSync, readFileSync, rmSync } from 'fs';
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
});
