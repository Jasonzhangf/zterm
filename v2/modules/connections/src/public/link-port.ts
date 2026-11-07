/** Public entry to the connections module (first increment). */
import { ConnectionManager, type ConnectionManagerOptions } from "../application/connection-manager.ts";

export type { ConnectionManagerOptions };

/**
 * Create the connections manager. The accounts authorization port is injected;
 * connections never reads credentials directly.
 */
export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  return new ConnectionManager(options);
}

export type { ConnectionManager };
