import type { Session } from "../lib/types";

export interface TerminalTabChromeItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: Session["resolvedPath"];
}

export function terminalPageRenderedSessionUiKey(session: Session | null | undefined) {
  if (!session) {
    return "";
  }
  return [
    session.id,
    session.hostId,
    session.connectionName,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || "",
    session.resolvedPath || "",
  ].join("::");
}

export function terminalPageRenderedSessionsUiKey(sessions: Session[]) {
  return sessions
    .map((session) => terminalPageRenderedSessionUiKey(session))
    .join("||");
}

export function terminalPageHeaderSessionUiKey(session: Session | null | undefined) {
  if (!session) {
    return "";
  }
  return [
    session.id,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || "",
    session.resolvedPath || "",
  ].join("::");
}

export function terminalPageHeaderSessionsUiKey(sessions: Session[]) {
  return sessions
    .map((session) => terminalPageHeaderSessionUiKey(session))
    .join("||");
}

export function terminalPageActiveRuntimeStatusKey(
  session: Session | null | undefined,
) {
  if (!session) {
    return "";
  }
  return [session.id, session.state, session.lastError || ""].join("::");
}

export function resolveSessionInputEpoch(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return -1;
  }
  return inputResetEpochBySession?.[sessionId] || 0;
}

export function resolveRenderedSessionsInputEpochKey(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessions: Session[],
) {
  return sessions
    .map(
      (session) =>
        `${session.id}:${resolveSessionInputEpoch(inputResetEpochBySession, session.id)}`,
    )
    .join("||");
}

export function toTerminalTabChromeItem(session: Session): TerminalTabChromeItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
  };
}
