import * as React from "react";
import type { AndroidWorkspacePane, Session } from "../lib/types";

interface PaneGroup {
  paneId: string;
  activeSessionId: string | null;
}

interface VisiblePaneEntry {
  pane: AndroidWorkspacePane;
  paneIndex: number;
  session: Session;
}

interface PendingPaneAttachIntent {
  sessionIds: string[];
  paneId: string;
  nonce: number;
}

export interface UseTerminalPageInteractionRuntimeOptions {
  sessions: Session[];
  activeSession: Session | null;
  splitVisible: boolean;
  workspace: { activePaneId: string; panes: AndroidWorkspacePane[] };
  paneGroups: PaneGroup[];
  activePaneSessionId: string | null;
  visiblePaneEntries: VisiblePaneEntry[];
  pendingPaneAttachIntent: PendingPaneAttachIntent | null;
  onPaneAttachIntentApplied?: (intent: PendingPaneAttachIntent) => void;
  onLiveSessionIdsChange?: (ids: string[]) => void;
  attachSessionsToPane: (sessionIds: string[], paneId: string) => void;
  findPaneForSession: (sessionId: string) => AndroidWorkspacePane | null;
  getPaneSessionIds: (paneId: string) => string[];
  switchTabInPane: (paneId: string, tabId: string) => void;
  onSwitchSession: (id: string) => void;
}

export interface UseTerminalPageInteractionRuntimeResult {
  interactiveSession: Session | null;
  uiSession: Session | null;
  uiSessionId: string | null;
  renderedPaneSessions: Session[];
  livePaneSessionIds: string[];
  livePaneSessionIdsKey: string;
  splitVisibleRef: React.MutableRefObject<boolean>;
  handleSwipeTabRaw: (sessionId: string, direction: "previous" | "next") => void;
  handleSwitchSessionFromChromeRaw: (sessionId: string) => void;
}

