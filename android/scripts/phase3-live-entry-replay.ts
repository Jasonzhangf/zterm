// Live daemon-entry replay for the Phase3 DAGpipe gates.
//
// This intentionally drives the production runtime factories from
// src/server with the *installed* dagpipe.node selected through
// ZTERM_DAGPIPE_NATIVE. It does not mock ./dagpipe-bridge, so a PASS proves the
// gate result actually reaches the owning daemon entry.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalFileTransferListRuntime } from '../src/server/terminal-file-transfer-list-runtime';
import { createTerminalFileTransferBinaryRuntime } from '../src/server/terminal-file-transfer-binary-runtime';
import { createTerminalAttachmentMessageRuntime } from '../src/server/terminal-attachment-message-runtime';
import type { AttachmentDeliveryRuntime } from '../src/server/attachment-delivery-runtime';
import type { TerminalSession, TerminalTransportConnection } from '../src/server/terminal-runtime-types';
import type { ServerMessage } from '../src/lib/types';

const EXPECTED_DAGPIPE_SHA256 =
  '6bcc3533b1a20e192714c7b98c061ddeb2d7c22ad5401deddea34654ac7ec9f3';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`phase3 live replay assertion failed: ${message}`);
  }
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeSession(): TerminalSession {
  return {
    id: 'live-replay-session',
    transportId: 'live-replay-transport',
    transport: null,
    sessionName: 'live-replay',
    mirrorKey: 'live-replay-mirror',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function makeConnection(): TerminalTransportConnection {
  return {
    transportId: 'live-replay-transport',
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: 'http://127.0.0.1',
      sendText: () => {},
      close: () => {},
    },
    closeTransport: () => {},
    requestOrigin: 'http://127.0.0.1',
    role: 'control',
    boundSubscriberId: null,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  const nativePath = (process.env.ZTERM_DAGPIPE_NATIVE || '').trim();
  assert(nativePath, 'ZTERM_DAGPIPE_NATIVE must point at the installed dagpipe.node');
  const actualSha = sha256(nativePath);
  assert(
    actualSha === EXPECTED_DAGPIPE_SHA256,
    `installed dagpipe.node sha256 ${actualSha} != ${EXPECTED_DAGPIPE_SHA256}`,
  );

  const tempDir = mkdtempSync(join(tmpdir(), 'phase3-live-replay-'));
  const results: Array<Record<string, unknown>> = [];
  try {
    const listMessages: ServerMessage[] = [];
    writeFileSync(join(tempDir, 'download.txt'), 'live-replay-download');
    const listRuntime = createTerminalFileTransferListRuntime({
      uploadDir: tempDir,
      downloadsDir: tempDir,
      wtermHomeDir: tempDir,
      platform: 'darwin',
      sendMessage: (_session, message) => listMessages.push(message),
      getSessionMirror: () => null,
      scheduleMirrorLiveSync: () => {},
      enqueueBackendInput: async () => false,
      readTmuxPaneCurrentPath: () => tempDir,
      runCommand: () => {},
      captureRemoteScreenshot: async ({ outputPath }) => {
        writeFileSync(outputPath, 'live-replay-screenshot');
        return { outputPath };
      },
      logTimePrefix: () => 'live-replay',
    });

    listRuntime.handleFileListRequest(makeSession(), {
      requestId: 'browse-ok',
      path: tempDir,
      showHidden: true,
    });
    assert(
      listMessages.some((message) => message.type === 'file-list-response'),
      'file browse gate did not reach handleFileListRequest success path',
    );

    listRuntime.handleFileDownloadRequest(makeSession(), {
      requestId: 'download-ok',
      remotePath: join(tempDir, 'download.txt'),
      fileName: 'download.txt',
      totalBytes: readFileSync(join(tempDir, 'download.txt')).byteLength,
    });
    await flush();
    assert(
      listMessages.some((message) => message.type === 'file-download-complete'),
      'download gate did not reach file-download-complete',
    );

    await listRuntime.handleRemoteScreenshotRequest(makeSession(), {
      requestId: 'screenshot-ok',
    });
    assert(
      listMessages.some(
        (message) => message.type === 'remote-screenshot-status'
          && (message.payload as { phase?: string }).phase === 'transferring',
      ),
      'screenshot gate did not reach remote-screenshot transfer path',
    );
    listRuntime.dispose();
    results.push({ entry: 'browse/download/screenshot', status: 'PASS' });

    const binaryMessages: ServerMessage[] = [];
    const binaryRuntime = createTerminalFileTransferBinaryRuntime({
      uploadDir: tempDir,
      downloadsDir: tempDir,
      wtermHomeDir: tempDir,
      platform: 'darwin',
      sendMessage: (_session, message) => binaryMessages.push(message),
      getSessionMirror: () => null,
      scheduleMirrorLiveSync: () => {},
      enqueueBackendInput: async () => false,
      readTmuxPaneCurrentPath: () => tempDir,
      runCommand: () => {},
      captureRemoteScreenshot: async ({ outputPath }) => ({ outputPath }),
      logTimePrefix: () => 'live-replay',
    });
    binaryRuntime.handleFileUploadStart(makeSession(), {
      requestId: 'upload-ok',
      targetDir: tempDir,
      fileName: 'upload.txt',
      fileSize: 4,
      chunkCount: 1,
    });
    assert(
      binaryMessages.some((message) => message.type === 'file-upload-progress'),
      'upload gate did not reach file-upload-progress',
    );
    results.push({ entry: 'upload', status: 'PASS' });

    const attachmentMessages: Array<Record<string, unknown>> = [];
    const attachmentRuntime = createTerminalAttachmentMessageRuntime({
      attachmentDeliveryRuntime: {
        listForDevice: async () => [],
        readAsset: async () => ({
          manifest: {
            schemaVersion: 1,
            attachmentId: 'att_12345678-1234-1234-1234-123456789abc',
            kind: 'image',
            senderAgentId: 'agent',
            senderName: 'agent',
            sourceSession: 'live-replay',
            fileName: 'a.png',
            mimeType: 'image/png',
            original: { size: 1, sha256: 'a' },
            preview: { fileName: 'p.png', mimeType: 'image/png', size: 1, sha256: 'b' },
            message: '',
            clientRequestId: 'req',
            createdAt: '2026-09-26T00:00:00.000Z',
            expiresAt: '2026-09-27T00:00:00.000Z',
            status: 'available',
            deliveries: [],
          },
          data: Buffer.from('x'),
        }),
      } as unknown as AttachmentDeliveryRuntime,
      sendTransportMessage: (_transport, message) => attachmentMessages.push(message as unknown as Record<string, unknown>),
    });
    await attachmentRuntime.handleMessage(makeConnection(), {
      type: 'attachment-asset-request',
      payload: {
        attachmentId: 'att_12345678-1234-1234-1234-123456789abc',
        asset: 'original',
        deviceId: 'device-1',
      },
    });
    assert(
      attachmentMessages.some((message) => message.type === 'attachment-asset-data'),
      'attachment gate did not reach attachment-asset-data',
    );
    results.push({ entry: 'attachment', status: 'PASS' });

    // Overshoot/invalid chunk behavior is owned by the Rust graph. The
    // production upload/download entries currently pass only admission fields,
    // so the live rejection is proven by driving the same gate input shape the
    // entries use plus the invalid chunk fields the wire owner rejects.
    const { runPhase3Upload, runPhase3Download } = await import('../src/server/dagpipe-bridge');
    const overshootUpload = runPhase3Upload({
      execution_id: 'live-replay-upload-overshoot',
      attempt_id: '1',
      inputs: {
        'arc.upload_intent': { uploadId: 'overshoot', segmentIndex: 1, totalChunks: 1 },
        'arc.transfer_policy': { allowUpload: true },
      },
    });
    assert(overshootUpload.ok === false, 'overshoot upload should be rejected');
    const invalidDownload = runPhase3Download({
      execution_id: 'live-replay-download-invalid',
      attempt_id: '1',
      inputs: {
        'arc.download_intent': { downloadId: 'invalid', path: '/tmp/a.txt', segmentIndex: -1, totalChunks: 1 },
        'arc.transfer_policy': { allowDownload: true },
      },
    });
    assert(invalidDownload.ok === false, 'invalid download chunk should be rejected');
    results.push({ entry: 'overshoot/invalid chunk', status: 'PASS' });

    console.log(JSON.stringify({
      status: 'PASS',
      nativePath,
      nativeSha256: actualSha,
      results,
    }, null, 2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
