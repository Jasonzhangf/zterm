import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestRemoteScreenshotViaHelper } from './remote-screenshot-helper-client';

function createSocketFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zrs-'));
  return {
    dir,
    socketPath: join(dir, 'remote-screenshot-helper.sock'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startMockHelper(socketPath: string, onRequest: (request: any, socket: net.Socket) => void) {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          onRequest(JSON.parse(line), socket);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  return server;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('requestRemoteScreenshotViaHelper', () => {
  it('completes through the helper socket and forwards output path truth', async () => {
    const fixture = createSocketFixture();
    cleanups.push(() => fixture.cleanup());

    const server = await startMockHelper(fixture.socketPath, (request, socket) => {
      expect(request.type).toBe('capture-screen');
      expect(request.outputPath).toBe('/tmp/output.png');
      socket.write(`${JSON.stringify({ type: 'capture-started', requestId: request.requestId })}\n`);
      socket.write(`${JSON.stringify({ type: 'capture-completed', requestId: request.requestId, outputPath: request.outputPath })}\n`);
      socket.end();
    });
    cleanups.push(() => server.close());

    await expect(requestRemoteScreenshotViaHelper({
      socketPath: fixture.socketPath,
      outputPath: '/tmp/output.png',
      timeoutMs: 1500,
    })).resolves.toEqual({
      outputPath: '/tmp/output.png',
    });
  });

  it('surfaces helper explicit failure without fallback', async () => {
    const fixture = createSocketFixture();
    cleanups.push(() => fixture.cleanup());

    const server = await startMockHelper(fixture.socketPath, (request, socket) => {
      socket.write(`${JSON.stringify({ type: 'capture-failed', requestId: request.requestId, error: 'screen permission denied' })}\n`);
      socket.end();
    });
    cleanups.push(() => server.close());

    await expect(requestRemoteScreenshotViaHelper({
      socketPath: fixture.socketPath,
      outputPath: '/tmp/output.png',
      timeoutMs: 1500,
    })).rejects.toThrow('screen permission denied');
  });

  it('fails explicitly when helper socket is unavailable', async () => {
    const fixture = createSocketFixture();
    cleanups.push(() => fixture.cleanup());

    await expect(requestRemoteScreenshotViaHelper({
      socketPath: fixture.socketPath,
      outputPath: '/tmp/output.png',
      timeoutMs: 500,
    })).rejects.toThrow('remote screenshot helper not running');
  });
});
