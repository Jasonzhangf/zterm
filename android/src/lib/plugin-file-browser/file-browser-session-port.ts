import { useEffect, useRef } from 'react';
import type { Session } from '../types';
import type {
  FileBrowserCommand,
  FileBrowserSessionPort,
  FileBrowserSessionPortOwner,
} from './file-browser-contract';
import { createFileTransferDownloadStore } from '../file-transfer-native-store-port';
import type { FileTransferDownloadStore } from '../file-transfer-native-store-port';
import { createFileTransferSessionRuntime } from '../file-transfer-session-runtime';
import { StoragePermissionPlugin } from '../../plugins/StoragePermissionPlugin';
import type { FileTransferMessage } from '../file-transfer-message-runtime';

export function createFileBrowserSessionPort(input: {
  session: Pick<Session, 'id' | 'daemonHostId' | 'bridgeHost' | 'bridgePort'> | undefined;
  send: (sessionId: string, message: FileBrowserCommand) => void;
  subscribe: FileBrowserSessionPort['onFileTransferMessage'];
  downloadStore?: FileTransferDownloadStore;
}): FileBrowserSessionPort {
  if (!input.session?.id.trim()) throw new Error('file browser session is required');
  if (typeof input.send !== 'function') throw new Error('file browser send capability is required');
  if (typeof input.subscribe !== 'function') throw new Error('file browser subscription capability is required');
  const { id, daemonHostId, bridgeHost, bridgePort } = input.session;
  const { send, subscribe } = input;
  const runtime = createFileTransferSessionRuntime({
    downloadStore: input.downloadStore ?? createFileTransferDownloadStore(StoragePermissionPlugin),
  });
  const messageListeners = new Set<(message: FileTransferMessage) => void>();
  const stateListeners = new Set<() => void>();
  const pendingMessageApplications = new Set<Promise<unknown>>();
  let disposed = false;
  const unsubscribe = subscribe((message) => {
    if (disposed) return;
    if (message.type !== 'remote-screenshot-status') {
      const application = runtime.applyMessage(message).then(() => {
        for (const listener of Array.from(stateListeners)) listener();
      });
      pendingMessageApplications.add(application);
      void application.finally(() => {
        pendingMessageApplications.delete(application);
      });
    }
    for (const listener of Array.from(messageListeners)) listener(message);
  });
  return {
    daemonFileScopeId: daemonHostId ? `daemon:${daemonHostId}` : `endpoint:${bridgeHost}:${bridgePort}`,
    fileTransferRuntime: runtime,
    sendJson: (message) => {
      if (disposed) throw new Error('file browser session port is disposed');
      send(id, message);
    },
    onFileTransferMessage: (handler) => {
      messageListeners.add(handler);
      return () => {
        messageListeners.delete(handler);
      };
    },
    onFileTransferStateChange: (handler) => {
      stateListeners.add(handler);
      return () => {
        stateListeners.delete(handler);
      };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
      await Promise.allSettled(Array.from(pendingMessageApplications));
      unsubscribe();
      messageListeners.clear();
      stateListeners.clear();
    },
  };
}

export function createFileBrowserSessionPortOwner(input: {
  send: (sessionId: string, message: FileBrowserCommand) => void;
  subscribe: FileBrowserSessionPort['onFileTransferMessage'];
  downloadStore?: FileTransferDownloadStore;
}): FileBrowserSessionPortOwner {
  const ports = new Map<string, FileBrowserSessionPort>();
  let disposed = false;

  return {
    resolve({ session }) {
      if (disposed) {
        throw new Error('file browser session port owner is disposed');
      }
      const sessionId = session?.id.trim() || '';
      if (!sessionId) {
        throw new Error('file browser session is required');
      }
      const cached = ports.get(sessionId);
      if (cached) {
        return cached;
      }
      const port = createFileBrowserSessionPort({
        session,
        send: input.send,
        subscribe: input.subscribe,
        downloadStore: input.downloadStore,
      });
      ports.set(sessionId, port);
      return port;
    },

    reconcile(liveSessionIds) {
      const live = new Set(liveSessionIds);
      for (const [sessionId, port] of ports) {
        if (live.has(sessionId)) {
          continue;
        }
        ports.delete(sessionId);
        void port.dispose();
      }
    },

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const pending = Array.from(ports.values(), (port) => port.dispose());
      ports.clear();
      await Promise.all(pending);
    },
  };
}

export function useFileBrowserSessionPortOwner(input: {
  send: (sessionId: string, message: FileBrowserCommand) => void;
  subscribe: FileBrowserSessionPort['onFileTransferMessage'];
}): FileBrowserSessionPortOwner {
  const ownerRef = useRef<FileBrowserSessionPortOwner | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = createFileBrowserSessionPortOwner(input);
  }
  const owner = ownerRef.current;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) {
          void owner.dispose();
        }
      });
    };
  }, [owner]);

  return owner;
}
