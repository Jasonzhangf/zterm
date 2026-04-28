import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH = join(
  homedir(),
  '.wterm',
  'run',
  'remote-screenshot-helper.sock',
);
export const DEFAULT_REMOTE_SCREENSHOT_HELPER_PID_PATH = join(homedir(), '.wterm', 'run', 'remote-screenshot-helper.pid');
export const DEFAULT_REMOTE_SCREENSHOT_HELPER_STATUS_PATH = join(homedir(), '.wterm', 'run', 'remote-screenshot-helper.json');

export const DEFAULT_REMOTE_SCREENSHOT_HELPER_TIMEOUT_MS = 15000;

interface CaptureScreenRequest {
  type: 'capture-screen';
  requestId: string;
  outputPath: string;
}

type ScreenshotHelperResponse =
  | { type: 'capture-started'; requestId: string }
  | { type: 'capture-completed'; requestId: string; outputPath: string }
  | { type: 'capture-failed'; requestId: string; error: string };

export interface ScreenshotHelperServerController {
  socketPath: string;
  close: () => Promise<void>;
}

export function persistScreenshotHelperRuntimeState(socketPath: string, pid = process.pid) {
  mkdirSync(dirname(DEFAULT_REMOTE_SCREENSHOT_HELPER_PID_PATH), { recursive: true });
  writeFileSync(DEFAULT_REMOTE_SCREENSHOT_HELPER_PID_PATH, `${pid}\n`);
  writeFileSync(
    DEFAULT_REMOTE_SCREENSHOT_HELPER_STATUS_PATH,
    JSON.stringify(
      {
        pid,
        socketPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function cleanupScreenshotHelperRuntimeState() {
  rmSync(DEFAULT_REMOTE_SCREENSHOT_HELPER_PID_PATH, { force: true });
  rmSync(DEFAULT_REMOTE_SCREENSHOT_HELPER_STATUS_PATH, { force: true });
}

function sendResponse(socket: net.Socket, response: ScreenshotHelperResponse) {
  socket.write(`${JSON.stringify(response)}\n`);
}

function resolveCaptureErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error || 'remote screenshot helper failed');
}

function runCapture(request: CaptureScreenRequest, socket: net.Socket) {
  sendResponse(socket, { type: 'capture-started', requestId: request.requestId });
  execFile(
    '/usr/sbin/screencapture',
    ['-x', request.outputPath],
    { timeout: DEFAULT_REMOTE_SCREENSHOT_HELPER_TIMEOUT_MS },
    (error) => {
      if (error) {
        sendResponse(socket, {
          type: 'capture-failed',
          requestId: request.requestId,
          error: resolveCaptureErrorMessage(error),
        });
        socket.end();
        return;
      }
      sendResponse(socket, {
        type: 'capture-completed',
        requestId: request.requestId,
        outputPath: request.outputPath,
      });
      socket.end();
    },
  );
}

export async function startScreenshotHelperServer(
  socketPath = DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH,
): Promise<ScreenshotHelperServerController> {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            const request = JSON.parse(line) as CaptureScreenRequest;
            if (request.type !== 'capture-screen' || typeof request.requestId !== 'string' || typeof request.outputPath !== 'string') {
              sendResponse(socket, {
                type: 'capture-failed',
                requestId: typeof request.requestId === 'string' ? request.requestId : 'unknown',
                error: 'invalid remote screenshot helper request',
              });
              socket.end();
              return;
            }
            runCapture(request, socket);
          } catch (error) {
            sendResponse(socket, {
              type: 'capture-failed',
              requestId: 'unknown',
              error: resolveCaptureErrorMessage(error),
            });
            socket.end();
            return;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (existsSync(socketPath)) {
        rmSync(socketPath, { force: true });
      }
    },
  };
}
