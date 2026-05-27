import type { PersistedOpenTab, SavedTabList, Session } from "../lib/types";

function toPersistedOpenTab(session: Session): PersistedOpenTab {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  };
}

function normalizePersistedOpenTab(input: unknown): PersistedOpenTab | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Partial<PersistedOpenTab>;
  const sessionId =
    typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
  const bridgeHost =
    typeof candidate.bridgeHost === "string" ? candidate.bridgeHost.trim() : "";
  const sessionName =
    typeof candidate.sessionName === "string"
      ? candidate.sessionName.trim()
      : "";

  if (!sessionId || !bridgeHost || !sessionName) {
    return null;
  }

  return {
    sessionId,
    hostId: typeof candidate.hostId === "string" ? candidate.hostId : "",
    connectionName:
      typeof candidate.connectionName === "string" &&
      candidate.connectionName.trim()
        ? candidate.connectionName.trim()
        : sessionName,
    bridgeHost,
    bridgePort:
      typeof candidate.bridgePort === "number" &&
      Number.isFinite(candidate.bridgePort)
        ? candidate.bridgePort
        : 3333,
    sessionName,
    authToken:
      typeof candidate.authToken === "string" ? candidate.authToken : undefined,
    autoCommand:
      typeof candidate.autoCommand === "string"
        ? candidate.autoCommand
        : undefined,
    customName:
      typeof candidate.customName === "string" && candidate.customName.trim()
        ? candidate.customName.trim()
        : undefined,
    createdAt:
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
  };
}

function normalizeSavedTabList(input: unknown): SavedTabList | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Partial<SavedTabList>;
  const now = Date.now();
  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : `imported-tab-list-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs
        .map(normalizePersistedOpenTab)
        .filter((item): item is PersistedOpenTab => item !== null)
    : [];

  if (!name || tabs.length === 0) {
    return null;
  }

  return {
    id,
    name,
    tabs,
    activeSessionId:
      typeof candidate.activeSessionId === "string"
        ? candidate.activeSessionId
        : undefined,
    createdAt:
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : now,
    updatedAt:
      typeof candidate.updatedAt === "number" &&
      Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : now,
  };
}

export { toPersistedOpenTab, normalizePersistedOpenTab, normalizeSavedTabList };
