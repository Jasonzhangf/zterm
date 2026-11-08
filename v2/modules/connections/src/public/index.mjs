export { createConnectionManager } from "./link-port.ts";
export { ConnectionError } from "./errors.ts";

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
  const entries = await connectionManager.listSessions(link);
  return {
    link,
    machineId: link.machineId,
    entries,
    openChannel: (kind, target) => connectionManager.openChannel(link, kind, target),
    close: () => connectionManager.closeOwnLink(link),
  };
}
