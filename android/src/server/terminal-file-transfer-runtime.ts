import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { extname, join, resolve } from 'path';
import type {
  AttachFileStartPayload,
  FileCreateDirectoryRequestPayload,
  FileDownloadRequestPayload,
  FileListRequestPayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  PasteImageStartPayload,
  RemoteScreenshotRequestPayload,
  ServerMessage,
} from '../lib/types';
import { resolveFileTransferListPath } from './file-transfer-path';
import { requestRemoteScreenshotViaHelper } from './remote-screenshot-helper-client';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';
import type {
  ClientSession,
  PendingBinaryTransfer,
  SessionMirror,
} from './terminal-runtime-types';

const FILE_CHUNK_SIZE = 256 * 1024;
const REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS = 15000;

interface PendingUploadState {
  targetDir: string;
  fileName: string;
  fileSize: number;
  chunks: Map<number, Buffer>;
  totalChunks: number;
  receivedChunks: number;
}

interface TerminalFileTransferRuntimeDeps {
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

export function createTerminalFileTransferRuntime(
  deps: TerminalFileTransferRuntimeDeps,
): TerminalFileTransferRuntime {
  const pendingUploads = new Map<string, PendingUploadState>();

  function sanitizeUploadFileName(input?: string) {
    const generatedName = `upload-${Date.now()}`;
    const candidate = (input || generatedName).trim() || generatedName;
    return candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
  }

  function ensureUploadDir() {
    mkdirSync(deps.uploadDir, { recursive: true });
  }

  function normalizeImageToPng(inputPath: string, preferredBaseName: string) {
    ensureUploadDir();
    const outputPath = join(deps.uploadDir, `${preferredBaseName}-${Date.now()}.png`);
    deps.runCommand('sips', ['-s', 'format', 'png', inputPath, '--out', outputPath]);
    return outputPath;
  }

  function writeImageToClipboard(pngPath: string) {
    deps.runCommand('osascript', [
      '-e',
      `set f to POSIX file "${pngPath.replace(/"/g, '\\"')}"`,
      '-e',
      'set the clipboard to (read f as «class PNGf»)',
    ]);
  }

  function persistClipboardImageBuffer(
    fileMeta: { name: string; mimeType: string },
    buffer: Buffer,
  ) {
    ensureUploadDir();
    const safeName = sanitizeUploadFileName(fileMeta.name || 'upload');
    const explicitExt = extname(safeName);
    const sourceExt =
      explicitExt
      || (fileMeta.mimeType === 'image/jpeg'
        ? '.jpg'
        : fileMeta.mimeType === 'image/png'
          ? '.png'
          : fileMeta.mimeType === 'image/gif'
            ? '.gif'
            : '');
    const sourcePath = join(deps.uploadDir, `${safeName.replace(/\.[^.]+$/u, '')}-${Date.now()}${sourceExt}`);
    writeFileSync(sourcePath, buffer);
    const pngPath = normalizeImageToPng(sourcePath, safeName.replace(/\.[^.]+$/u, ''));
    writeImageToClipboard(pngPath);
    return { sourcePath, pngPath, bytes: buffer.byteLength };
  }

  function persistClipboardImage(payload: PasteImagePayload) {
    return persistClipboardImageBuffer(
      {
        name: payload.name,
        mimeType: payload.mimeType,
      },
      Buffer.from(payload.dataBase64, 'base64'),
    );
  }

  function logCleanupFailure(scope: string, filePath: string, error: unknown) {
    console.warn(
      `[${deps.logTimePrefix()}] ${scope} cleanup failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function sendFileDownloadBuffer(session: ClientSession, requestId: string, fileName: string, fileBuffer: Buffer) {
    const totalChunks = Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE);
    let index = 0;

    function sendNextChunk() {
      if (index >= totalChunks) {
        deps.sendMessage(session, {
          type: 'file-download-complete',
          payload: { requestId, fileName, totalBytes: fileBuffer.length },
        });
        return;
      }
      const start = index * FILE_CHUNK_SIZE;
      const end = Math.min(start + FILE_CHUNK_SIZE, fileBuffer.length);
      const chunk = fileBuffer.subarray(start, end);
      deps.sendMessage(session, {
        type: 'file-download-chunk',
        payload: {
          requestId,
          chunkIndex: index,
          totalChunks,
          fileName,
          dataBase64: chunk.toString('base64'),
        },
      });
      index += 1;
      setImmediate(sendNextChunk);
    }

    sendNextChunk();
  }

  function buildRemoteScreenshotFileName() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `remote-screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  }

  function consumePendingBinaryTransfer<TPayload extends { byteLength: number }>(
    pending: PendingBinaryTransfer<TPayload> | null,
    buffer: Buffer,
  ) {
    if (!pending) {
      return { pending: null, complete: null as Buffer | null, error: null as string | null };
    }

    pending.chunks.push(buffer);
    pending.receivedBytes += buffer.length;
    if (pending.receivedBytes > pending.payload.byteLength) {
      return {
        pending: null,
        complete: null as Buffer | null,
        error: `Binary payload exceeded expected size (${pending.receivedBytes} > ${pending.payload.byteLength})`,
      };
    }

    if (pending.receivedBytes < pending.payload.byteLength) {
      return { pending, complete: null as Buffer | null, error: null as string | null };
    }

    return {
      pending: null,
      complete: Buffer.concat(pending.chunks, pending.payload.byteLength),
      error: null as string | null,
    };
  }

  function handlePasteImage(session: ClientSession, payload: PasteImagePayload) {
    const mirror = deps.getClientMirror(session);
    if (!mirror || mirror.lifecycle !== 'ready') {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: 'Session is not ready for image paste', code: 'session_not_ready' },
      });
      return;
    }

