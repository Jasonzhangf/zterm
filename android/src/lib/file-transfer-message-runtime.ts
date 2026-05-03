import type {
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  RemoteScreenshotStatusPayload,
  ServerMessage,
} from './types';

type FileTransferMessage =
  Extract<
    ServerMessage,
    | { type: 'file-list-response' }
    | { type: 'file-list-error' }
    | { type: 'remote-screenshot-status' }
    | { type: 'file-download-chunk' }
    | { type: 'file-download-complete' }
    | { type: 'file-download-error' }
    | { type: 'file-upload-progress' }
    | { type: 'file-upload-complete' }
    | { type: 'file-upload-error' }
  >;

export function isFileTransferMessage(msg: ServerMessage): msg is FileTransferMessage {
  return msg.type === 'file-list-response'
    || msg.type === 'file-list-error'
    || msg.type === 'remote-screenshot-status'
    || msg.type === 'file-download-chunk'
    || msg.type === 'file-download-complete'
    || msg.type === 'file-download-error'
    || msg.type === 'file-upload-progress'
    || msg.type === 'file-upload-complete'
    || msg.type === 'file-upload-error';
}

export function createFileTransferMessageRuntime(input: {
  onRemoteScreenshotStatus?: (payload: RemoteScreenshotStatusPayload) => void;
  onRemoteScreenshotChunk?: (payload: FileDownloadChunkPayload) => void;
  onRemoteScreenshotComplete?: (payload: FileDownloadCompletePayload) => void;
  onRemoteScreenshotError?: (payload: FileDownloadErrorPayload) => void;
  onListenerError?: (phase: string, error: unknown) => void;
}) {
  const listeners = new Set<(msg: FileTransferMessage) => void>();

  const notify = (msg: FileTransferMessage, phase: string) => {
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (error) {
        input.onListenerError?.(phase, error);
      }
    }
  };

  return {
    subscribe(handler: (msg: FileTransferMessage) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    dispatch(msg: FileTransferMessage): boolean {
      switch (msg.type) {
        case 'remote-screenshot-status':
          input.onRemoteScreenshotStatus?.(msg.payload as RemoteScreenshotStatusPayload);
          notify(msg, 'status');
          return true;
        case 'file-download-chunk':
          input.onRemoteScreenshotChunk?.(msg.payload as FileDownloadChunkPayload);
          notify(msg, 'chunk');
          return true;
        case 'file-download-complete':
          input.onRemoteScreenshotComplete?.(msg.payload as FileDownloadCompletePayload);
          notify(msg, 'complete');
          return true;
        case 'file-download-error':
          input.onRemoteScreenshotError?.(msg.payload as FileDownloadErrorPayload);
          notify(msg, 'error');
          return true;
        case 'file-list-response':
        case 'file-list-error':
          notify(msg, 'status');
          return true;
        case 'file-upload-progress':
        case 'file-upload-complete':
        case 'file-upload-error':
          notify(msg, 'upload');
          return true;
      }
      return false;
    },
  };
}
