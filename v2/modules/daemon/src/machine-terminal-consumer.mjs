import { TypedError } from "../../errors/src/public/index.mjs";
import { createTerminalBufferRenderRuntime } from "@zterm/stream-boundary";
import { snapshotToFrame, toFrameChunk } from "../../terminal/src/public/index.mjs";

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

function openTerminalChannel(connectionManager, link, entry) {
  return connectionManager.openChannel(link, "terminal", {
    sessionName: entry.name,
    backend: entry.backend,
    expectedSessionIdentity: entry.stableId,
    existingOnly: true,
    bodySubscribed: true,
  });
}

function normalizeSubscriber(listener, options = {}) {
  if (typeof listener === "function") {
    return { onFrame: listener, onError: options.onError };
  }
  if (listener && typeof listener === "object") {
    return { onFrame: listener.onFrame, onError: listener.onError };
  }
  return null;
}

function parseChannelMessage(event) {
  if (typeof event !== "object" || typeof event.data !== "string") {
    return null;
  }
  try {
    const message = JSON.parse(event.data);
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

/**
 * Daemon-side adapter: projects a connections ConnectionManager into the
 * machine-scoped terminal consumer required by terminal admission.
 *
 * It owns no connection or catalog truth. Every field is projected from the
 * connections link observation, and catalog/input/subscribe flow through the
 * same LinkRef returned by connect(machineId). `listSessions(link)` is the
 * connections-public-runtime catalog read; until that edge exists the consumer
 * fails closed with a typed unavailable error instead of guessing.
 */
export function createConnectionMachineTerminal({ connectionManager } = {}) {
  if (
    !connectionManager
    || typeof connectionManager.connect !== "function"
    || typeof connectionManager.observeLink !== "function"
    || typeof connectionManager.openChannel !== "function"
    || typeof connectionManager.sendChannel !== "function"
    || typeof connectionManager.closeChannel !== "function"
    || typeof connectionManager.onChannelMessage !== "function"
    || typeof connectionManager.closeOwnLink !== "function"
  ) {
    throw new TypeError(
      "machine terminal consumer requires a connections manager with connect/observeLink/openChannel/sendChannel/closeChannel/onChannelMessage/closeOwnLink",
    );
  }

  const machineStates = new Map();

  async function loadCatalog(state) {
    if (!state.catalogLoaded) {
      if (typeof connectionManager.listSessions !== "function") {
        failUnavailable(
          "TERMINAL_ADMISSION_UNAVAILABLE",
          "machine-terminal.listSessions",
          "connections.listSessions(link) is not implemented yet (connections-public-runtime-1107).",
          { reason: "connections-catalog-missing" },
        );
      }
      state.catalog = await connectionManager.listSessions(state.link);
      state.catalogLoaded = true;
    }
    return state.catalog;
  }

  function closeState(state) {
    for (const channel of state.channels.values()) {
      try {
        connectionManager.closeChannel(channel);
      } catch {
        // Best-effort release; the physical link may already be gone.
      }
    }
    state.channels.clear();
    try {
      connectionManager.closeOwnLink(state.link);
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

    const link = await connectionManager.connect(machineId);
    const state = {
      link,
      observation: null,
      catalog: null,
      catalogLoaded: false,
      channels: new Map(),
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

  async function forMachine({ machineId, memberId, bindingGeneration, operationId = "machine-terminal.forMachine" } = {}) {
    requireText(machineId, "machineId", operationId);
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
    const catalog = await loadCatalog(state);
    const byStableId = new Map(catalog.map((entry) => [entry.stableId, entry]));

    const input = async (stableId, data) => {
      const entry = byStableId.get(stableId);
      if (!entry) {
        throw new TypedError({
          code: "TARGET_NOT_FOUND",
          owningModule: MODULE,
          operationId: "machine-terminal.input",
          cause: { stableId },
          message: `Terminal target ${stableId} is not in the current catalog.`,
        });
      }
      let channel = state.channels.get(stableId);
      if (!channel) {
        channel = await openTerminalChannel(connectionManager, state.link, entry);
        state.channels.set(stableId, channel);
      }
      connectionManager.sendChannel(channel, data);
      return { channelId: channel.id, linkId: state.link.id, stableId: entry.stableId };
    };

    const subscribe = async (stableId, listener, options = {}) => {
      const subscriber = normalizeSubscriber(listener, options);
      if (!subscriber) {
        throw new TypedError({
          code: "VALIDATION",
          owningModule: MODULE,
          operationId: "machine-terminal.subscribe",
          cause: { stableId },
          message: "subscribe requires a listener function or { onFrame, onError } object.",
        });
      }
      const entry = byStableId.get(stableId);
      if (!entry) {
        throw new TypedError({
          code: "TARGET_NOT_FOUND",
          owningModule: MODULE,
          operationId: "machine-terminal.subscribe",
          cause: { stableId },
          message: `Terminal target ${stableId} is not in the current catalog.`,
        });
      }
      let channel = state.channels.get(stableId);
      if (!channel) {
        channel = await openTerminalChannel(connectionManager, state.link, entry);
        state.channels.set(stableId, channel);
      }
      const runtime = createTerminalBufferRenderRuntime();
      const unsubscribe = connectionManager.onChannelMessage(channel, (event) => {
        const message = parseChannelMessage(event);
        if (!message) {
          return;
        }
        if (message.type === "channel-closed" || message.type === "mux-channel-closed") {
          const error = new Error(String(message.payload?.reason || "channel closed"));
          error.code = "TERMINAL_CHANNEL_CLOSED";
          subscriber.onError?.(error);
          return;
        }
        if (message.type !== "buffer-sync") {
          return;
        }
        const result = runtime.applyFrameChunk(toFrameChunk(message.payload || {}));
        if (result.kind === "rejected") {
          subscriber.onError?.(new Error(`terminal frame rejected: ${result.error}`));
          return;
        }
        if (result.kind === "committed") {
          subscriber.onFrame?.(snapshotToFrame(result.snapshot), {
            target: entry.name,
            observedAt: new Date().toISOString(),
          });
        }
      });
      let closed = false;
      return {
        close: () => {
          if (closed) {
            return;
          }
          closed = true;
          unsubscribe();
          connectionManager.closeChannel(channel);
          state.channels.delete(stableId);
        },
      };
    };

    return Object.freeze({
      machineId: observation.machineId,
      status: observation.status,
      freshness: observation.freshness,
      peerIdentityVerified: observation.peerIdentityVerified,
      daemonHostId: observation.peerIdentity,
      linkGeneration: state.link.generation,
      listSessions: () => catalog.map((entry) => ({ ...entry })),
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
