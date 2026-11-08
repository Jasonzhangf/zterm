// Public host-observability producer for terminal bindings.
//
// The probe reads the real tmux endpoint through TmuxAdapter.listSessions and
// then inspects the selected session's actual panes. A session name is only a
// lookup key; the returned stableId is the V1 tmux identity from the live
// endpoint, never a name-derived or synthesized identifier.
//
// Authoritative machine identity has no source inside this host adapter yet.
// Callers may inject an already verified identity. Without one the probe keeps
// machineId null so members can surface BINDING_HOST_IDENTITY_UNAVAILABLE
// instead of inventing an identifier.

import { TmuxAdapter } from "../tmux/tmux-adapter.mjs";

const TMUX_STABLE_ID_PREFIX = "tmux:v1:";

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildTmuxStableId({ socketPath, serverPid, sessionId, createdAt }) {
  return `${TMUX_STABLE_ID_PREFIX}${encodeURIComponent(JSON.stringify({
    backend: "tmux",
    ...(socketPath ? { socketPath } : {}),
    serverPid,
    sessionId,
    createdAt,
  }))}`;
}

export function createTmuxHostProbe({
  socketName,
  backend = "tmux",
  machineId = null,
  tmuxBin = "tmux",
} = {}) {
  const resolvedSocketName = readText(socketName);
  if (!resolvedSocketName) {
    throw new TypeError("host probe requires a tmux socketName");
  }
  const resolvedBackend = readText(backend);
  if (!resolvedBackend) {
    throw new TypeError("host probe requires a terminal backend");
  }
  const authoritativeMachineId = readText(machineId) || null;
  const adapter = new TmuxAdapter({ socketName: resolvedSocketName, tmuxBin });

  async function probe({ sessionId, anchor } = {}) {
    const observedAt = new Date().toISOString();
    const requested = readText(sessionId);
    const requestedAnchor = readText(anchor);
    let sessions;
    try {
      sessions = await adapter.listSessions();
    } catch (error) {
      return {
        available: false,
        machineId: authoritativeMachineId,
        sessionId: requested || null,
        anchor: requestedAnchor || null,
        anchorPresent: false,
        terminalTarget: null,
        observedAt,
        errorCode: error?.code ?? "TMUX_COMMAND_FAILED",
      };
    }

    const matches = requested === ""
      ? []
      : sessions.filter((session) => session.id === requested || session.name === requested);
    if (matches.length !== 1) {
      return {
        available: false,
        machineId: authoritativeMachineId,
        sessionId: requested || null,
        anchor: requestedAnchor || null,
        anchorPresent: false,
        terminalTarget: null,
        observedAt,
        errorCode: "TARGET_NOT_FOUND",
      };
    }

    const session = matches[0];
    let paneIds;
    try {
      const { stdout } = await adapter.run(["list-panes", "-t", session.id, "-F", "#{pane_id}"]);
      paneIds = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      return {
        available: false,
        machineId: authoritativeMachineId,
        sessionId: session.id,
        anchor: requestedAnchor || null,
        anchorPresent: false,
        terminalTarget: null,
        observedAt,
        errorCode: error?.code ?? "TMUX_COMMAND_FAILED",
      };
    }

    return {
      available: true,
      machineId: authoritativeMachineId,
      sessionId: session.id,
      anchor: requestedAnchor || null,
      anchorPresent: requestedAnchor ? paneIds.includes(requestedAnchor) : false,
      terminalTarget: {
        backend: resolvedBackend,
        stableId: buildTmuxStableId({
          socketPath: session.socketPath,
          serverPid: session.serverPid,
          sessionId: session.id,
          createdAt: session.createdAt,
        }),
      },
      observedAt,
    };
  }

  return Object.freeze({ probe });
}
