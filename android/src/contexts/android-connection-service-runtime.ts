import type { AndroidConnectionServiceSnapshot } from '../lib/android-connection-service-snapshot';
import { sendAndroidConnectionCommand } from '../plugins/AndroidConnectionServicePlugin';
import type { AndroidConnectionCommand } from '../lib/android-connection-service-commands';

export interface AndroidConnectionServiceRuntimeOptions {
  readSnapshot: () => AndroidConnectionServiceSnapshot;
  subscribe: (
    listener: (snapshot: AndroidConnectionServiceSnapshot) => void,
  ) => () => void;
}

export interface AndroidConnectionLifecycleSignal {
  readonly source: 'foreground-resume';
}

export interface AndroidConnectionLifecycleProjection {
  readonly kind: 'foreground-resume';
  readonly platform: 'android';
  readonly snapshotGeneration: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectLifecycleSignal(
  signal: unknown,
  snapshot: AndroidConnectionServiceSnapshot,
): AndroidConnectionLifecycleProjection {
  if (!isRecord(signal)) {
    throw new Error('invalid Android lifecycle signal');
  }
  if (signal.source !== 'foreground-resume') {
    throw new Error(`unsupported Android lifecycle signal: ${String(signal.source)}`);
  }
  if ('connected' in signal || 'connectionType' in signal) {
    throw new Error('Android lifecycle projection must not fabricate connection truth');
  }
  return {
    kind: 'foreground-resume',
    platform: 'android',
    snapshotGeneration: snapshot.generation,
  };
}

/**
 * Projection-only runtime for AndroidConnectionService.
 *
 * It owns snapshot subscription state and typed user commands. It never owns
 * transport, heartbeat, reconnect, network probing, or route selection.
 */
export function createAndroidConnectionServiceRuntime(options: AndroidConnectionServiceRuntimeOptions) {
  let latestSnapshot = options.readSnapshot();
  let projectionAttached = false;
  let unsubscribe: (() => void) | null = null;

  return {
    readSnapshot: () => latestSnapshot,
    attach: () => {
      if (projectionAttached) {
        return latestSnapshot;
      }
      projectionAttached = true;
      unsubscribe = options.subscribe((snapshot) => {
        latestSnapshot = snapshot;
      });
      return latestSnapshot;
    },
    detach: () => {
      if (!projectionAttached) {
        return;
      }
      projectionAttached = false;
      unsubscribe?.();
      unsubscribe = null;
    },
    applySnapshot: (snapshot: AndroidConnectionServiceSnapshot) => {
      latestSnapshot = snapshot;
      return latestSnapshot;
    },
    sendCommand: (command: AndroidConnectionCommand) => sendAndroidConnectionCommand(command),
    projectLifecycleSignal: (signal: AndroidConnectionLifecycleSignal) => (
      projectLifecycleSignal(signal, latestSnapshot)
    ),
  };
}