export function useTerminalPageInteractionRuntime(
  options: UseTerminalPageInteractionRuntimeOptions,
): UseTerminalPageInteractionRuntimeResult {
  const {
    sessions,
    activeSession,
    splitVisible,
    workspace,
    paneGroups,
    activePaneSessionId,
    visiblePaneEntries,
    pendingPaneAttachIntent,
    onPaneAttachIntentApplied,
    onLiveSessionIdsChange,
    attachSessionsToPane,
    findPaneForSession,
    getPaneSessionIds,
    switchTabInPane,
    onSwitchSession,
  } = options;

  const interactiveSessionId = splitVisible
    ? paneGroups.find((group) => group.paneId === workspace.activePaneId)
        ?.activeSessionId || activePaneSessionId
    : activeSession?.id || activePaneSessionId;
  const interactiveSession = interactiveSessionId
    ? sessions.find((session) => session.id === interactiveSessionId) ||
      activeSession ||
      null
    : activeSession || null;
  const uiSession = interactiveSession || activeSession || null;
  const uiSessionId = uiSession?.id || null;
  const renderedPaneSessions = splitVisible
    ? visiblePaneEntries.map((entry) => entry.session)
    : interactiveSession
      ? [interactiveSession]
      : [];

  const livePaneSessionIds = React.useMemo(
    () => renderedPaneSessions.map((session) => session.id),
    [renderedPaneSessions],
  );
  const livePaneSessionIdsKey = React.useMemo(
    () => livePaneSessionIds.join("||"),
    [livePaneSessionIds],
  );

  const splitVisibleRef = React.useRef<boolean>(splitVisible);
  splitVisibleRef.current = splitVisible;

  const previousLivePaneSessionIdsKeyRef = React.useRef<string>("");
  const appliedPaneAttachIntentNonceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!pendingPaneAttachIntent) return;
    if (appliedPaneAttachIntentNonceRef.current === pendingPaneAttachIntent.nonce) return;
    const normalizedSessionIds = [
      ...new Set(
        pendingPaneAttachIntent.sessionIds
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const normalizedPaneId = pendingPaneAttachIntent.paneId.trim();
    if (normalizedSessionIds.length === 0 || !normalizedPaneId) {
      console.error(
        "[TerminalPage] Refused pane-attach intent without explicit sessionIds/paneId.",
        pendingPaneAttachIntent,
      );
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    const knownSessionIds = new Set(sessions.map((s) => s.id));
    const allSessionsPresent = normalizedSessionIds.every((id) =>
      knownSessionIds.has(id),
    );
    const paneExists = workspace.panes.some((p) => p.id === normalizedPaneId);
    if (!paneExists) {
      console.error(
        "[TerminalPage] Refused pane-attach intent because target pane does not exist.",
        {
          paneId: normalizedPaneId,
          workspacePaneIds: workspace.panes.map((p) => p.id),
          sessionIds: normalizedSessionIds,
        },
      );
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    if (!allSessionsPresent) return;
    appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
    attachSessionsToPane(normalizedSessionIds, normalizedPaneId);
    onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
  }, [attachSessionsToPane, onPaneAttachIntentApplied, pendingPaneAttachIntent, sessions, workspace.panes]);

  React.useLayoutEffect(() => {
    if (!onLiveSessionIdsChange) {
      previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
      return;
    }
    if (previousLivePaneSessionIdsKeyRef.current === livePaneSessionIdsKey) return;
    previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
    onLiveSessionIdsChange(livePaneSessionIds);
  }, [livePaneSessionIds, livePaneSessionIdsKey, onLiveSessionIdsChange]);

  React.useEffect(
    () => () => {
      previousLivePaneSessionIdsKeyRef.current = "";
      onLiveSessionIdsChange?.([]);
    },
    [onLiveSessionIdsChange],
  );

  const handleSwipeTabRaw = React.useCallback(
    (sessionId: string, direction: "previous" | "next") => {
      const currentSplitVisible = splitVisibleRef.current;
      const currentActivePaneId = workspace.activePaneId;
      const paneScopedSessions = currentSplitVisible
        ? getPaneSessionIds(currentActivePaneId)
            .map(
              (paneSessionId) =>
                sessions.find((session) => session.id === paneSessionId) || null,
            )
            .filter((session): session is Session => Boolean(session))
        : sessions;
      const currentIndex = paneScopedSessions.findIndex(
        (session) => session.id === sessionId,
      );
      if (currentIndex < 0) return;
      const targetIndex =
        direction === "previous" ? currentIndex - 1 : currentIndex + 1;
      const targetSession = paneScopedSessions[targetIndex] || null;
      if (!targetSession || targetSession.id === sessionId) return;
      const targetPane = currentSplitVisible
        ? findPaneForSession(targetSession.id)
        : null;
      if (currentSplitVisible && targetPane) {
        switchTabInPane(targetPane.id, `tab-${targetSession.id}`);
      }
      onSwitchSession(targetSession.id);
    },
    [
      findPaneForSession,
      getPaneSessionIds,
      onSwitchSession,
      sessions,
      splitVisibleRef,
      switchTabInPane,
      workspace.activePaneId,
    ],
  );

  const handleSwitchSessionFromChromeRaw = React.useCallback(
    (sessionId: string) => {
      if (splitVisibleRef.current) {
        const targetPane = findPaneForSession(sessionId);
        if (!targetPane) {
          console.error(
            "[TerminalPage] Refused to switch split tab without a pane owner.",
            {
              sessionId,
              workspacePaneIds: workspace.panes.map((p) => p.id),
            },
          );
          return;
        }
        switchTabInPane(targetPane.id, `tab-${sessionId}`);
      }
      onSwitchSession(sessionId);
    },
    [findPaneForSession, onSwitchSession, splitVisibleRef, switchTabInPane, workspace.panes],
  );

  return {
    interactiveSession,
    uiSession,
    uiSessionId,
    renderedPaneSessions,
    livePaneSessionIds,
    livePaneSessionIdsKey,
    splitVisibleRef,
    handleSwipeTabRaw,
    handleSwitchSessionFromChromeRaw,
  };
}
