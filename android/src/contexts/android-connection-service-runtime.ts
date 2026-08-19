import type { AndroidConnectionServiceSnapshot } from '../lib/android-connection-service-snapshot';
import { sendAndroidConnectionCommand } from '../plugins/AndroidConnectionServicePlugin';
import type { AndroidConnectionCommand } from '../lib/android-connection-service-commands';

export interface AndroidConnectionServiceRuntimeOptions {
  readSnapshot: () => AndroidConnectionServiceSnapshot;
  subscribe: (
    listener: (snapshot: AndroidConnectionServiceSnapshot) => void,
  ) => () => void;
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
    projectLifecycleSignal: (_signal: string) => null,
  };
}
