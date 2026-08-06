import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTerminalHttpRuntime } from './terminal-http-runtime';

function responseRecorder() {
  let body: Buffer | string = '';
  const headers = new Map<string, string | number>();
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string | number) { headers.set(name, value); },
    end(chunk?: Buffer | string) { body = chunk || ''; },
  } as unknown as ServerResponse;
  return { response, readBody: () => body };
}

function request(method: string, url: string, payload: unknown, headers: Record<string, string> = {}) {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.url = url;
  emitter.headers = { host: '127.0.0.1:3333', ...headers } as IncomingMessage['headers'];
  emitter.socket = {} as IncomingMessage['socket'];
  queueMicrotask(() => {
    emitter.emit('data', Buffer.from(JSON.stringify(payload)));
    emitter.emit('end');
  });
  return emitter;
}

describe('terminal HTTP attachment API', () => {
  it('enqueues an image through the agent API and returns attachment identity', async () => {
    const enqueueImage = vi.fn(async () => ({ attachmentId: 'att-1', status: 'available' } as never));
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1', port: 3333, requiredAuthToken: '', updatesDir: '/tmp/missing', appUpdateVersionCode: 0, appUpdateVersionName: '', appUpdateManifestUrl: '',
      sessions: new Map(), mirrors: new Map(), clientRuntimeDebugStore: {} as never, daemonRuntimeDebugStore: {} as never, performanceTraceStore: {} as never,
      resolveDebugRouteLimit: () => 100, broadcastRuntimeDebugControl: vi.fn(), setDaemonRuntimeDebugEnabled: vi.fn(), logTimePrefix: () => '',
      connections: new Map(),
      sendTransportMessage: vi.fn(),
      attachmentDeliveryRuntime: { enqueueImage, listForDevice: vi.fn(), readAsset: vi.fn(), acknowledge: vi.fn(), cleanup: vi.fn() },
    });
    const recorder = responseRecorder();
    await runtime.handleHttpRequest(request('POST', '/api/v1/attachments/images', {
      fileName: 'screen.png', mimeType: 'image/png', dataBase64: Buffer.from('image').toString('base64'), senderAgentId: 'codex', senderName: 'Codex', clientRequestId: 'req-1', targetDeviceIds: ['phone-a'],
    }), recorder.response);
    expect(enqueueImage).toHaveBeenCalledWith(expect.objectContaining({ data: Buffer.from('image'), targetDeviceIds: ['phone-a'] }));
    expect(JSON.parse(String(recorder.readBody()))).toMatchObject({ ok: true, attachmentId: 'att-1' });
  });

  it('requires the daemon token and exposes missed delivery through device sync', async () => {
    const listForDevice = vi.fn(async () => [{ attachmentId: 'att-1', status: 'available' } as never]);
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1', port: 3333, requiredAuthToken: 'daemon-secret', updatesDir: '/tmp/missing', appUpdateVersionCode: 0, appUpdateVersionName: '', appUpdateManifestUrl: '',
      sessions: new Map(), mirrors: new Map(), clientRuntimeDebugStore: {} as never, daemonRuntimeDebugStore: {} as never, performanceTraceStore: {} as never,
      resolveDebugRouteLimit: () => 100, broadcastRuntimeDebugControl: vi.fn(), setDaemonRuntimeDebugEnabled: vi.fn(), logTimePrefix: () => '',
      connections: new Map(),
      sendTransportMessage: vi.fn(),
      attachmentDeliveryRuntime: { enqueueImage: vi.fn(), listForDevice, readAsset: vi.fn(), acknowledge: vi.fn(), cleanup: vi.fn() },
    });
    const unauthorized = responseRecorder();
    await runtime.handleHttpRequest(request('GET', '/api/v1/attachments?deviceId=phone-a', null), unauthorized.response);
    expect(unauthorized.response.statusCode).toBe(401);
    expect(listForDevice).not.toHaveBeenCalled();

    const authorized = responseRecorder();
    await runtime.handleHttpRequest(request('GET', '/api/v1/attachments?deviceId=phone-a', null, { authorization: 'Bearer daemon-secret' }), authorized.response);
    expect(listForDevice).toHaveBeenCalledWith('phone-a', 'preview');
    expect(JSON.parse(String(authorized.readBody()))).toMatchObject({ ok: true, items: [{ attachmentId: 'att-1' }] });
  });

  it('rejects malformed base64 before enqueueing an attachment', async () => {
    const enqueueImage = vi.fn();
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1', port: 3333, requiredAuthToken: '', updatesDir: '/tmp/missing', appUpdateVersionCode: 0, appUpdateVersionName: '', appUpdateManifestUrl: '',
      sessions: new Map(), mirrors: new Map(), clientRuntimeDebugStore: {} as never, daemonRuntimeDebugStore: {} as never, performanceTraceStore: {} as never,
      resolveDebugRouteLimit: () => 100, broadcastRuntimeDebugControl: vi.fn(), setDaemonRuntimeDebugEnabled: vi.fn(), logTimePrefix: () => '',
      connections: new Map(),
      sendTransportMessage: vi.fn(),
      attachmentDeliveryRuntime: { enqueueImage, listForDevice: vi.fn(), readAsset: vi.fn(), acknowledge: vi.fn(), cleanup: vi.fn() },
    });
    const recorder = responseRecorder();
    await runtime.handleHttpRequest(request('POST', '/api/v1/attachments/images', {
      fileName: 'screen.png', mimeType: 'image/png', dataBase64: 'not-base64!', senderAgentId: 'codex', senderName: 'Codex', clientRequestId: 'req-invalid', targetDeviceIds: ['phone-a'],
    }), recorder.response);
    expect(recorder.response.statusCode).toBe(400);
    expect(enqueueImage).not.toHaveBeenCalled();
    expect(JSON.parse(String(recorder.readBody()))).toMatchObject({ message: 'invalid attachment base64' });
  });

  it('rejects an invalid receipt asset without mutating delivery state', async () => {
    const acknowledge = vi.fn();
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1', port: 3333, requiredAuthToken: '', updatesDir: '/tmp/missing', appUpdateVersionCode: 0, appUpdateVersionName: '', appUpdateManifestUrl: '',
      sessions: new Map(), mirrors: new Map(), clientRuntimeDebugStore: {} as never, daemonRuntimeDebugStore: {} as never, performanceTraceStore: {} as never,
      resolveDebugRouteLimit: () => 100, broadcastRuntimeDebugControl: vi.fn(), setDaemonRuntimeDebugEnabled: vi.fn(), logTimePrefix: () => '',
      connections: new Map(),
      sendTransportMessage: vi.fn(),
      attachmentDeliveryRuntime: { enqueueImage: vi.fn(), listForDevice: vi.fn(), readAsset: vi.fn(), acknowledge, cleanup: vi.fn() },
    });
    const recorder = responseRecorder();
    await runtime.handleHttpRequest(request('POST', '/api/v1/attachments/att_00000000-0000-4000-8000-000000000000/receipt', {
      deviceId: 'phone-a', asset: 'unexpected', sha256: 'sha',
    }), recorder.response);
    expect(recorder.response.statusCode).toBe(400);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(JSON.parse(String(recorder.readBody()))).toMatchObject({ message: 'invalid attachment receipt' });
  });

  it('rejects an invalid detail asset query without reading delivery state', async () => {
    const listForDevice = vi.fn();
    const runtime = createTerminalHttpRuntime({
      host: '127.0.0.1', port: 3333, requiredAuthToken: '', updatesDir: '/tmp/missing', appUpdateVersionCode: 0, appUpdateVersionName: '', appUpdateManifestUrl: '',
      sessions: new Map(), mirrors: new Map(), clientRuntimeDebugStore: {} as never, daemonRuntimeDebugStore: {} as never, performanceTraceStore: {} as never,
      resolveDebugRouteLimit: () => 100, broadcastRuntimeDebugControl: vi.fn(), setDaemonRuntimeDebugEnabled: vi.fn(), logTimePrefix: () => '',
      connections: new Map(),
      sendTransportMessage: vi.fn(),
      attachmentDeliveryRuntime: { enqueueImage: vi.fn(), listForDevice, readAsset: vi.fn(), acknowledge: vi.fn(), cleanup: vi.fn() },
    });
    const recorder = responseRecorder();
    await runtime.handleHttpRequest(request('GET', '/api/v1/attachments/att_00000000-0000-4000-8000-000000000000?deviceId=phone-a&asset=unexpected', null), recorder.response);
    expect(recorder.response.statusCode).toBe(400);
    expect(listForDevice).not.toHaveBeenCalled();
    expect(JSON.parse(String(recorder.readBody()))).toMatchObject({ message: 'invalid attachment asset' });
  });
});
