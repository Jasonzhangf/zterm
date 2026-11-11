import { TypedError } from "../../errors/src/public/index.mjs";
import {
  createTerminalMuxClient,
  resolveAuthorizedTerminalDirectory,
} from "../../connections/src/public/index.mjs";
import { TerminalPort } from "../../terminal/src/public/index.mjs";

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

function staleGeneration(operationId, message, cause) {
  return failUnavailable("stale_generation", operationId, message, cause);
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
 * composes one TerminalPort per authorized machine link; it never reimplements
 * catalog truth, the mux channel protocol, or a second connection state machine.
 */
export function createConnectionMachineTerminal({
  connectionManager,
  resolveDirectory = resolveAuthorizedTerminalDirectory,
  authorizationPort = null,
  terminal = null,
  localMachineId = "",
  createMuxClient = createTerminalMuxClient,
  createTerminalPort = (options) => new TerminalPort(options),
  log = () => {},
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
  if (
    authorizationPort !== null
    && typeof authorizationPort.authorizeCallerMachine !== "function"
  ) {
    throw new TypeError(
      "machine terminal consumer requires an authorization port with authorizeCallerMachine(machineId, callerToken)",
    );
  }
  if (typeof createMuxClient !== "function") {
    throw new TypeError(
      "machine terminal consumer requires createMuxClient to be a function",
    );
  }
  if (typeof createTerminalPort !== "function") {
    throw new TypeError(
      "machine terminal consumer requires createTerminalPort to be a function",
    );
  }
  if (typeof log !== "function") {
    throw new TypeError("machine terminal consumer requires log to be a function");
  }

  const normalizedLocalMachineId = localMachineId === undefined || localMachineId === null || localMachineId === ""
    ? ""
    : requireText(localMachineId, "localMachineId", "machine-terminal.factory");
  const hasLocalTerminal = normalizedLocalMachineId !== "";
  if (terminal !== null) {
    if (
      !terminal
      || typeof terminal.input !== "function"
      || typeof terminal.subscribe !== "function"
      || typeof terminal.listSessions !== "function"
      || typeof terminal.close !== "function"
    ) {
      throw new TypeError(
        "machine terminal consumer requires a terminal port with input(), subscribe(), listSessions(), and close()",
      );
    }
  }
  if (hasLocalTerminal && terminal === null) {
    throw new TypeError(
      "machine terminal consumer requires a local terminal port when localMachineId is configured",
    );
  }

  const machineStates = new Map();

  function machineStateKey(accountId, machineId) {
    const scope = typeof accountId === "string" ? accountId.trim() : "";
    return scope ? JSON.stringify([scope, machineId]) : machineId;
  }

  function releaseState(state) {
    if (state.released) {
      return;
    }
    state.released = true;
    if (state.ownsTerminalPort && state.terminalPort) {
      try {
        state.terminalPort.close();
      } catch {
        // Best-effort release; the physical link may already be gone.
      }
    }
    try {
      state.directory.close();
    } catch {
      // Best-effort release; the physical link may already be gone.
    }
  }

  function ensureTerminalPort(state) {
    if (state.terminalPort) {
      return state.terminalPort;
    }
    if (state.kind === "local") {
      state.terminalPort = terminal;
      state.ownsTerminalPort = false;
      return state.terminalPort;
    }
    const muxClient = createMuxClient({ connectionManager, link: state.link, log });
    state.terminalPort = createTerminalPort({ muxClient, log });
    state.ownsTerminalPort = true;
    return state.terminalPort;
  }

  function assertScopedCurrent(state, operationId) {
    if (state.released || machineStates.get(state.key) !== state) {
      staleGeneration(
        operationId,
        "The machine terminal adapter is no longer the current authorized link.",
        { machineId: state.link.machineId, linkGeneration: state.link.generation },
      );
    }
    let observation;
    try {
      observation = connectionManager.observeLink(state.link);
    } catch (error) {
      machineStates.delete(state.key);
      releaseState(state);
      throw error;
    }
    if (observation.generation !== state.link.generation) {
      machineStates.delete(state.key);
      releaseState(state);
      staleGeneration(
        operationId,
        "The machine link generation changed after the terminal handle was created.",
        {
          machineId: state.link.machineId,
          expectedGeneration: state.link.generation,
          actualGeneration: observation.generation,
        },
      );
    }
    if (observation.status !== "connected" || observation.freshness !== "fresh") {
      machineStates.delete(state.key);
      releaseState(state);
      failUnavailable(
        "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        operationId,
        "The machine link is not connected and fresh.",
        {
          machineId: state.link.machineId,
          status: observation.status,
          freshness: observation.freshness,
        },
      );
    }
    state.observation = observation;
  }

  async function currentState(machineId, callerToken, callerAccountId) {
    const stateKey = machineStateKey(callerAccountId, machineId);
    const existing = machineStates.get(stateKey);
    if (existing) {
      let observation;
      try {
        observation = connectionManager.observeLink(existing.link);
      } catch (error) {
        machineStates.delete(stateKey);
        releaseState(existing);
        throw error;
      }
      if (observation.generation !== existing.link.generation) {
        machineStates.delete(stateKey);
        releaseState(existing);
      } else if (observation.status !== "connected" || observation.freshness !== "fresh") {
        machineStates.delete(stateKey);
        releaseState(existing);
      } else {
        existing.observation = observation;
        return existing;
      }
    }

    const directory = await resolveDirectory({
      connectionManager,
      machineId,
      callerToken,
    });
    const link = directory.link;
    const linkedAccountId = typeof link.accountId === "string" ? link.accountId.trim() : "";
    const linkedStateKey = machineStateKey(
      callerAccountId || linkedAccountId,
      machineId,
    );
    const state = {
      key: linkedStateKey,
      directory,
      link,
      observation: null,
      kind: normalizedLocalMachineId === machineId ? "local" : "remote",
      terminalPort: null,
      ownsTerminalPort: false,
      released: false,
    };
    try {
      state.observation = connectionManager.observeLink(link);
    } catch (error) {
      releaseState(state);
      throw error;
    }
    if (
      state.observation.generation !== link.generation
      || state.observation.status !== "connected"
      || state.observation.freshness !== "fresh"
    ) {
      releaseState(state);
      return null;
    }
    machineStates.set(linkedStateKey, state);
    return state;
  }

  async function forMachine({
    machineId,
    memberId,
    bindingGeneration,
    accountsToken,
    operationId = "machine-terminal.forMachine",
  } = {}) {
    requireText(machineId, "machineId", operationId);
    let callerAccountId = "";
    if (authorizationPort) {
      const token = typeof accountsToken === "string" ? accountsToken.trim() : "";
      if (!token) {
        throw new TypedError({
          code: "MACHINE_ACCOUNT_SESSION_REQUIRED",
          owningModule: MODULE,
          operationId,
          cause: { machineId },
          message: "An accounts session credential is required.",
        });
      }
      try {
        const authorization = await authorizationPort.authorizeCallerMachine(machineId, token);
        callerAccountId = typeof authorization?.accountId === "string"
          ? authorization.accountId.trim()
          : "";
        if (!callerAccountId) {
          throw new TypedError({
            code: "MACHINE_ACCOUNT_SESSION_REQUIRED",
            owningModule: MODULE,
            operationId,
            cause: { machineId },
            message: "The accounts machine authorization has no account scope.",
          });
        }
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

    const state = await currentState(machineId, accountsToken, callerAccountId);
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
      machineStates.delete(state.key);
      releaseState(state);
      failUnavailable(
        "peer_identity_mismatch",
        operationId,
        "The machine link has no verified canonical peer identity.",
        { machineId, peerIdentity: observation.peerIdentity ?? null },
      );
    }

    try {
      ensureTerminalPort(state);
    } catch (error) {
      machineStates.delete(state.key);
      releaseState(state);
      throw error;
    }

    const scopedTerminal = state.terminalPort;
    const listSessions = async () => {
      assertScopedCurrent(state, "machine-terminal.listSessions");
      return scopedTerminal.listSessions();
    };
    const input = async (stableId, data) => {
      assertScopedCurrent(state, "machine-terminal.input");
      return scopedTerminal.input(stableId, data);
    };
    const subscribe = (stableId, listener, options = {}) => {
      assertScopedCurrent(state, "machine-terminal.subscribe");
      return scopedTerminal.subscribe(stableId, listener, options);
    };

    return Object.freeze({
      machineId: observation.machineId,
      status: observation.status,
      freshness: observation.freshness,
      peerIdentityVerified: observation.peerIdentityVerified,
      daemonHostId: observation.peerIdentity,
      linkGeneration: state.link.generation,
      listSessions,
      input,
      subscribe,
      close: () => {
        if (machineStates.get(state.key) === state) {
          machineStates.delete(state.key);
        }
        releaseState(state);
      },
    });
  }

  return Object.freeze({
    forMachine,
  });
}
