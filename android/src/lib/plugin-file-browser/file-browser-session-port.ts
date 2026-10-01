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
import { createFileTransferBinaryDownload } from '../file-transfer-binary-download-runtime';

function parseBridgeHost(value: string): string {
  const raw = value.trim();
  const bracketMatch = raw.match(/^\[([^\]]+)\]:\d+$/);
  if (bracketMatch) return bracketMatch[1]!;
  if (raw.includes(']:')) return raw.split(']:').shift()!.replace(/^\[/u, '');
  return raw.split(':').shift()!;
}

function parseResolvedEndpoint(value: string | undefined): { host: string; port: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const bracketMatch = raw.match(/^\[([^\]]+)\]:(\d+)$/u);
  if (bracketMatch) {
    const port = Number(bracketMatch[2]);
    return Number.isInteger(port) && port > 0
      ? { host: bracketMatch[1]!, port }
      : undefined;
  }
  const separatorIndex = raw.lastIndexOf(':');
  if (separatorIndex <= 0 || raw.indexOf(':') !== separatorIndex) return undefined;
  const host = raw.slice(0, separatorIndex).trim();
  const port = Number(raw.slice(separatorIndex + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { host, port };
}

function isPrivateLanBridgeHost(value: string): boolean {
  const host = parseBridgeHost(value);
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 127
    || parts[0] === 10
    || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168
  );
}

export function createFileBrowserSessionPort(input: {
  session: Pick<
    Session,
    'id' | 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'resolvedPath' | 'resolvedEndpoint'
  > | undefined;
  send: (sessionId: string, message: FileBrowserCommand) => void;
  subscribe: FileBrowserSessionPort['onFileTransferMessage'];
  downloadStore?: FileTransferDownloadStore;
  fetchBinary?: typeof fetch;
}): FileBrowserSessionPort {
  if (!input.session?.id.trim()) throw new Error('file browser session is required');
  if (typeof input.send !== 'function') throw new Error('file browser send capability is required');
  if (typeof input.subscribe !== 'function') throw new Error('file browser subscription capability is required');
  const { id, daemonHostId, bridgeHost, bridgePort, authToken, resolvedPath, resolvedEndpoint } = input.session;
  const directDownloadPath = resolvedPath === 'lan' || resolvedPath === 'tailscale'
    ? resolvedPath
    : undefined;
  const effectiveBinaryPath = directDownloadPath
    || (!resolvedPath && bridgeHost && isPrivateLanBridgeHost(bridgeHost)
      ? 'lan' as const
      : undefined);
  const endpoint = directDownloadPath ? parseResolvedEndpoint(resolvedEndpoint) : undefined;
  const { send, subscribe } = input;
  const downloadStore = input.downloadStore ?? createFileTransferDownloadStore(StoragePermissionPlugin);
  const binaryDownloader = createFileTransferBinaryDownload({
    resolvedPath: effectiveBinaryPath,
    host: endpoint?.host ?? bridgeHost,
    port: endpoint?.port ?? bridgePort,
    token: authToken,
    store: downloadStore,
    fetch: input.fetchBinary,
  });
  const runtime = createFileTransferSessionRuntime({
    binaryPath: effectiveBinaryPath,
    downloadStore,
    fetchBinaryFile: async (options) => { await binaryDownloader(options); },
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
  fetchBinary?: typeof fetch;
}): FileBrowserSessionPortOwner {
  const ports = new Map<string, FileBrowserSessionPort>();
  const portKeys = new Map<string, string>();
  let disposed = false;

  function buildPortKey(
    session: Parameters<FileBrowserSessionPortOwner['resolve']>[0]['session'],
  ): string {
    return [
      session?.id.trim() ?? '',
      session?.resolvedPath ?? '',
      session?.resolvedEndpoint ?? '',
      session?.authToken ?? '',
      session?.bridgeHost ?? '',
      String(session?.bridgePort ?? ''),
      session?.daemonHostId ?? '',
    ].join('|');
  }

  return {
    resolve({ session }) {
      if (disposed) {
        throw new Error('file browser session port owner is disposed');
      }
      const sessionId = session?.id.trim() || '';
      if (!sessionId) {
        throw new Error('file browser session is required');
      }
      const nextKey = buildPortKey(session);
      const cached = ports.get(sessionId);
      if (cached && portKeys.get(sessionId) === nextKey) {
        return cached;
      }
      if (cached) {
        ports.delete(sessionId);
        portKeys.delete(sessionId);
        void cached.dispose();
      }
      const port = createFileBrowserSessionPort({
        session,
        send: input.send,
        subscribe: input.subscribe,
        downloadStore: input.downloadStore,
        fetchBinary: input.fetchBinary,
      });
      ports.set(sessionId, port);
      portKeys.set(sessionId, nextKey);
      return port;
    },

    reconcile(liveSessionIds) {
      const live = new Set(liveSessionIds);
      for (const [sessionId, port] of ports) {
        if (live.has(sessionId)) {
          continue;
        }
        ports.delete(sessionId);
        portKeys.delete(sessionId);
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
      portKeys.clear();
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
