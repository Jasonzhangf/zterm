import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join, resolve } from 'path';
import type {
  FileCreateDirectoryRequestPayload,
  FileDownloadRequestPayload,
  FileListRequestPayload,
  RemoteScreenshotRequestPayload,
} from '../lib/types';
import { resolveFileTransferListPath } from './file-transfer-path';
import { requestRemoteScreenshotViaHelper } from './remote-screenshot-helper-client';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';
import type { TerminalSession } from './terminal-runtime-types';
import {
  FILE_CHUNK_SIZE,
  REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
  type TerminalFileTransferRuntimeDeps,
} from './terminal-file-transfer-types';

export interface TerminalFileTransferListRuntime {
  handleFileListRequest: (session: TerminalSession, payload: FileListRequestPayload) => void;
  handleFileCreateDirectoryRequest: (session: TerminalSession, payload: FileCreateDirectoryRequestPayload) => void;
  handleFileDownloadRequest: (session: TerminalSession, payload: FileDownloadRequestPayload) => void;
  handleRemoteScreenshotRequest: (session: TerminalSession, payload: RemoteScreenshotRequestPayload) => Promise<void>;
}

export function createTerminalFileTransferListRuntime(
  deps: TerminalFileTransferRuntimeDeps,
): TerminalFileTransferListRuntime {
  function sendFileDownloadBuffer(session: TerminalSession, requestId: string, fileName: string, fileBuffer: Buffer) {
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

  function handleFileListRequest(session: TerminalSession, payload: FileListRequestPayload) {
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

  function handleFileCreateDirectoryRequest(session: TerminalSession, payload: FileCreateDirectoryRequestPayload) {
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

  function handleFileDownloadRequest(session: TerminalSession, payload: FileDownloadRequestPayload) {
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

  async function handleRemoteScreenshotRequest(session: TerminalSession, payload: RemoteScreenshotRequestPayload) {
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

  return {
    handleFileListRequest,
    handleFileCreateDirectoryRequest,
    handleFileDownloadRequest,
    handleRemoteScreenshotRequest,
  };
}
