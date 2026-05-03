import type { Transport } from '../transport/TransportManager';

export interface FileTransferProgress {
  loaded: number;
  total: number;
  percent: number;
}

export type FileTransferCallbacks = {
  onProgress?: (progress: FileTransferProgress) => void;
  onComplete?: (data: Uint8Array | string) => void;
  onError?: (error: Error) => void;
};

type ActiveTransfer = {
  sessionId: string;
  type: 'upload' | 'download';
  callbacks: FileTransferCallbacks;
  chunks: Uint8Array[];
  expectedSize?: number;
  receivedBytes: number;
};

export class FileTransferCoordinator {
  private activeTransfers = new Map<string, ActiveTransfer>();
  private getTransport: (sessionId: string) => Transport | null;
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB

  constructor(getTransport: (sessionId: string) => Transport | null) {
    this.getTransport = getTransport;
  }

  async uploadFile(
    sessionId: string,
    file: File,
    callbacks: FileTransferCallbacks
  ): Promise<void> {
    const transport = this.getTransport(sessionId);
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      throw new Error('Transport not ready');
    }

    const transferId = `upload-${sessionId}-${Date.now()}`;
    const total = file.size;
    let loaded = 0;

    this.activeTransfers.set(transferId, {
      sessionId,
      type: 'upload',
      callbacks,
      chunks: [],
      receivedBytes: 0,
    });

    try {
      // 发送开始消息
      transport.send(JSON.stringify({
        type: 'file-transfer-upload-start',
        payload: { fileName: file.name, fileSize: total },
      }));

      // 分片读取并发送
      const reader = new FileReader();
      let offset = 0;
      const readChunk = () => {
        const slice = file.slice(offset, offset + this.CHUNK_SIZE);
        reader.onload = async (e) => {
          const buffer = e.target?.result as ArrayBuffer;
          if (buffer) {
            transport.send(buffer);
            loaded += buffer.byteLength;
            callbacks.onProgress?.({ loaded, total, percent: (loaded / total) * 100 });
            offset += buffer.byteLength;
            if (offset < total) {
              readChunk();
            } else {
              // 发送完成消息
              transport.send(JSON.stringify({ type: 'file-transfer-upload-complete' }));
              callbacks.onComplete?.(`Upload complete: ${file.name}`);
              this.activeTransfers.delete(transferId);
            }
          } else {
            throw new Error('Failed to read chunk');
          }
        };
        reader.onerror = () => {
          throw new Error('FileReader error');
        };
        reader.readAsArrayBuffer(slice);
      };
      readChunk();
    } catch (err) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.activeTransfers.delete(transferId);
    }
  }

  async downloadFile(
    sessionId: string,
    remotePath: string,
    callbacks: FileTransferCallbacks
  ): Promise<void> {
    const transport = this.getTransport(sessionId);
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      throw new Error('Transport not ready');
    }

    const transferId = `download-${sessionId}-${Date.now()}`;
    this.activeTransfers.set(transferId, {
      sessionId,
      type: 'download',
      callbacks,
      chunks: [],
      receivedBytes: 0,
    });

    transport.send(JSON.stringify({
      type: 'file-transfer-download-request',
      payload: { remotePath },
    }));
  }

  handleChunk(sessionId: string, chunk: ArrayBuffer, chunkIndex: number, totalChunks: number): void {
    // 查找活跃的下载传输（从 sessionId 找最新的）
    let transfer: ActiveTransfer | undefined;
    for (const [id, t] of this.activeTransfers.entries()) {
      if (t.sessionId === sessionId && t.type === 'download') {
        transfer = t;
        break;
      }
    }
    if (!transfer) return;

    const bytes = new Uint8Array(chunk);
    transfer.chunks.push(bytes);
    transfer.receivedBytes += bytes.length;

    const progress: FileTransferProgress = {
      loaded: transfer.receivedBytes,
      total: transfer.expectedSize || 0,
      percent: transfer.expectedSize ? (transfer.receivedBytes / transfer.expectedSize) * 100 : 0,
    };
    transfer.callbacks.onProgress?.(progress);
  }

  handleComplete(sessionId: string, data: Uint8Array, fileName?: string): void {
    let transfer: ActiveTransfer | undefined;
    for (const [id, t] of this.activeTransfers.entries()) {
      if (t.sessionId === sessionId && t.type === 'download') {
        transfer = t;
        this.activeTransfers.delete(id);
        break;
      }
    }
    if (!transfer) return;

    // 合并所有 chunks
    const totalLength = transfer.chunks.reduce((sum, arr) => sum + arr.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of transfer.chunks) {
      merged.set(arr, offset);
      offset += arr.length;
    }
    transfer.callbacks.onComplete?.(merged);
  }

  handleError(sessionId: string, errorMsg: string): void {
    for (const [id, t] of this.activeTransfers.entries()) {
      if (t.sessionId === sessionId) {
        t.callbacks.onError?.(new Error(errorMsg));
        this.activeTransfers.delete(id);
        break;
      }
    }
  }

  dispose(sessionId: string): void {
    for (const [id, t] of this.activeTransfers.entries()) {
      if (t.sessionId === sessionId) {
        t.callbacks.onError?.(new Error('Session disconnected'));
        this.activeTransfers.delete(id);
      }
    }
  }
}
