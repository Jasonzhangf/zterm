import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('readFileSync should not be called for file download');
  },
  createReadStream: vi.fn(),
  statSync: vi.fn(),
}));

import { createReadStream, statSync } from 'fs';
import { createTerminalHttpRuntime, type TerminalHttpRuntimeDeps } from './terminal-http-runtime';
import { DebugPermissionService } from '@zterm/shared/terminal/debug-contract';

function jsonResponseMatcher() {
  const headers: Record<string, string | undefined> = {};
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    write: (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end: (chunk?: Buffer | string) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    },
    headers,
    body: () => Buffer.concat(chunks),
  };
}

function request(url: string, method = 'GET', headers: Record<string, string> = {}) {
  const parsed = new URL(url, 'http://127.0.0.1');
  return Object.assign(new EventEmitter(), {
    method,
    url,
    headers,
    socket: { encrypted: false },
    parsed,
  }) as unknown as IncomingMessage;
}

function deps(filePath: string): TerminalHttpRuntimeDeps {
  return {
    host: '127.0.0.1',
    port: 3333,
    requiredAuthToken: 'daemon-token',
    updatesDir: join(tmpdir(), 'unused-zterm-updates'),
    appUpdateVersionCode: 1,
    appUpdateVersionName: '0.0.0-test',
    appUpdateManifestUrl: 'http://127.0.0.1/updates/latest.json',
    sessions: new Map(),
    mirrors: new Map(),
    clientRuntimeDebugStore: {} as never,
    daemonRuntimeDebugStore: {} as never,
    performanceTraceStore: { snapshot: () => [] } as never,
    resolveDebugRouteLimit: () => 1000,
    broadcastRuntimeDebugControl: vi.fn(),
    setDaemonRuntimeDebugEnabled: vi.fn(),
    setDaemonRuntimeDebugLease: vi.fn(),
    debugPermissionService: new DebugPermissionService(),
    handleClientDebugLog: vi.fn(),
    handleClientDebugSnapshot: vi.fn(),
    logTimePrefix: () => '2026-09-28T00:00:00.000Z',
    resolveFileTransferDownloadPath: (requestedPath: string) =>
      requestedPath === '/remote/photo.bin' ? filePath : join(filePath, 'missing'),
    connections: new Map(),
    sendTransportMessage: vi.fn(),
  };
}

function depsWithoutToken(host: string, filePath: string): TerminalHttpRuntimeDeps {
  return {
    ...deps(filePath),
    host,
    requiredAuthToken: '',
  };
}

describe('terminal HTTP file download runtime', () => {
  beforeEach(() => {
    vi.mocked(createReadStream).mockReset();
    vi.mocked(statSync).mockReset();
  });

  it('streams raw octet bytes for authorized direct GET downloads', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const stream = Object.assign(new EventEmitter(), {
      pipe: vi.fn((response: { write: (chunk: Buffer) => void; end: () => void }) => {
        stream.emit('data', bytes);
        stream.emit('end');
        response.write(bytes);
        response.end();
        return response;
      }),
    });
    vi.mocked(createReadStream).mockReturnValue(stream as never);
    vi.mocked(statSync).mockReturnValue({ size: bytes.byteLength, isFile: () => true } as never);

    const runtime = createTerminalHttpRuntime(deps('/remote/photo.bin'));
    const response = jsonResponseMatcher();

    await runtime.handleHttpRequest(
      request('http://127.0.0.1/api/v1/files/download?path=/remote/photo.bin&token=daemon-token'),
      response as never,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/octet-stream');
    expect(response.headers['Content-Length']).toBe(5);
    expect(response.headers['Content-Disposition']).toContain('photo.bin');
    expect(response.body()).toEqual(bytes);
  });

  it('rejects unauthenticated downloads without reading the file', async () => {
    const runtime = createTerminalHttpRuntime(deps('/remote/photo.bin'));
    const response = jsonResponseMatcher();

    await runtime.handleHttpRequest(
      request('http://127.0.0.1/api/v1/files/download?path=/remote/photo.bin'),
      response as never,
    );

    expect(response.statusCode).toBe(401);
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
  });

  it('rejects non-GET file download methods', async () => {
    const runtime = createTerminalHttpRuntime(deps('/remote/photo.bin'));
    const response = jsonResponseMatcher();

    await runtime.handleHttpRequest(
      request('http://127.0.0.1/api/v1/files/download?path=/remote/photo.bin&token=daemon-token', 'POST'),
      response as never,
    );

    expect(response.statusCode).toBe(405);
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
  });

  it('rejects no-token file downloads on a non-loopback daemon listener', async () => {
    const runtime = createTerminalHttpRuntime(depsWithoutToken('0.0.0.0', '/remote/photo.bin'));
    const response = jsonResponseMatcher();

    await runtime.handleHttpRequest(
      request('http://192.168.1.20/api/v1/files/download?path=/remote/photo.bin'),
      response as never,
    );

    expect(response.statusCode).toBe(401);
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
  });

  it('allows no-token file downloads when the daemon only listens on loopback', async () => {
    const bytes = Buffer.from([9, 8, 7]);
    const stream = Object.assign(new EventEmitter(), {
      pipe: vi.fn((response: { write: (chunk: Buffer) => void; end: () => void }) => {
        stream.emit('data', bytes);
        stream.emit('end');
        response.write(bytes);
        response.end();
        return response;
      }),
    });
    vi.mocked(createReadStream).mockReturnValue(stream as never);
    vi.mocked(statSync).mockReturnValue({ size: bytes.byteLength, isFile: () => true } as never);

    const runtime = createTerminalHttpRuntime(depsWithoutToken('127.0.0.1', '/remote/photo.bin'));
    const response = jsonResponseMatcher();

    await runtime.handleHttpRequest(
      request('http://127.0.0.1/api/v1/files/download?path=/remote/photo.bin'),
      response as never,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body()).toEqual(bytes);
  });
});
