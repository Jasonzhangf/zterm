import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
} from 'fs';
import { join, resolve } from 'path';
import type {
  FileCreateDirectoryRequestPayload,
  FileDownloadRequestPayload,
  FileListRequestPayload,
  RemoteScreenshotRequestPayload,
  RemoteWindowStreamRect,
} from '@zterm/shared/protocol';
import { resolveFileTransferListPath } from './file-transfer-path';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';
import type { TerminalSession } from './terminal-runtime-types';
import {
  FILE_CHUNK_SIZE,
  REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
  type TerminalFileTransferRuntimeDeps,
} from './terminal-file-transfer-types';

function logFileTransferRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>) {
  console.error(`[terminal-file-transfer-list-runtime] ${scope}`, {
    error: error instanceof Error ? error.message : String(error),
    ...context,
  });
}

export interface TerminalFileTransferListRuntime {
  handleFileListRequest: (session: TerminalSession, payload: FileListRequestPayload) => void;
  handleFileCreateDirectoryRequest: (session: TerminalSession, payload: FileCreateDirectoryRequestPayload) => void;
  handleFileDownloadRequest: (session: TerminalSession, payload: FileDownloadRequestPayload) => void;
  handleRemoteScreenshotRequest: (session: TerminalSession, payload: RemoteScreenshotRequestPayload) => Promise<void>;
  refreshDirectoryCache: (path: string) => void;
  dispose: () => void;
}

type RemoteDirectoryEntry = { name: string; type: 'file' | 'directory'; size: number; modified: number };
const MAX_REMOTE_DIRECTORY_CACHE_ENTRIES = 32;

interface RemoteDirectoryCacheEntry {
  path: string;
  parentPath: string | null;
  entries: RemoteDirectoryEntry[];
  watcher: FSWatcher | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  lastAccessedAt: number;
}

