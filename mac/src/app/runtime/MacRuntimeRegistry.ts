import { useSyncExternalStore } from 'react';
import { buildEmptyScheduleState } from '@zterm/shared';
import type { EditableHost, Host } from '@zterm/shared';
import { createIdleConnectionState } from '../../lib/bridge-transport';
import { createTerminalBufferStore } from '../../lib/terminal-buffer-store';
import {
  createTerminalRuntime,
  type TerminalRuntimeController,
  type TerminalRuntimeState,
  type TerminalRuntimeViewState,
} from '../../lib/terminal-runtime';
import type { MacRuntimeKey } from '../workspace/workspace-store';

export type MacRuntimeEnsureTarget =
  | {
      kind: 'remote';
      runtimeKey: MacRuntimeKey;
      target: EditableHost | Host;
    }
  | {
      kind: 'local-tmux';
      runtimeKey: MacRuntimeKey;
      sessionName: string;
      title?: string;
    };

export type MacRuntimeFactory = () => TerminalRuntimeController;

export interface MacRuntimeEnsureOptions {
  connect?: boolean;
}

export interface MacRuntimeRegistry {
  ensureRuntime(target: MacRuntimeEnsureTarget, options?: MacRuntimeEnsureOptions): TerminalRuntimeController;
  getRuntime(runtimeKey: MacRuntimeKey | string | null | undefined): TerminalRuntimeController | null;
  getRuntimeState(runtimeKey: MacRuntimeKey | string | null | undefined): TerminalRuntimeState;
  subscribeRuntime(runtimeKey: MacRuntimeKey | string | null | undefined, listener: () => void): () => void;
  getActiveRuntimeKey(): MacRuntimeKey | null;
  subscribeActiveRuntimeKey(listener: () => void): () => void;
  setActiveRuntimeKey(runtimeKey: MacRuntimeKey | string | null | undefined): void;
  reconnectRuntime(runtimeKey: MacRuntimeKey | string | null | undefined): boolean;
  disconnectRuntime(runtimeKey: MacRuntimeKey | string | null | undefined): boolean;
  sendInput(runtimeKey: MacRuntimeKey | string | null | undefined, data: string): boolean;
  updateViewport(runtimeKey: MacRuntimeKey | string | null | undefined, viewState: TerminalRuntimeViewState): boolean;
  resizeTerminal(runtimeKey: MacRuntimeKey | string | null | undefined, cols: number, rows: number): boolean;
  disposeRuntime(runtimeKey: MacRuntimeKey | string | null | undefined): void;
  releaseRuntime(runtimeKey: MacRuntimeKey | string | null | undefined): void;
  dispose(): void;
}

class MacRuntimeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacRuntimeRegistryError';
  }
}

type RuntimeEntry = {
  runtime: TerminalRuntimeController;
  target: MacRuntimeEnsureTarget | null;
  targetSignature: string;
  connectedSignature: string;
  unsubscribe: () => void;
};

const EMPTY_BUFFER_SNAPSHOT = createTerminalBufferStore().getState();

export const EMPTY_MAC_RUNTIME_STATE: TerminalRuntimeState = {
  connection: createIdleConnectionState(),
  buffer: EMPTY_BUFFER_SNAPSHOT,
  render: EMPTY_BUFFER_SNAPSHOT.renderBuffer,
  schedule: buildEmptyScheduleState(''),
  head: null,
};

function normalizeRuntimeKey(runtimeKey: MacRuntimeKey | string | null | undefined): MacRuntimeKey | null {
  if (runtimeKey == null) {
    return null;
  }
  const normalized = String(runtimeKey).trim();
  if (!normalized) {
    return null;
  }
  return normalized as MacRuntimeKey;
}

function requireRuntimeKey(runtimeKey: MacRuntimeKey | string | null | undefined): MacRuntimeKey {
  const normalized = normalizeRuntimeKey(runtimeKey);
  if (!normalized) {
    throw new MacRuntimeRegistryError('Mac runtime key must be a non-empty string');
  }
  return normalized;
}

