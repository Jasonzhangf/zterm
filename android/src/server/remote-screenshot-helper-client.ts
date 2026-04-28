import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export const DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH = join(
  homedir(),
  '.wterm',
  'run',
  'remote-screenshot-helper.sock',
);

interface RemoteScreenshotHelperRequest {
  type: 'capture-screen';
  requestId: string;
  outputPath: string;
}

type RemoteScreenshotHelperResponse =
  | { type: 'capture-started'; requestId: string }
  | { type: 'capture-completed'; requestId: string; outputPath: string }
  | { type: 'capture-failed'; requestId: string; error: string };

export interface RequestRemoteScreenshotViaHelperOptions {
  outputPath: string;
  timeoutMs: number;
  socketPath?: string;
}

export async function requestRemoteScreenshotViaHelper(
  options: RequestRemoteScreenshotViaHelperOptions,
): Promise<{ outputPath: string }> {
  const socketPath = options.socketPath || DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH;
  const requestId = uuidv4();
  const request: RemoteScreenshotHelperRequest = {
    type: 'capture-screen',
    requestId,
    outputPath: options.outputPath,
  };

  return await new Promise<{ outputPath: string }>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';

    const timeout = setTimeout(() => {
      fail(new Error(`remote screenshot helper timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    const succeed = (result: { outputPath: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const normalizeConnectionError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        return new Error('remote screenshot helper not running');
      }
      return error;
    };

    const handleResponse = (response: RemoteScreenshotHelperResponse) => {
      if (!response || response.requestId !== requestId) {
        return;
      }

      switch (response.type) {
        case 'capture-started':
          return;
        case 'capture-completed':
          succeed({
            outputPath:
              typeof response.outputPath === 'string' && response.outputPath.trim().length > 0
                ? response.outputPath
                : options.outputPath,
          });
          return;
        case 'capture-failed':
          fail(new Error(response.error || 'remote screenshot helper failed'));
          return;
      }
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            handleResponse(JSON.parse(line) as RemoteScreenshotHelperResponse);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      fail(normalizeConnectionError(error));
    });
    socket.on('end', () => {
      if (!settled) {
        fail(new Error('remote screenshot helper closed before completion'));
      }
    });
    socket.on('close', (hadError) => {
      if (!settled && !hadError) {
        fail(new Error('remote screenshot helper closed before completion'));
      }
    });
  });
}