export function createTerminalFileTransferListRuntime(
  deps: TerminalFileTransferRuntimeDeps,
): TerminalFileTransferListRuntime {
  const directoryCache = new Map<string, RemoteDirectoryCacheEntry>();

  function readDirectorySnapshot(resolvedPath: string) {
    const entries = readdirSync(resolvedPath, { withFileTypes: true });
    const fileEntries: RemoteDirectoryEntry[] = [];

    for (const entry of entries) {
      try {
        const stats = statSync(join(resolvedPath, entry.name));
        fileEntries.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isDirectory() ? 0 : stats.size,
          modified: stats.mtimeMs,
        });
      } catch (error) {
        logFileTransferRuntimeError('stat entry failed', error, {
          path: resolvedPath,
          entryName: entry.name,
        });
      }
    }

    fileEntries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      path: resolvedPath,
      parentPath: resolvedPath === '/' ? null : resolve(resolvedPath, '..'),
      entries: fileEntries,
    };
  }

  function refreshDirectoryCache(resolvedPath: string) {
    const previous = directoryCache.get(resolvedPath);
    const snapshot = readDirectorySnapshot(resolvedPath);
    const next: RemoteDirectoryCacheEntry = {
      ...snapshot,
      watcher: previous?.watcher ?? null,
      refreshTimer: previous?.refreshTimer ?? null,
      lastAccessedAt: Date.now(),
    };
    directoryCache.set(resolvedPath, next);
    evictStaleDirectoryCacheEntries();
    return next;
  }

  function closeDirectoryCacheEntry(entry: RemoteDirectoryCacheEntry) {
    if (entry.refreshTimer) {
      clearTimeout(entry.refreshTimer);
      entry.refreshTimer = null;
    }
    if (entry.watcher) {
      entry.watcher.close();
      entry.watcher = null;
    }
  }

  function evictStaleDirectoryCacheEntries() {
    while (directoryCache.size > MAX_REMOTE_DIRECTORY_CACHE_ENTRIES) {
      let oldestPath: string | null = null;
      let oldestAccessedAt = Number.POSITIVE_INFINITY;
      for (const [path, entry] of directoryCache.entries()) {
        if (entry.lastAccessedAt < oldestAccessedAt) {
          oldestPath = path;
          oldestAccessedAt = entry.lastAccessedAt;
        }
      }
      if (!oldestPath) {
        return;
      }
      const oldest = directoryCache.get(oldestPath);
      if (oldest) {
        closeDirectoryCacheEntry(oldest);
      }
      directoryCache.delete(oldestPath);
    }
  }

  function scheduleDirectoryCacheRefresh(resolvedPath: string) {
    const current = directoryCache.get(resolvedPath);
    if (!current || current.refreshTimer) {
      return;
    }
    current.refreshTimer = setTimeout(() => {
      const pending = directoryCache.get(resolvedPath);
      if (pending) {
        pending.refreshTimer = null;
      }
      try {
        refreshDirectoryCache(resolvedPath);
      } catch (error) {
        const failed = directoryCache.get(resolvedPath);
        if (failed) {
          closeDirectoryCacheEntry(failed);
        }
        directoryCache.delete(resolvedPath);
        logFileTransferRuntimeError('refresh cached directory failed', error, {
          path: resolvedPath,
        });
      }
    }, 50);
  }

  function watchDirectoryCache(resolvedPath: string) {
    const current = directoryCache.get(resolvedPath);
    if (!current || current.watcher) {
      return true;
    }
    try {
      const watcher = watch(resolvedPath, { persistent: false }, () => {
        scheduleDirectoryCacheRefresh(resolvedPath);
      });
      watcher.on('error', (error) => {
        const cached = directoryCache.get(resolvedPath);
        if (cached?.watcher === watcher) {
          closeDirectoryCacheEntry(cached);
          directoryCache.delete(resolvedPath);
        }
        logFileTransferRuntimeError('directory watcher failed', error, {
          path: resolvedPath,
        });
      });
      current.watcher = watcher;
      return true;
    } catch (error) {
      closeDirectoryCacheEntry(current);
      directoryCache.delete(resolvedPath);
      logFileTransferRuntimeError('watch cached directory failed', error, {
        path: resolvedPath,
      });
      return false;
    }
  }

  function getDirectoryCache(resolvedPath: string) {
    const cached = directoryCache.get(resolvedPath) ?? refreshDirectoryCache(resolvedPath);
    cached.lastAccessedAt = Date.now();
    const watchReady = watchDirectoryCache(resolvedPath);
    if (!watchReady) {
      return cached;
    }
    return directoryCache.get(resolvedPath) ?? cached;
  }

  function refreshDirectoryCacheFromPath(path: string) {
    const resolvedPath = resolveFileTransferListPath(path, () => path);
    try {
      refreshDirectoryCache(resolvedPath);
      watchDirectoryCache(resolvedPath);
    } catch (error) {
      const failed = directoryCache.get(resolvedPath);
      if (failed) {
        closeDirectoryCacheEntry(failed);
      }
      directoryCache.delete(resolvedPath);
      logFileTransferRuntimeError('refresh cached directory on demand failed', error, {
        path: resolvedPath,
      });
    }
  }

  function dispose() {
    for (const entry of directoryCache.values()) {
      closeDirectoryCacheEntry(entry);
    }
    directoryCache.clear();
  }

  function projectDirectoryEntries(cacheEntry: RemoteDirectoryCacheEntry, showHidden: boolean) {
    return showHidden
      ? cacheEntry.entries
      : cacheEntry.entries.filter((entry) => !entry.name.startsWith('.'));
  }

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

  function buildRemoteScreenshotFileName(prefix = 'remote-screenshot') {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const safePrefix = prefix
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'remote-screenshot';
    return `${safePrefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  }

  function normalizeRemoteScreenshotRect(rect: RemoteWindowStreamRect | undefined, label: string): RemoteWindowStreamRect {
    if (!rect) {
      throw new Error(`${label} requires a capture rectangle`);
    }
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every((value) => Number.isFinite(value))) {
      throw new Error(`${label} capture rectangle is invalid`);
    }
    const normalized = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    if (normalized.width <= 0 || normalized.height <= 0) {
      throw new Error(`${label} capture rectangle must have positive size`);
    }
    if (normalized.width > 20000 || normalized.height > 20000) {
      throw new Error(`${label} capture rectangle is too large`);
    }
    return normalized;
  }

  function resolveRemoteScreenshotCaptureRequest(payload: RemoteScreenshotRequestPayload): {
    fileName: string;
    windowId?: string;
    rect?: RemoteWindowStreamRect;
  } {
    const targetPayload = payload.target;
    if (!targetPayload) {
      return {
        fileName: buildRemoteScreenshotFileName(),
      };
    }
    if (targetPayload.kind !== 'remote-window' || !targetPayload.target) {
      throw new Error('remote screenshot target is invalid');
    }
    const target = targetPayload.target;
    const title = target.videoTarget.title || target.videoTarget.appBundleId || target.streamTargetId || 'window';
    if (target.videoTarget.kind === 'app-window') {
      const windowId = String(target.videoTarget.windowId || '').trim();
      if (!/^\d+$/u.test(windowId)) {
        throw new Error('remote window screenshot requires a numeric macOS window id');
      }
      return {
        fileName: buildRemoteScreenshotFileName(`remote-window-screenshot-${title}`),
        windowId,
      };
    }
    return {
      fileName: buildRemoteScreenshotFileName(`remote-window-screenshot-${title}`),
      rect: normalizeRemoteScreenshotRect(
        target.videoTarget.cropRectTopLeftPx,
        'remote window pane screenshot',
      ),
    };
  }

  function handleFileListRequest(session: TerminalSession, payload: FileListRequestPayload) {
    const { requestId, path: requestedPath, showHidden } = payload;

    try {
      const resolvedPath = resolveFileTransferListPath(
        requestedPath,
        () => deps.readTmuxPaneCurrentPath(session.sessionName, session.backend),
      );
      const cacheEntry = getDirectoryCache(resolvedPath);

      deps.sendMessage(session, {
        type: 'file-list-response',
        payload: {
          requestId,
          path: cacheEntry.path,
          parentPath: cacheEntry.parentPath,
          entries: projectDirectoryEntries(cacheEntry, showHidden),
        },
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
        () => deps.readTmuxPaneCurrentPath(session.sessionName, session.backend),
      );
      const directoryName = requestedName.trim();
      if (!directoryName) {
        throw new Error('directory name required');
      }
      if (directoryName === '.' || directoryName === '..' || directoryName.includes('/') || directoryName.includes('\\')) {
        throw new Error('invalid directory name');
      }
      mkdirSync(join(resolvedPath, directoryName), { recursive: false });
      try {
        refreshDirectoryCache(resolvedPath);
        watchDirectoryCache(resolvedPath);
      } catch (error) {
        logFileTransferRuntimeError('refresh cached directory after mkdir failed', error, {
          path: resolvedPath,
        });
      }
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

    let captureRequest: ReturnType<typeof resolveRemoteScreenshotCaptureRequest>;
    try {
      captureRequest = resolveRemoteScreenshotCaptureRequest(payload);
    } catch (error) {
      deps.sendMessage(session, {
        type: 'file-download-error',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    const fileName = captureRequest.fileName;
    const tempPath = join(deps.wtermHomeDir, fileName);

    deps.sendMessage(session, {
      type: 'remote-screenshot-status',
      payload: { requestId, phase: 'capturing', fileName },
    });

    mkdirSync(deps.wtermHomeDir, { recursive: true });

    try {
      const captureResult = await deps.captureRemoteScreenshot({
        outputPath: tempPath,
        timeoutMs: REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
        ...(captureRequest.windowId ? { windowId: captureRequest.windowId } : {}),
        ...(captureRequest.rect ? { rect: captureRequest.rect } : {}),
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
      } catch (error) {
        logFileTransferRuntimeError('remote screenshot cleanup failed', error, {
          sessionName: session.sessionName,
          path: tempPath,
        });
      }
    }
  }

  return {
    handleFileListRequest,
    handleFileCreateDirectoryRequest,
    handleFileDownloadRequest,
    handleRemoteScreenshotRequest,
    refreshDirectoryCache: refreshDirectoryCacheFromPath,
    dispose,
  };
}
