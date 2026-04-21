import { useSyncExternalStore } from 'react';
import type { EditableHost, Host, TerminalRenderBufferProjection } from '@zterm/shared';
import {
  createBridgeTransportController,
  createIdleConnectionState,
  type ActiveBridgeTargetState,
  type BridgeTransportController,
  type TerminalConnectionState,
} from './bridge-transport';
import { createTerminalBufferStore, type TerminalBufferStore, type TerminalBufferStoreSnapshot } from './terminal-buffer-store';

export interface TerminalRuntimeSnapshot {
  connection: TerminalConnectionState;
  buffer: TerminalBufferStoreSnapshot;
  render: TerminalRenderBufferProjection;
}

export interface TerminalRuntimeController {
  getState: () => TerminalRuntimeSnapshot;
  subscribe: (listener: () => void) => () => void;
  connect: (host: EditableHost | Host) => void;
  disconnect: () => void;
  sendInput: (data: string) => void;
  resizeTerminal: (cols: number, rows: number) => void;
  dispose: () => void;
}

const EMPTY_BUFFER_SNAPSHOT = createTerminalBufferStore().getState();
const EMPTY_RUNTIME_SNAPSHOT: TerminalRuntimeSnapshot = {
  connection: createIdleConnectionState(),
  buffer: EMPTY_BUFFER_SNAPSHOT,
  render: EMPTY_BUFFER_SNAPSHOT.renderBuffer,
};

function buildRuntimeRequestSignature(host: EditableHost | Host) {
  return JSON.stringify({
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: host.sessionName,
    authToken: host.authToken || '',
    authType: host.authType,
    password: host.password || '',
    privateKey: host.privateKey || '',
    autoCommand: host.autoCommand || '',
  });
}

export function createTerminalRuntime(): TerminalRuntimeController {
  const transport = createBridgeTransportController();
  const bufferStore = createTerminalBufferStore();
  const listeners = new Set<() => void>();
  let lastRequestedSignature = '';
  let state: TerminalRuntimeSnapshot = {
    connection: transport.getState(),
    buffer: bufferStore.getState(),
    render: bufferStore.getState().renderBuffer,
  };

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const syncState = () => {
    const buffer = bufferStore.getState();
    state = {
      connection: transport.getState(),
      buffer,
      render: buffer.renderBuffer,
    };
    emit();
  };

  const unsubscribeTransport = transport.subscribe(syncState);
  const unsubscribeBuffer = bufferStore.subscribe(syncState);

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: (host) => {
      const nextSignature = buildRuntimeRequestSignature(host);
      const currentConnection = transport.getState();
      if (
        nextSignature
        && nextSignature === lastRequestedSignature
        && (currentConnection.status === 'connecting' || currentConnection.status === 'connected')
      ) {
        return;
      }
      lastRequestedSignature = nextSignature;
      bufferStore.reset();
      transport.connect(host, {
        onServerMessage: (message) => {
          bufferStore.applyServerMessage(message);
        },
      });
    },
    disconnect: () => {
      transport.disconnect();
    },
    sendInput: (data) => {
      transport.sendInput(data);
    },
    resizeTerminal: (cols, rows) => {
      transport.resizeTerminal(cols, rows);
    },
    dispose: () => {
      unsubscribeTransport();
      unsubscribeBuffer();
      transport.dispose();
      listeners.clear();
    },
  };
}

function subscribeNoop() {
  return () => {};
}

function getEmptySnapshot() {
  return EMPTY_RUNTIME_SNAPSHOT;
}

export function useTerminalRuntimeSnapshot(runtime: TerminalRuntimeController | null | undefined) {
  return useSyncExternalStore(
    runtime ? runtime.subscribe : subscribeNoop,
    runtime ? runtime.getState : getEmptySnapshot,
    getEmptySnapshot,
  );
}

export type { ActiveBridgeTargetState, TerminalConnectionState, BridgeTransportController, TerminalBufferStore };
