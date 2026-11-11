import { TypedError } from "../../errors/src/public/index.mjs";
import { resolveAuthorizedTerminalDirectory } from "../../connections/src/public/index.mjs";

const MODULE = "daemon";

function failUnavailable(code, operationId, message, cause) {
  throw new TypedError({
    code,
    owningModule: MODULE,
    operationId,
    cause,
    message,
  });
}

function requireText(value, field, operationId) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    failUnavailable("VALIDATION", operationId, `${field} must be a non-empty string.`, { field });
  }
  return text;
}

/**
 * Daemon-side machine terminal consumer.
 *
 * The connections module owns the verified machine link and the exact
 * machine-scoped terminal catalog. The terminal module owns channel open,
 * input, and stream dispatch through its public TerminalPort. This adapter
 * keeps those two public owners in one scoped object; it never reimplements
 * either catalog truth or the mux channel protocol.
 */
export function createConnectionMachineTerminal({
  connectionManager,
  resolveDirectory = resolveAuthorizedTerminalDirectory,
  authorizationPort = null,
  terminal = null,
} = {}) {
  if (
    !connectionManager
    || typeof connectionManager.connect !== "function"
    || typeof connectionManager.observeLink !== "function"
    || typeof connectionManager.listSessions !== "function"
    || typeof connectionManager.closeOwnLink !== "function"
  ) {
    throw new TypeError(
      "machine terminal consumer requires a connections manager with connect/observeLink/listSessions/closeOwnLink",
    );
  }
  if (typeof resolveDirectory !== "function") {
    throw new TypeError(
      "machine terminal consumer requires the connections resolveAuthorizedTerminalDirectory public entry",
    );
  }
  if (authorizationPort !== null && typeof authorizationPort.authorizeMachine !== "function") {
    throw new TypeError(
      "machine terminal consumer requires an authorization port with authorizeMachine(machineId)",
    );
  }
  if (!terminal || typeof terminal.input !== "function" || typeof terminal.subscribe !== "function") {
    throw new TypeError(
      "machine terminal consumer requires a terminal port with input() and subscribe()",
    );
  }

  const machineStates = new Map();

  function closeState(state) {
    try {
      state.directory.close();
    } catch {
      // Best-effort release; the physical link may already be gone.
    }
  }

  async function currentState(machineId) {
    const existing = machineStates.get(machineId);
    if (existing) {
      let observation;
      try {
        observation = connectionManager.observeLink(existing.link);
      } catch (error) {
        machineStates.delete(machineId);
        throw error;
      }
      if (observation.status !== "connected" || observation.freshness !== "fresh") {
        machineStates.delete(machineId);
        closeState(existing);
        return null;
      }
      existing.observation = observation;
      return existing;
    }

    const directory = await resolveDirectory({ connectionManager, machineId });
    const link = directory.link;
    const state = {
      directory,
      link,
      observation: null,
      catalog: directory.entries,
    };
    try {
      state.observation = connectionManager.observeLink(link);
    } catch (error) {
      closeState(state);
      throw error;
    }
    if (state.observation.status !== "connected" || state.observation.freshness !== "fresh") {
      closeState(state);
      return null;
    }
    machineStates.set(machineId, state);
    return state;
  }

  async function forMachine({
    machineId,
    memberId,
    bindingGeneration,
    operationId = "machine-terminal.forMachine",
  } = {}) {
    requireText(machineId, "machineId", operationId);
    if (authorizationPort) {
      try {
        await authorizationPort.authorizeMachine(machineId);
      } catch (error) {
        throw new TypedError({
          code: typeof error?.code === "string" ? error.code : "MACHINE_REVOKED",
          owningModule: "accounts",
          operationId,
          cause: error,
          message: error?.message || "Machine authorization was revoked.",
        });
      }
    }
    const state = await currentState(machineId);
    const observation = state && state.observation;
    if (!state || !observation) {
      failUnavailable(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The machine link is not connected and fresh.",
        {
          machineId,
          status: observation?.status ?? null,
          freshness: observation?.freshness ?? null,
        },
      );
    }
    if (
      observation.peerIdentityVerified !== true
      || typeof observation.peerIdentity !== "string"
      || observation.peerIdentity.trim() === ""
    ) {
      machineStates.delete(machineId);
      closeState(state);
      failUnavailable(
        "peer_identity_mismatch",
        operationId,
        "The machine link has no verified canonical peer identity.",
        { machineId, peerIdentity: observation.peerIdentity ?? null },
      );
    }

    const byStableId = new Map(state.catalog.map((entry) => [entry.stableId, entry]));
    function requireCatalogEntry(stableId, operationId) {
      const entry = byStableId.get(stableId);
      if (!entry) {
        throw new TypedError({
          code: "TARGET_NOT_FOUND",
          owningModule: MODULE,
          operationId,
          cause: { stableId },
          message: `Terminal target ${stableId} is not in the current catalog.`,
        });
      }
      return entry;
    }

    const input = async (stableId, data) => {
      const entry = requireCatalogEntry(stableId, "machine-terminal.input");
      return terminal.input(entry.stableId, data);
    };

    const subscribe = (stableId, listener, options = {}) => {
      const entry = requireCatalogEntry(stableId, "machine-terminal.subscribe");
      return terminal.subscribe(entry.stableId, listener, options);
    };

    return Object.freeze({
      machineId: observation.machineId,
      status: observation.status,
      freshness: observation.freshness,
      peerIdentityVerified: observation.peerIdentityVerified,
      daemonHostId: observation.peerIdentity,
      linkGeneration: state.link.generation,
      listSessions: () => state.catalog.map((entry) => ({ ...entry })),
      input,
      subscribe,
      close: () => {
        if (machineStates.get(machineId) === state) {
          machineStates.delete(machineId);
        }
        closeState(state);
      },
    });
  }

  return Object.freeze({
    forMachine,
  });
}
