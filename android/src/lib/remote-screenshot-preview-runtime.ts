import type { RemoteScreenshotCapture, RemoteScreenshotStatusPayload } from './types';

export interface RemoteScreenshotPreviewState {
  phase: 'request-sent' | 'capturing' | 'transferring' | 'transfer-complete' | 'preview-ready' | 'saving' | 'failed';
  fileName: string;
  previewDataUrl?: string | null;
  rawDataBase64?: string | null;
  receivedChunks?: number;
  totalChunks?: number;
  totalBytes?: number;
  errorMessage?: string | null;
}

export type RemoteScreenshotQuickBarStatus =
  | 'idle'
  | 'capturing'
  | 'transferring'
  | 'preview-ready'
  | 'saving'
  | 'failed';

interface RemoteScreenshotPreviewRuntimeOptions {
  now?: () => number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export function buildRemoteScreenshotPreviewBlob(capture: RemoteScreenshotCapture) {
  const binary = capture.dataBytes
    ?? Uint8Array.from(atob(capture.dataBase64), (char) => char.charCodeAt(0));
  return new Blob([binary.buffer as ArrayBuffer], { type: capture.mimeType || 'image/png' });
}

export function resolveRemoteScreenshotQuickBarStatus(
  state: RemoteScreenshotPreviewState | null,
): RemoteScreenshotQuickBarStatus {
  switch (state?.phase) {
    case 'request-sent':
    case 'capturing':
      return 'capturing';
    case 'transfer-complete':
    case 'transferring':
      return 'transferring';
    case 'preview-ready':
      return 'preview-ready';
    case 'saving':
      return 'saving';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

export function createRemoteScreenshotPreviewRuntime(
  options: RemoteScreenshotPreviewRuntimeOptions = {},
) {
  const now = options.now ?? (() => Date.now());
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));

  let requestEpoch = 0;
  let previewUrl: string | null = null;

  const revokePreviewUrl = () => {
    if (!previewUrl) {
      return;
    }
    revokeObjectUrl(previewUrl);
    previewUrl = null;
  };

  return {
    beginRequest() {
      requestEpoch += 1;
      revokePreviewUrl();
      return {
        requestEpoch,
        state: {
          phase: 'request-sent',
          fileName: `remote-screenshot-${now()}.png`,
          previewDataUrl: null,
          rawDataBase64: null,
        } satisfies RemoteScreenshotPreviewState,
      };
    },

    closePreview() {
      requestEpoch += 1;
      revokePreviewUrl();
      return null;
    },

    dispose() {
      revokePreviewUrl();
    },

    isRequestCurrent(epoch: number) {
      return requestEpoch === epoch;
    },

    applyProgress(
      current: RemoteScreenshotPreviewState | null,
      epoch: number,
      progress: RemoteScreenshotStatusPayload,
    ) {
      if (requestEpoch !== epoch) {
        return current;
      }
      return {
        phase: progress.phase,
        fileName: progress.fileName || current?.fileName || `remote-screenshot-${now()}.png`,
        previewDataUrl: current?.previewDataUrl || null,
        rawDataBase64: current?.rawDataBase64 || null,
        receivedChunks: Math.max(0, Math.floor(progress.receivedChunks || current?.receivedChunks || 0)),
        totalChunks: Math.max(0, Math.floor(progress.totalChunks || current?.totalChunks || 0)),
        totalBytes: Math.max(0, Math.floor(progress.totalBytes || current?.totalBytes || 0)),
        errorMessage: null,
      } satisfies RemoteScreenshotPreviewState;
    },

    completeCapture(
      current: RemoteScreenshotPreviewState | null,
      epoch: number,
      capture: RemoteScreenshotCapture,
    ) {
      if (requestEpoch !== epoch) {
        return current;
      }
      revokePreviewUrl();
      previewUrl = createObjectUrl(buildRemoteScreenshotPreviewBlob(capture));
      return {
        phase: 'preview-ready',
        fileName: capture.fileName,
        previewDataUrl: previewUrl,
        rawDataBase64: capture.dataBase64,
        receivedChunks: undefined,
        totalChunks: undefined,
        totalBytes: capture.totalBytes,
        errorMessage: null,
      } satisfies RemoteScreenshotPreviewState;
    },

    failCapture(
      current: RemoteScreenshotPreviewState | null,
      epoch: number,
      error: unknown,
    ) {
      if (requestEpoch !== epoch) {
        return current;
      }
      return {
        phase: 'failed',
        fileName: current?.fileName || `remote-screenshot-${now()}.png`,
        previewDataUrl: null,
        rawDataBase64: null,
        receivedChunks: current?.receivedChunks,
        totalChunks: current?.totalChunks,
        totalBytes: current?.totalBytes,
        errorMessage: error instanceof Error ? error.message : '远程截图失败',
      } satisfies RemoteScreenshotPreviewState;
    },

    markTransferComplete(current: RemoteScreenshotPreviewState | null, epoch: number, capture: RemoteScreenshotCapture) {
      if (requestEpoch !== epoch || !current) {
        return current;
      }
      return {
        ...current,
        phase: 'transfer-complete',
        fileName: capture.fileName,
        totalBytes: capture.totalBytes,
      } satisfies RemoteScreenshotPreviewState;
    },

    beginSave(current: RemoteScreenshotPreviewState | null) {
      if (!current || current.phase !== 'preview-ready') {
        return current;
      }
      return {
        ...current,
        phase: 'saving',
      } satisfies RemoteScreenshotPreviewState;
    },

    restorePreviewReady(current: RemoteScreenshotPreviewState | null) {
      if (!current || current.phase !== 'saving') {
        return current;
      }
      return {
        ...current,
        phase: 'preview-ready',
      } satisfies RemoteScreenshotPreviewState;
    },
  };
}

export async function persistRemoteScreenshotCaptureRuntime<TDirectory>(options: {
  fileName: string;
  dataBase64: string;
  downloadDir?: string;
  directory: TDirectory;
  mkdir: (input: { path: string; directory: TDirectory; recursive: boolean }) => Promise<unknown>;
  writeFile: (input: { path: string; data: string; directory: TDirectory }) => Promise<unknown>;
}) {
  const downloadDir = options.downloadDir || '/storage/emulated/0/Download/zterm';
  try {
    await options.mkdir({
      path: downloadDir,
      directory: options.directory,
      recursive: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alreadyExists = /exist/i.test(message) || /EEXIST/i.test(message);
    if (!alreadyExists) {
      throw new Error(`创建截图保存目录失败: ${message}`);
    }
  }

  const savedPath = `${downloadDir}/${options.fileName}`;
  await options.writeFile({
    path: savedPath,
    data: options.dataBase64,
    directory: options.directory,
  });
  return savedPath;
}