    try {
      const { sourcePath, pngPath, bytes } = persistClipboardImage(payload);
      const pasteSequence = payload.pasteSequence || '\x16';
      deps.writeToLiveMirror(mirror.sessionName, pasteSequence, false);
      deps.scheduleMirrorLiveSync(mirror, 33);
      deps.sendMessage(session, {
        type: 'image-pasted',
        payload: {
          name: payload.name,
          mimeType: payload.mimeType,
          bytes,
        },
      });
      try {
        unlinkSync(sourcePath);
      } catch (error) {
        logCleanupFailure('paste-image', sourcePath, error);
      }
      try {
        unlinkSync(pngPath);
      } catch (error) {
        logCleanupFailure('paste-image', pngPath, error);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' },
      });
    }
  }

  function handleFileListRequest(session: ClientSession, payload: FileListRequestPayload) {
    const { requestId, path: requestedPath, showHidden } = payload;

    try {
      const resolvedPath = resolveFileTransferListPath(
        requestedPath,
        () => deps.readTmuxPaneCurrentPath(session.sessionName),
      );
      const entries = readdirSync(resolvedPath, { withFileTypes: true });
      const fileEntries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: number }> = [];

      for (const entry of entries) {
        if (!showHidden && entry.name.startsWith('.')) {
          continue;
        }

        try {
          const stats = statSync(join(resolvedPath, entry.name));
          fileEntries.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isDirectory() ? 0 : stats.size,
            modified: stats.mtimeMs,
          });
        } catch {
          // Skip entries we can't stat
        }
      }

      fileEntries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      const parentPath = resolvedPath === '/' ? null : resolve(resolvedPath, '..');

      deps.sendMessage(session, {
        type: 'file-list-response',
        payload: { requestId, path: resolvedPath, parentPath, entries: fileEntries },
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-list-error',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function handleFileCreateDirectoryRequest(session: ClientSession, payload: FileCreateDirectoryRequestPayload) {
    const { requestId, path: requestedPath, name: requestedName } = payload;

    try {
      const resolvedPath = resolveFileTransferListPath(
        requestedPath,
        () => deps.readTmuxPaneCurrentPath(session.sessionName),
      );
      const directoryName = requestedName.trim();
      if (!directoryName) {
        throw new Error('directory name required');
      }
      if (directoryName === '.' || directoryName === '..' || directoryName.includes('/') || directoryName.includes('\\')) {
        throw new Error('invalid directory name');
      }
      mkdirSync(join(resolvedPath, directoryName), { recursive: false });
      deps.sendMessage(session, {
        type: 'file-create-directory-complete',
        payload: { requestId, path: resolvedPath, name: directoryName },
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-create-directory-error',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function handleFileDownloadRequest(session: ClientSession, payload: FileDownloadRequestPayload) {
    const { requestId, remotePath, fileName } = payload;

    try {
      if (!existsSync(remotePath)) {
        deps.sendMessage(session, {
          type: 'file-download-error',
          payload: { requestId, error: 'File not found' },
        });
        return;
      }

      const fileBuffer = readFileSync(remotePath);
      sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-download-error',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function handleRemoteScreenshotRequest(session: ClientSession, payload: RemoteScreenshotRequestPayload) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    if (!requestId) {
      deps.sendMessage(session, {
        type: 'file-download-error',
        payload: { requestId: '', error: 'remote-screenshot-request missing requestId' },
      });
      return;
    }

    if (deps.platform !== 'darwin') {
      deps.sendMessage(session, {
        type: 'file-download-error',
        payload: { requestId, error: `Remote screenshot unsupported on platform: ${deps.platform}` },
      });
      return;
    }

    const fileName = buildRemoteScreenshotFileName();
    const tempPath = join(deps.wtermHomeDir, fileName);

    deps.sendMessage(session, {
      type: 'remote-screenshot-status',
      payload: { requestId, phase: 'capturing', fileName },
    });

    mkdirSync(deps.wtermHomeDir, { recursive: true });

    try {
      const captureResult = await requestRemoteScreenshotViaHelper({
        outputPath: tempPath,
        timeoutMs: REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
      });
      const fileBuffer = readFileSync(captureResult.outputPath);
      deps.sendMessage(session, {
        type: 'remote-screenshot-status',
        payload: {
          requestId,
          phase: 'transferring',
          fileName,
          receivedChunks: 0,
          totalChunks: Math.max(1, Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE)),
          totalBytes: fileBuffer.length,
        },
      });
      sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-download-error',
        payload: {
          requestId,
          error: resolveRemoteScreenshotErrorMessage(error, REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS),
        },
      });
    } finally {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // ignore cleanup failure
      }
    }
  }

  function handleFileUploadStart(session: ClientSession, payload: FileUploadStartPayload) {
    const { requestId, targetDir, fileName, fileSize, chunkCount } = payload;

    mkdirSync(targetDir, { recursive: true });

    pendingUploads.set(requestId, {
      targetDir,
      fileName,
      fileSize,
      chunks: new Map(),
      totalChunks: chunkCount,
      receivedChunks: 0,
    });

    deps.sendMessage(session, {
      type: 'file-upload-progress',
      payload: { requestId, chunkIndex: 0, totalChunks: chunkCount },
    });
  }

  function handleFileUploadChunk(session: ClientSession, payload: FileUploadChunkPayload) {
    const { requestId, chunkIndex, dataBase64 } = payload;
    const upload = pendingUploads.get(requestId);

    if (!upload) {
      deps.sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
      return;
    }

    upload.chunks.set(chunkIndex, Buffer.from(dataBase64, 'base64'));
    upload.receivedChunks += 1;

    deps.sendMessage(session, {
      type: 'file-upload-progress',
      payload: { requestId, chunkIndex: upload.receivedChunks, totalChunks: upload.totalChunks },
    });
  }

  function handleFileUploadEnd(session: ClientSession, payload: FileUploadEndPayload) {
    const { requestId } = payload;
    const upload = pendingUploads.get(requestId);

    if (!upload) {
      deps.sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
      return;
    }

    try {
      const sortedChunks: Buffer[] = [];
      for (let i = 0; i < upload.totalChunks; i += 1) {
        const chunk = upload.chunks.get(i);
        if (!chunk) {
          throw new Error(`Missing chunk ${i}`);
        }
        sortedChunks.push(chunk);
      }

      const filePath = join(upload.targetDir, upload.fileName);
      const fileBuffer = Buffer.concat(sortedChunks);
      writeFileSync(filePath, fileBuffer);

      deps.sendMessage(session, {
        type: 'file-upload-complete',
        payload: { requestId, filePath, bytes: fileBuffer.length },
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-upload-error',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      pendingUploads.delete(requestId);
    }
  }

  function handleAttachFileBinary(session: ClientSession, buffer: Buffer) {
    const pendingTransfer = session.pendingAttachFile;
    const consume = consumePendingBinaryTransfer<AttachFileStartPayload>(pendingTransfer, buffer);
    session.pendingAttachFile = consume.pending;

    if (!pendingTransfer) {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: 'No pending attach-file when binary arrived', code: 'attach_file_no_pending' },
      });
      return;
    }
    if (consume.error) {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: consume.error, code: 'attach_file_size_mismatch' },
      });
      return;
    }
    if (!consume.complete) {
      return;
    }

    const mirror = deps.getClientMirror(session);
    if (!mirror || mirror.lifecycle !== 'ready') {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: 'Session is not ready for file attach', code: 'session_not_ready' },
      });
      return;
    }

    try {
      const payload = pendingTransfer.payload;
      mkdirSync(deps.downloadsDir, { recursive: true });
      const targetPath = join(deps.downloadsDir, payload.name);
      writeFileSync(targetPath, consume.complete);
      deps.writeToTmuxSession(mirror.sessionName, targetPath, true);
      deps.scheduleMirrorLiveSync(mirror, 33);

      deps.sendMessage(session, {
        type: 'file-attached',
        payload: {
          name: payload.name,
          path: targetPath,
          bytes: consume.complete.length,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: `Failed to attach file: ${err}`, code: 'attach_file_failed' },
      });
    }
  }

  function handlePasteImageBinary(session: ClientSession, buffer: Buffer) {
    const pendingTransfer = session.pendingPasteImage;
    const consume = consumePendingBinaryTransfer<PasteImageStartPayload>(pendingTransfer, buffer);
    session.pendingPasteImage = consume.pending;

    if (!pendingTransfer) {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: 'No pending paste-image when binary arrived', code: 'paste_image_no_pending' },
      });
      return;
    }
    if (consume.error) {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: consume.error, code: 'paste_image_size_mismatch' },
      });
      return;
    }
    if (!consume.complete) {
      return;
    }

    const mirror = deps.getClientMirror(session);
    if (!mirror || mirror.lifecycle !== 'ready') {
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: 'Session is not ready for image paste', code: 'session_not_ready' },
      });
      return;
    }

    try {
      const pending = pendingTransfer.payload;
      const { sourcePath, pngPath, bytes } = persistClipboardImageBuffer(
        {
          name: pending.name,
          mimeType: pending.mimeType,
        },
        consume.complete,
      );
      const pasteSequence = pending.pasteSequence || '\x16';
      deps.writeToLiveMirror(mirror.sessionName, pasteSequence, false);
      deps.scheduleMirrorLiveSync(mirror, 33);
      deps.sendMessage(session, {
        type: 'image-pasted',
        payload: {
          name: pending.name,
          mimeType: pending.mimeType,
          bytes,
        },
      });
      try {
        unlinkSync(sourcePath);
      } catch (error) {
        logCleanupFailure('paste-image-binary', sourcePath, error);
      }
      try {
        unlinkSync(pngPath);
      } catch (error) {
        logCleanupFailure('paste-image-binary', pngPath, error);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      deps.sendMessage(session, {
        type: 'error',
        payload: { message: `Failed to paste image: ${err}`, code: 'paste_image_failed' },
      });
    }
  }

  function handleBinaryPayload(session: ClientSession, buffer: Buffer) {
    if (session.pendingAttachFile) {
      handleAttachFileBinary(session, buffer);
      return;
    }
    handlePasteImageBinary(session, buffer);
  }

  return {
    handlePasteImage,
    handleFileListRequest,
    handleFileCreateDirectoryRequest,
    handleFileDownloadRequest,
    handleRemoteScreenshotRequest,
    handleFileUploadStart,
    handleFileUploadChunk,
    handleFileUploadEnd,
    handleBinaryPayload,
  };
}