function buildRemoteTargetSignature(target: EditableHost | Host) {
  return JSON.stringify({
    kind: 'remote',
    name: target.name,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName: target.sessionName,
    authToken: target.authToken || '',
    authType: target.authType,
    password: target.password || '',
    privateKey: target.privateKey || '',
    autoCommand: target.autoCommand || '',
  });
}

function buildEnsureTargetSignature(target: MacRuntimeEnsureTarget) {
  if (target.kind === 'local-tmux') {
    return JSON.stringify({
      kind: 'local-tmux',
      sessionName: target.sessionName.trim(),
    });
  }
  return buildRemoteTargetSignature(target.target);
}

function subscribeNoop() {
  return () => {};
}

export function createMacRuntimeRegistry(factory: MacRuntimeFactory = createTerminalRuntime): MacRuntimeRegistry {
  const entries = new Map<MacRuntimeKey, RuntimeEntry>();
  const runtimeListeners = new Map<MacRuntimeKey, Set<() => void>>();
  const activeListeners = new Set<() => void>();
  let activeRuntimeKey: MacRuntimeKey | null = null;

  const emitRuntime = (runtimeKey: MacRuntimeKey) => {
    runtimeListeners.get(runtimeKey)?.forEach((listener) => listener());
  };

  const emitActive = () => {
    activeListeners.forEach((listener) => listener());
  };

  const getOrCreateEntry = (runtimeKey: MacRuntimeKey): RuntimeEntry => {
    const existing = entries.get(runtimeKey);
    if (existing) {
      return existing;
    }
    const runtime = factory();
    const entry: RuntimeEntry = {
      runtime,
      target: null,
      targetSignature: '',
      connectedSignature: '',
      unsubscribe: runtime.subscribe(() => emitRuntime(runtimeKey)),
    };
    entries.set(runtimeKey, entry);
    runtime.setActivityMode(runtimeKey === activeRuntimeKey ? 'active' : 'idle');
    emitRuntime(runtimeKey);
    return entry;
  };

  const disposeRuntime = (runtimeKeyInput: MacRuntimeKey | string | null | undefined) => {
    const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
    if (!runtimeKey) {
      return;
    }
    const entry = entries.get(runtimeKey);
    if (!entry) {
      return;
    }
    entry.unsubscribe();
    entry.runtime.dispose();
    entries.delete(runtimeKey);
    if (activeRuntimeKey === runtimeKey) {
      activeRuntimeKey = null;
      emitActive();
    }
    emitRuntime(runtimeKey);
  };

  const connectEntry = (entry: RuntimeEntry, target: MacRuntimeEnsureTarget) => {
    const nextSignature = buildEnsureTargetSignature(target);
    if (entry.connectedSignature === nextSignature) {
      return;
    }
    if (target.kind === 'local-tmux') {
      entry.runtime.connectLocalTmux({
        sessionName: target.sessionName.trim(),
        title: target.title,
      });
    } else {
      entry.runtime.connectRemote(target.target);
    }
    entry.connectedSignature = nextSignature;
  };

  return {
    ensureRuntime(target, options) {
      const runtimeKey = requireRuntimeKey(target.runtimeKey);
      const entry = getOrCreateEntry(runtimeKey);
      const nextSignature = buildEnsureTargetSignature(target);
      entry.target = target;
      entry.targetSignature = nextSignature;
      if (options?.connect === false) {
        entry.runtime.setActivityMode(runtimeKey === activeRuntimeKey ? 'active' : 'idle');
        emitRuntime(runtimeKey);
        return entry.runtime;
      }
      connectEntry(entry, target);
      entry.runtime.setActivityMode(runtimeKey === activeRuntimeKey ? 'active' : 'idle');
      emitRuntime(runtimeKey);
      return entry.runtime;
    },
    getRuntime(runtimeKeyInput) {
      const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
      return runtimeKey ? entries.get(runtimeKey)?.runtime ?? null : null;
    },
    getRuntimeState(runtimeKeyInput) {
      const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
      if (!runtimeKey) {
        return EMPTY_MAC_RUNTIME_STATE;
      }
      return entries.get(runtimeKey)?.runtime.getState() ?? EMPTY_MAC_RUNTIME_STATE;
    },
    subscribeRuntime(runtimeKeyInput, listener) {
      const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
      if (!runtimeKey) {
        return subscribeNoop();
      }
      let listeners = runtimeListeners.get(runtimeKey);
      if (!listeners) {
        listeners = new Set();
        runtimeListeners.set(runtimeKey, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) {
          runtimeListeners.delete(runtimeKey);
        }
      };
    },
    getActiveRuntimeKey() {
      return activeRuntimeKey;
    },
    subscribeActiveRuntimeKey(listener) {
      activeListeners.add(listener);
      return () => activeListeners.delete(listener);
    },
    setActiveRuntimeKey(runtimeKeyInput) {
      const nextRuntimeKey = normalizeRuntimeKey(runtimeKeyInput);
      if (nextRuntimeKey === activeRuntimeKey) {
        return;
      }
      const previousRuntimeKey = activeRuntimeKey;
      activeRuntimeKey = nextRuntimeKey;
      if (previousRuntimeKey && previousRuntimeKey !== nextRuntimeKey) {
        entries.get(previousRuntimeKey)?.runtime.setActivityMode('idle');
        emitRuntime(previousRuntimeKey);
      }
      if (nextRuntimeKey) {
        entries.get(nextRuntimeKey)?.runtime.setActivityMode('active');
        emitRuntime(nextRuntimeKey);
      }
      emitActive();
    },
    reconnectRuntime(runtimeKeyInput) {
      const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
      if (!runtimeKey) {
        return false;
      }
      const entry = entries.get(runtimeKey);
      if (!entry?.target) {
        return false;
      }
      entry.connectedSignature = '';
      connectEntry(entry, entry.target);
      entry.runtime.setActivityMode(runtimeKey === activeRuntimeKey ? 'active' : 'idle');
      emitRuntime(runtimeKey);
      return true;
    },
    disconnectRuntime(runtimeKeyInput) {
      const runtimeKey = normalizeRuntimeKey(runtimeKeyInput);
      if (!runtimeKey) {
        return false;
      }
      const entry = entries.get(runtimeKey);
      if (!entry) {
        return false;
      }
      entry.runtime.disconnect();
      entry.connectedSignature = '';
      emitRuntime(runtimeKey);
      return true;
    },
    sendInput(runtimeKeyInput, data) {
      const runtime = this.getRuntime(runtimeKeyInput);
      if (!runtime) {
        return false;
      }
      runtime.sendInput(data);
      return true;
    },
    updateViewport(runtimeKeyInput, viewState) {
      const runtime = this.getRuntime(runtimeKeyInput);
      if (!runtime) {
        return false;
      }
      runtime.updateViewport(viewState);
      return true;
    },
    resizeTerminal(runtimeKeyInput, cols, rows) {
      const runtime = this.getRuntime(runtimeKeyInput);
      if (!runtime) {
        return false;
      }
      runtime.resizeTerminal(cols, rows);
      return true;
    },
    disposeRuntime,
    releaseRuntime: disposeRuntime,
    dispose() {
      const runtimeKeys = Array.from(entries.keys());
      runtimeKeys.forEach((runtimeKey) => disposeRuntime(runtimeKey));
      runtimeListeners.clear();
      activeListeners.clear();
      activeRuntimeKey = null;
    },
  };
}

export function useMacRuntimeState(
  registry: MacRuntimeRegistry,
  runtimeKey: MacRuntimeKey | string | null | undefined,
) {
  return useSyncExternalStore(
    runtimeKey ? (listener) => registry.subscribeRuntime(runtimeKey, listener) : subscribeNoop,
    () => registry.getRuntimeState(runtimeKey),
    () => EMPTY_MAC_RUNTIME_STATE,
  );
}
