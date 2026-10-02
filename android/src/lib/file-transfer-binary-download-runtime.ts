import type { FileTransferDownloadDestination, FileTransferDownloadStore } from './file-transfer-native-store-port';

export interface FileTransferBinaryDownloadOptions {
  requestId: string;
  remotePath: string;
  fileName: string;
  totalBytes: number;
  destination: FileTransferDownloadDestination;
  signal?: AbortSignal;
  onProgress?: (progress: {
    receivedBytes: number;
    expectedBytes: number;
  }) => void;
}

export interface FileTransferBinaryDownloadResult {
  bytes: number;
}

export function createFileTransferBinaryDownload(input: {
  resolvedPath?: string;
  host?: string;
  port?: number;
  token?: string;
  store?: FileTransferDownloadStore;
  fetch?: typeof fetch;
}) {
  function bytesToBase64(value: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < value.byteLength; i += 1) {
      binary += String.fromCharCode(value[i]);
    }
    return btoa(binary);
  }

  return async function runBinaryFileDownload(options: FileTransferBinaryDownloadOptions): Promise<FileTransferBinaryDownloadResult> {
    if (input.resolvedPath !== 'lan' && input.resolvedPath !== 'tailscale') {
      return { bytes: 0 };
    }
    if (!input.host || !input.port) {
      throw new Error('binary download requires daemon host and port');
    }
    if (!input.store) {
      throw new Error('binary download requires a download store');
    }

    const expectedBytes = Number(options.totalBytes);
    if (!Number.isInteger(expectedBytes) || expectedBytes < 0) {
      throw new Error('binary download totalBytes must be a non-negative integer');
    }

    const url = new URL('/api/v1/files/download', `http://${input.host}:${input.port}`);
    url.searchParams.set('path', options.remotePath);
    if (input.token) {
      url.searchParams.set('token', input.token);
    }

    const effectiveFetch: typeof fetch | undefined = input.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (typeof effectiveFetch !== 'function') {
      throw new Error('fetch is unavailable');
    }
    if (options.signal?.aborted) {
      throw new DOMException('Binary download aborted', 'AbortError');
    }

    const response = await effectiveFetch(url, {
      headers: input.token
        ? { authorization: `Bearer ${input.token}` }
        : undefined,
      signal: options.signal,
    });
    if (options.signal?.aborted) {
      throw new DOMException('Binary download aborted', 'AbortError');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body?.getReader?.();
    if (reader) {
      let receivedBytes = 0;
      const chunksBase64: string[] = [];
      try {
        while (true) {
          if (options.signal?.aborted) {
            throw new DOMException('Binary download aborted', 'AbortError');
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > 0) {
            chunksBase64.push(bytesToBase64(value));
          }
          receivedBytes += value.byteLength;
          options.onProgress?.({ receivedBytes, expectedBytes });
          if (receivedBytes > expectedBytes) {
            throw new Error(`binary download exceeded expected size: received ${receivedBytes}, expected ${expectedBytes}`);
          }
        }
        await input.store.persist({
          requestId: options.requestId,
          fileName: options.fileName,
          totalBytes: expectedBytes,
          chunksBase64,
          destination: options.destination,
        });
        if (receivedBytes !== expectedBytes) {
          throw new Error(`binary download size mismatch: received ${receivedBytes}, expected ${expectedBytes}`);
        }
        return { bytes: receivedBytes };
      } finally {
        reader.releaseLock();
      }
    }

    const receivedBytes = new Uint8Array(await response.arrayBuffer());
    if (receivedBytes.byteLength > expectedBytes) {
      throw new Error(`binary download exceeded expected size: received ${receivedBytes.byteLength}, expected ${expectedBytes}`);
    }
    await input.store.persist({
      requestId: options.requestId,
      fileName: options.fileName,
      totalBytes: expectedBytes,
      chunksBase64: receivedBytes.byteLength > 0 ? [bytesToBase64(receivedBytes)] : [],
      destination: options.destination,
    });
    if (receivedBytes.byteLength !== expectedBytes) {
      throw new Error(`binary download size mismatch: received ${receivedBytes.byteLength}, expected ${expectedBytes}`);
    }
    return { bytes: receivedBytes.byteLength };
  };
}
