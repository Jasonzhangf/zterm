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
});
