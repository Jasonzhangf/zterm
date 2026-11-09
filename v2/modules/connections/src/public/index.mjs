export { createConnectionManager } from "./link-port.ts";
export { ConnectionError } from "./errors.ts";
export { V1TraversalTransport } from "../adapters/v1-traversal.ts";

/**
 * Resolve one member's machine-scoped authorized terminal directory.
 *
 * The caller supplies the member's current authorized link (or lets the
 * injected authorization port resolve it). `connect` verifies the peer's
 * daemonHostId; the returned catalog and every terminal operation stay bound
 * to that same verified link. No machine state is stored here and no
 * LinkRef.generation is written into members.
 */
export async function resolveAuthorizedTerminalDirectory({
  connectionManager,
  machineId,
  verifiedAuthorization,
}) {
  const link = await connectionManager.connect(machineId, verifiedAuthorization);
  let entries;
  try {
    entries = await connectionManager.listSessions(link);
  } catch (error) {
    // The caller cannot release a link it never received, so a failed catalog
    // read owns the physical connection and closes it before rethrowing.
    try {
      connectionManager.closeOwnLink(link);
    } catch {
      // Cleanup is best-effort: a superseded link already released its
      // transport, and that cleanup failure must not replace the caller's
      // original typed catalog error.
    }
    throw error;
  }
  return {
    link,
    machineId: link.machineId,
    entries,
    openChannel: (kind, target) => connectionManager.openChannel(link, kind, target),
    close: () => connectionManager.closeOwnLink(link),
  };
}
