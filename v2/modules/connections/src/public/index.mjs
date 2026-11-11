export { createConnectionManager } from "./link-port.ts";
export { ConnectionError } from "./errors.ts";
export { V1TraversalTransport } from "../adapters/v1-traversal.ts";
export { createTerminalMuxClient } from "./terminal-mux-client.ts";

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
  callerToken,
  verifiedAuthorization,
  existingLink = null,
}) {
  const link = await acquireAuthorizedMachineLink({
    connectionManager,
    machineId,
    callerToken,
    verifiedAuthorization,
    existingLink,
  });
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

/**
 * Acquire the caller's current authorized link without superseding it.
 *
 * A caller may already hold the machine's current link (for example the link
 * opened by the machine connect route). Reuse that link when it is still the
 * current connected and fresh generation so the caller keeps one generation
 * truth; only open a new physical link when no reusable current link exists.
 */
async function acquireAuthorizedMachineLink({
  connectionManager,
  machineId,
  callerToken,
  verifiedAuthorization,
  existingLink,
}) {
  if (existingLink && existingLink.machineId === machineId) {
    try {
      const observation = connectionManager.observeLink(existingLink);
      if (
        observation.generation === existingLink.generation
        && observation.status === "connected"
        && observation.freshness === "fresh"
      ) {
        return existingLink;
      }
    } catch {
      // A stale or unknown generation cannot be reused; fall through to a
      // fresh authorized connect below.
    }
  }
  return connectionManager.connect(machineId, callerToken, verifiedAuthorization);
}
