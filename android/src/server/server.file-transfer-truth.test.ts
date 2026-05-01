import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readMessageRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-message-runtime.ts'), 'utf8');
}

function readFileTransferRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-file-transfer-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 1200) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server file-transfer truth gates', () => {
  it('keeps server glue delegating file/screenshot handlers to dedicated runtime', () => {
    const serverSource = readServerSource();
    const messageRuntimeSource = readMessageRuntimeSource();

    expect(serverSource).toContain('createTerminalFileTransferRuntime');
    expect(serverSource).toContain('const terminalFileTransferRuntime = createTerminalFileTransferRuntime({');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleBinaryPayload(session, binaryBuffer)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handlePasteImage(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileListRequest(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileCreateDirectoryRequest(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileDownloadRequest(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleRemoteScreenshotRequest(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileUploadStart(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileUploadChunk(session, message.payload)');
    expect(messageRuntimeSource).toContain('terminalFileTransferRuntime.handleFileUploadEnd(session, message.payload)');
  });

  it('does not keep file-transfer implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function handleFileListRequest(');
    expect(source).not.toContain('function handleFileCreateDirectoryRequest(');
    expect(source).not.toContain('function handleFileDownloadRequest(');
    expect(source).not.toContain('function sendFileDownloadBuffer(');
    expect(source).not.toContain('function buildRemoteScreenshotFileName(');
    expect(source).not.toContain('async function handleRemoteScreenshotRequest(');
    expect(source).not.toContain('function handleFileUploadStart(');
    expect(source).not.toContain('function handleFileUploadChunk(');
    expect(source).not.toContain('function handleFileUploadEnd(');
    expect(source).not.toContain('function consumePendingBinaryTransfer(');
    expect(source).not.toContain('function handleAttachFileBinary(');
    expect(source).not.toContain('function handlePasteImageBinary(');
    expect(source).not.toContain('function persistClipboardImageBuffer(');
    expect(source).not.toContain('function persistClipboardImage(');
    expect(source).not.toContain('function logCleanupFailure(');
  });

  it('keeps remote cwd truth in file runtime via tmux pane current path', () => {
    const source = readFileTransferRuntimeSource();
    const listBlock = extractBlock(source, 'function handleFileListRequest(');
    const mkdirBlock = extractBlock(source, 'function handleFileCreateDirectoryRequest(');

    expect(listBlock).toContain('resolveFileTransferListPath');
    expect(listBlock).toContain('deps.readTmuxPaneCurrentPath(session.sessionName)');
    expect(mkdirBlock).toContain('resolveFileTransferListPath');
    expect(mkdirBlock).toContain('deps.readTmuxPaneCurrentPath(session.sessionName)');
  });

  it('keeps binary handlers fail-fast and never falls back to raw terminal input', () => {
    const source = readFileTransferRuntimeSource();
    const binaryBlock = extractBlock(source, 'function handleBinaryPayload(');
    const pasteBinaryBlock = extractBlock(source, 'function handlePasteImageBinary(');
    const attachBinaryBlock = extractBlock(source, 'function handleAttachFileBinary(');

    expect(binaryBlock).not.toContain('handleInput(');
    expect(pasteBinaryBlock).toContain('paste_image_no_pending');
    expect(pasteBinaryBlock).not.toContain("buffer.toString('utf-8')");
    expect(attachBinaryBlock).toContain('attach_file_no_pending');
    expect(attachBinaryBlock).not.toContain("buffer.toString('utf-8')");
  });

  it('keeps remote screenshot explicit capturing -> transferring flow in the dedicated runtime', () => {
    const source = readFileTransferRuntimeSource();
    const block = extractBlock(source, 'async function handleRemoteScreenshotRequest(', 2200);

    expect(block).toContain("type: 'remote-screenshot-status'");
    expect(block).toContain("phase: 'capturing'");
    expect(block).toContain("phase: 'transferring'");
    expect(block).toContain('requestRemoteScreenshotViaHelper');
    expect(block).toContain("type: 'file-download-error'");
  });
});
