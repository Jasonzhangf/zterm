import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import type {
  AttachFileStartPayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  FileUploadStartPayload,
  PasteImagePayload,
  PasteImageStartPayload,
} from '@zterm/shared/protocol';
import type { TerminalSession, PendingBinaryTransfer } from './terminal-runtime-types';
import type {
  PendingUploadState,
  TerminalFileTransferRuntimeDeps,
} from './terminal-file-transfer-types';

export interface TerminalFileTransferBinaryRuntime {
  handlePasteImage: (session: TerminalSession, payload: PasteImagePayload) => void;
  handleFileUploadStart: (session: TerminalSession, payload: FileUploadStartPayload) => void;
  handleFileUploadChunk: (session: TerminalSession, payload: FileUploadChunkPayload) => void;
  handleFileUploadEnd: (session: TerminalSession, payload: FileUploadEndPayload) => void;
  handleBinaryPayload: (session: TerminalSession, buffer: Buffer) => void;
}

export function createTerminalFileTransferBinaryRuntime(
  deps: TerminalFileTransferRuntimeDeps,
): TerminalFileTransferBinaryRuntime {
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

  function logCleanupFailure(scope: string, filePath: string, error: unknown) {
    console.warn(
      `[${deps.logTimePrefix()}] ${scope} cleanup failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

  function cleanupClipboardImageFiles(sourcePath: string, pngPath: string) {
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
  }

  function sendImagePasted(session: TerminalSession, payload: { name: string; mimeType: string }, bytes: number) {
    deps.sendMessage(session, {
      type: 'image-pasted',
      payload: {
        name: payload.name,
        mimeType: payload.mimeType,
        bytes,
      },
    });
  }

  function sendImagePasteError(session: TerminalSession, message: string) {
    deps.sendMessage(session, {
      type: 'error',
      payload: { message: `Failed to paste image: ${message}`, code: 'paste_image_failed' },
    });
  }

  function emitImagePaste(
    session: TerminalSession,
    payload: {
      name: string;
      mimeType: string;
      pasteSequence?: string;
      pasteTarget?: PasteImageStartPayload['pasteTarget'];
    },
    bufferFactory: () => { sourcePath: string; pngPath: string; bytes: number },
  ) {
    try {
      const { sourcePath, pngPath, bytes } = bufferFactory();
      if (payload.pasteTarget?.kind === 'remote-window') {
        if (!deps.pasteImageToRemoteWindow) {
          cleanupClipboardImageFiles(sourcePath, pngPath);
          sendImagePasteError(session, 'remote window image paste is not available');
          return;
        }
        void Promise.resolve(deps.pasteImageToRemoteWindow(session, payload.pasteTarget, {
          name: payload.name,
          mimeType: payload.mimeType,
          bytes,
        })).then(() => {
          sendImagePasted(session, payload, bytes);
          cleanupClipboardImageFiles(sourcePath, pngPath);
        }).catch((error) => {
          cleanupClipboardImageFiles(sourcePath, pngPath);
          sendImagePasteError(session, error instanceof Error ? error.message : String(error));
        });
        return;
      }

      const mirror = deps.getSessionMirror(session);
      if (!mirror || mirror.lifecycle !== 'ready') {
        cleanupClipboardImageFiles(sourcePath, pngPath);
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: 'Session is not ready for image paste', code: 'session_not_ready' },
        });
        return;
      }
      const pasteSequence = payload.pasteSequence || '\x16';
      deps.writeToLiveMirror(mirror.sessionName, pasteSequence, false);
      deps.scheduleMirrorLiveSync(mirror, 33);
      sendImagePasted(session, payload, bytes);
      cleanupClipboardImageFiles(sourcePath, pngPath);
    } catch (error) {
      sendImagePasteError(session, error instanceof Error ? error.message : String(error));
    }
  }

  function handlePasteImage(session: TerminalSession, payload: PasteImagePayload) {
    emitImagePaste(session, payload, () => persistClipboardImage(payload));
  }

  function handleFileUploadStart(session: TerminalSession, payload: FileUploadStartPayload) {
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

  function handleFileUploadChunk(session: TerminalSession, payload: FileUploadChunkPayload) {
    const { requestId, chunkIndex, dataBase64 } = payload;
    const upload = pendingUploads.get(requestId);

    if (!upload) {
      deps.sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
      return;
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.totalChunks) {
      pendingUploads.delete(requestId);
      deps.sendMessage(session, {
        type: 'file-upload-error',
        payload: { requestId, error: `Invalid chunk index ${chunkIndex} for ${upload.totalChunks} chunks` },
      });
      return;
    }

    const chunk = Buffer.from(dataBase64, 'base64');
    const existing = upload.chunks.get(chunkIndex);
    if (existing && !existing.equals(chunk)) {
      pendingUploads.delete(requestId);
      deps.sendMessage(session, {
        type: 'file-upload-error',
        payload: { requestId, error: `Conflicting duplicate chunk ${chunkIndex}` },
      });
      return;
    }
    if (!existing) {
      upload.chunks.set(chunkIndex, chunk);
    }
    while (upload.chunks.has(upload.receivedChunks)) {
      upload.receivedChunks += 1;
    }

    deps.sendMessage(session, {
      type: 'file-upload-progress',
      payload: { requestId, chunkIndex: upload.receivedChunks, totalChunks: upload.totalChunks },
    });
  }

  function handleFileUploadEnd(session: TerminalSession, payload: FileUploadEndPayload) {
    const { requestId } = payload;
    const upload = pendingUploads.get(requestId);

    if (!upload) {
      deps.sendMessage(session, { type: 'file-upload-error', payload: { requestId, error: 'No pending upload' } });
      return;
    }

    try {
      if (upload.receivedChunks !== upload.totalChunks || upload.chunks.size !== upload.totalChunks) {
        throw new Error(
          `Upload incomplete: acknowledged ${upload.receivedChunks} of ${upload.totalChunks} chunks`,
        );
      }
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
      if (fileBuffer.length !== upload.fileSize) {
        throw new Error(
          `Upload size mismatch: received ${fileBuffer.length} bytes, expected ${upload.fileSize}`,
        );
      }
      writeFileSync(filePath, fileBuffer);
      const persistedBytes = statSync(filePath).size;
      if (persistedBytes !== upload.fileSize) {
        throw new Error(
          `Upload persisted size mismatch: wrote ${persistedBytes} bytes, expected ${upload.fileSize}`,
        );
      }

      deps.sendMessage(session, {
        type: 'file-upload-complete',
        payload: { requestId, filePath, bytes: persistedBytes },
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

  function handleAttachFileBinary(session: TerminalSession, buffer: Buffer) {
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

    const mirror = deps.getSessionMirror(session);
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

  function handlePasteImageBinary(session: TerminalSession, buffer: Buffer) {
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

    const pending = pendingTransfer.payload;
    emitImagePaste(session, pending, () => persistClipboardImageBuffer(
      {
        name: pending.name,
        mimeType: pending.mimeType,
      },
      consume.complete!,
    ));
  }

  function handleBinaryPayload(session: TerminalSession, buffer: Buffer) {
    if (session.pendingAttachFile) {
      handleAttachFileBinary(session, buffer);
      return;
    }
    handlePasteImageBinary(session, buffer);
  }

  return {
    handlePasteImage,
    handleFileUploadStart,
    handleFileUploadChunk,
    handleFileUploadEnd,
    handleBinaryPayload,
  };
}
