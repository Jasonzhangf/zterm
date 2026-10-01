// @vitest-environment jsdom

import React, { StrictMode, useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFileBrowserSessionPort,
  createFileBrowserSessionPortOwner,
  useFileBrowserSessionPortOwner,
} from './file-browser-session-port';
import type { FileTransferDownloadStore } from '../file-transfer-native-store-port';

afterEach(() => {
  cleanup();
});

describe('file browser session port', () => {
  const session = { id: 's1', daemonHostId: 'daemon-1', bridgeHost: 'host', bridgePort: 3333 };

  it('binds one exact session and preserves the original wire object', () => {
    const target = { ...session };
    const send = vi.fn();
    const port = createFileBrowserSessionPort({ session: target, send, subscribe: vi.fn() });
    target.id = 's2';
    const message = { type: 'file-list-request' as const, payload: { requestId: 'req', path: '/work', showHidden: true } };
    port.sendJson(message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('s1', message);
    expect(send.mock.calls[0][1]).toBe(message);
    expect(port.daemonFileScopeId).toBe('daemon:daemon-1');
  });

  it('uses the explicit endpoint file scope for a session without daemon identity', () => {
    const port = createFileBrowserSessionPort({
      session: { ...session, daemonHostId: undefined }, send: vi.fn(), subscribe: vi.fn(),
    });
    expect(port.daemonFileScopeId).toBe('endpoint:host:3333');
  });

  it('delegates subscription and exact cleanup without opening another transport', async () => {
    const dispose = vi.fn();
    const subscribe = vi.fn(() => dispose);
    const send = vi.fn();
    const port = createFileBrowserSessionPort({ session, send, subscribe });
    const listener = vi.fn();
    const removeListener = port.onFileTransferMessage(listener);
    expect(typeof removeListener).toBe('function');
    expect(subscribe).toHaveBeenCalledTimes(1);
    await port.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the runtime subscribed while the UI listener is removed and re-added', async () => {
    let dispatch: ((message: any) => void) | undefined;
    const subscribe = vi.fn((handler: (message: any) => void) => {
      dispatch = handler;
      return vi.fn();
    });
    const port = createFileBrowserSessionPort({ session, send: vi.fn(), subscribe });
    port.fileTransferRuntime.open('/remote/home', 'daemon:daemon-1');
    const stateChange = vi.fn();
    const removeStateChange = port.onFileTransferStateChange(stateChange);
    const removeMessage = port.onFileTransferMessage(vi.fn());
    removeMessage();
    dispatch?.({
      type: 'file-download-error',
      payload: { requestId: 'unknown', error: 'late error' },
    });
    await Promise.resolve();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(stateChange).toHaveBeenCalled();
    removeStateChange();
    await port.dispose();
  });

  it('rejects missing sessions and capabilities instead of falling back to active session', () => {
    expect(() => createFileBrowserSessionPort({ session: undefined, send: vi.fn(), subscribe: vi.fn() })).toThrow('session');
    expect(() => createFileBrowserSessionPort({ session: { ...session, id: '' }, send: vi.fn(), subscribe: vi.fn() })).toThrow('session');
    // @ts-expect-error Runtime boundary must reject absent sender.
    expect(() => createFileBrowserSessionPort({ session, subscribe: vi.fn() })).toThrow('send');
    // @ts-expect-error Runtime boundary must reject absent subscription.
    expect(() => createFileBrowserSessionPort({ session, send: vi.fn() })).toThrow('subscription');
  });

  it('propagates owner send failure', () => {
    const failure = new Error('transport closed');
    const port = createFileBrowserSessionPort({ session, send: () => { throw failure; }, subscribe: vi.fn() });
    expect(() => port.sendJson({ type: 'file-list-request', payload: { requestId: 'req', path: '/', showHidden: true } })).toThrow(failure);
  });

  it('keeps the owner usable through StrictMode effect cleanup and disposes on real unmount', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const ownerRef: { current: ReturnType<typeof createFileBrowserSessionPortOwner> | null } = {
      current: null,
    };
    function Harness() {
      const owner = useFileBrowserSessionPortOwner({
        send: vi.fn(),
        subscribe,
      });
      ownerRef.current = owner;
      useEffect(() => {
        owner.resolve({ session });
      }, [owner]);
      return null;
    }

    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(Harness),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(ownerRef.current).toBeTruthy();
    expect(() => ownerRef.current?.resolve({ session })).not.toThrow();
    expect(subscribe).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => ownerRef.current?.resolve({ session })).toThrow(
      'file browser session port owner is disposed',
    );
  });

  it('retains a download through UI listener removal and only settles after commit', async () => {
    let dispatch: ((message: any) => void) | undefined;
    const subscribe = vi.fn((handler: (message: any) => void) => {
      dispatch = handler;
      return vi.fn();
    });
    let releasePersist: (() => void) | undefined;
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(() => new Promise<void>((resolve) => {
        releasePersist = resolve;
      })),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const owner = createFileBrowserSessionPortOwner({
      send: vi.fn(),
      subscribe,
      downloadStore,
    });
    const port = owner.resolve({ session });
    const store = port.fileTransferRuntime;
    store.open('/remote/home', 'daemon:daemon-1');
    const request = store.startDownload(
      { name: 'old.bin', size: 3 },
      '/remote/home',
      { scopeId: 'daemon:daemon-1', downloadDir: '/storage/emulated/0/Download' },
    );
    const done = request.waitForDone();
    const removeUiListener = port.onFileTransferMessage(vi.fn());
    removeUiListener();

    dispatch?.({
      type: 'file-download-chunk',
      payload: {
        requestId: request.requestId,
        fileName: 'old.bin',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: 'b2xk',
      },
    });
    dispatch?.({
      type: 'file-download-complete',
      payload: {
        requestId: request.requestId,
        fileName: 'old.bin',
        totalBytes: 3,
      },
    });
    await Promise.resolve();
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePersist?.();
    await expect(done).resolves.toBeUndefined();
    await owner.dispose();
  });

  it('keeps explicit rtc-relay downloads on the mux chunk path despite a private bridgeHost', () => {
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const port = createFileBrowserSessionPort({
      session: {
        id: 's1',
        daemonHostId: 'daemon-1',
        bridgeHost: '192.168.1.7',
        bridgePort: 3333,
        authToken: 'token',
        resolvedPath: 'rtc-relay',
      },
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
    });
    port.fileTransferRuntime.open('/remote/home', 'daemon:daemon-1');
    const request = port.fileTransferRuntime.startDownload(
      { name: 'relay.bin', size: 64 },
      '/remote/home',
      { scopeId: 'daemon:daemon-1', downloadDir: '/storage/emulated/0/Download' },
    );
    expect(request.message?.type).toBe('file-download-request');
    expect(downloadStore.persist).not.toHaveBeenCalled();
  });

  it('keeps binary fast path for explicit lan and private-host fallback only when route is unknown', () => {
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const lan = createFileBrowserSessionPort({
      session: {
        id: 's1',
        daemonHostId: 'daemon-1',
        bridgeHost: '192.168.1.7',
        bridgePort: 3333,
        authToken: 'token',
        resolvedPath: 'lan',
      },
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
    });
    lan.fileTransferRuntime.open('/remote/home', 'daemon:daemon-1');
    const lanRequest = lan.fileTransferRuntime.startDownload(
      { name: 'lan.bin', size: 64 },
      '/remote/home',
      { scopeId: 'daemon:daemon-1', downloadDir: '/storage/emulated/0/Download' },
    );
    expect(lanRequest.message).toBeUndefined();

    const unknown = createFileBrowserSessionPort({
      session: {
        id: 's2',
        daemonHostId: 'daemon-2',
        bridgeHost: '192.168.1.8',
        bridgePort: 3333,
        authToken: 'token',
      },
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
    });
    unknown.fileTransferRuntime.open('/remote/home', 'daemon:daemon-2');
    const unknownRequest = unknown.fileTransferRuntime.startDownload(
      { name: 'fallback.bin', size: 64 },
      '/remote/home',
      { scopeId: 'daemon:daemon-2', downloadDir: '/storage/emulated/0/Download' },
    );
    expect(unknownRequest.message).toBeUndefined();
  });

  it('binds binary HTTP downloads to the active resolvedEndpoint host and port', async () => {
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const fetchBinary = vi.fn(async (_input: RequestInfo | URL) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-length': '4' } },
    ));
    const port = createFileBrowserSessionPort({
      session: {
        id: 's1',
        daemonHostId: 'daemon-1',
        bridgeHost: '100.64.0.2',
        bridgePort: 3333,
        authToken: 'token',
        resolvedPath: 'lan',
        resolvedEndpoint: '192.168.1.50:3444',
      },
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
      fetchBinary: fetchBinary as unknown as typeof fetch,
    });
    port.fileTransferRuntime.open('/remote/home', 'daemon:daemon-1');
    const request = port.fileTransferRuntime.startDownload(
      { name: 'photo.bin', size: 4 },
      '/remote/home',
      { scopeId: 'daemon:daemon-1', downloadDir: '/storage/emulated/0/Download' },
    );
    expect(request.message).toBeUndefined();
    await request.waitForDone();

    expect(fetchBinary).toHaveBeenCalledTimes(1);
    const requested = String(fetchBinary.mock.calls[0]?.[0]);
    expect(requested).toContain('192.168.1.50:3444');
    expect(requested).not.toContain('100.64.0.2');
    expect(downloadStore.complete).toHaveBeenCalledWith(expect.objectContaining({ totalBytes: 4 }));
  });

  it('rebuilds the owner cache when only resolvedEndpoint changes', async () => {
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const owner = createFileBrowserSessionPortOwner({
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
    });
    const sessionA = {
      id: 's1',
      daemonHostId: 'daemon-1',
      bridgeHost: '100.64.0.2',
      bridgePort: 3333,
      authToken: 'token-a',
      resolvedPath: 'lan' as const,
      resolvedEndpoint: '192.168.1.50:3444',
    };
    const portA = owner.resolve({ session: sessionA });
    expect(portA).toBe(owner.resolve({ session: sessionA }));

    const portB = owner.resolve({
      session: { ...sessionA, resolvedEndpoint: '192.168.1.51:3444' },
    });
    expect(portB).not.toBe(portA);
    await owner.dispose();
  });

  it('rebuilds the owner cache when route/auth/bridge identity changes for the same session id', async () => {
    const downloadStore: FileTransferDownloadStore = {
      createDestination: vi.fn((input) => ({
        ...input,
        targetPath: `${input.downloadDir}/${input.fileName}`,
        stagingPath: `${input.downloadDir}/.${input.requestId}.part`,
      })),
      persist: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const owner = createFileBrowserSessionPortOwner({
      send: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      downloadStore,
    });
    const lanSession = {
      id: 's1',
      daemonHostId: 'daemon-1',
      bridgeHost: '100.64.0.2',
      bridgePort: 3333,
      authToken: 'token-a',
      resolvedPath: 'lan' as const,
    };
    const lanPort = owner.resolve({ session: lanSession });
    expect(lanPort).toBe(owner.resolve({ session: lanSession }));

    const relaySession = {
      ...lanSession,
      resolvedPath: 'rtc-relay' as const,
    };
    const relayPort = owner.resolve({ session: relaySession });
    expect(relayPort).not.toBe(lanPort);
    relayPort.fileTransferRuntime.open('/remote/home', 'daemon:daemon-1');
    const relayRequest = relayPort.fileTransferRuntime.startDownload(
      { name: 'relay-cache.bin', size: 64 },
      '/remote/home',
      { scopeId: 'daemon:daemon-1', downloadDir: '/storage/emulated/0/Download' },
    );
    expect(relayRequest.message?.type).toBe('file-download-request');
    await owner.dispose();
  });
});
