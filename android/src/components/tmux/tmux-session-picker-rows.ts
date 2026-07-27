import type { BridgeTarget } from '../../lib/tmux-sessions';

export interface PickerOpenTab {
  id: string;
  sessionName: string;
  customName?: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
}

export interface TmuxSessionPickerRow {
  key: string;
  sessionName: string;
  displayName: string;
  remotePresent: boolean;
  openTab: PickerOpenTab | null;
}

function normalizeOwnerId(value?: string | null) {
  return (value || '').trim().toLowerCase();
}

export function tabMatchesTarget(tab: PickerOpenTab, target: Pick<BridgeTarget, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId'>) {
  const tabDaemonHostId = normalizeOwnerId(tab.daemonHostId);
  const targetDaemonHostId = normalizeOwnerId(target.daemonHostId || target.relayHostId);
  if (tabDaemonHostId && targetDaemonHostId) {
    return tabDaemonHostId === targetDaemonHostId;
  }
  return tab.bridgeHost === target.bridgeHost && tab.bridgePort === target.bridgePort;
}

export function buildTmuxSessionPickerRows(input: {
  availableSessions: string[];
  openTabs: PickerOpenTab[];
  target: Pick<BridgeTarget, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId'>;
  includeOpenTabs: boolean;
}): TmuxSessionPickerRow[] {
  const openTabsForTarget = input.includeOpenTabs
    ? input.openTabs.filter((tab) => tabMatchesTarget(tab, input.target))
    : [];
  // Pick rows must key open tabs by client-owned sessionId (tab.id), not by
  // tmux sessionName. Two open tabs sharing sessionName (e.g. rcc vs rcc2 after
  // rename) must render as two distinct picker rows; otherwise the picker would
  // collapse them and the second tab would never be reachable.
  const openTabBySessionId = new Map<string, PickerOpenTab>();
  openTabsForTarget.forEach((tab) => {
    if (!openTabBySessionId.has(tab.id)) {
      openTabBySessionId.set(tab.id, tab);
    }
  });

  const remoteNames = new Set(input.availableSessions);
  const daemonRows = input.availableSessions.map((sessionName) => {
    // Match daemon-side sessionName to open tabs by (sessionName, target) — this
    // is the only place a sessionName match is allowed, and even here we must
    // tolerate multiple open tabs sharing the same sessionName.
    const openTab = openTabsForTarget.find((tab) => tab.sessionName === sessionName) || null;
    return {
      key: `daemon:${sessionName}:${openTab?.id || 'no-open'}`,
      sessionName,
      displayName: openTab?.customName || sessionName,
      remotePresent: true,
      openTab,
    };
  });
  const localOnlyRows = openTabsForTarget
    .filter((tab) => !remoteNames.has(tab.sessionName))
    .map((tab) => ({
      key: `open:${tab.id}`,
      sessionName: tab.sessionName,
      displayName: tab.customName || tab.sessionName,
      remotePresent: false,
      openTab: tab,
    }));
  return [...daemonRows, ...localOnlyRows];
}

export function findOpenTabsMissingFromRemote(input: {
  availableSessions: string[];
  openTabs: PickerOpenTab[];
  target: Pick<BridgeTarget, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId'>;
}) {
  const remoteNames = new Set(input.availableSessions);
  return input.openTabs.filter((tab) => (
    tabMatchesTarget(tab, input.target) && !remoteNames.has(tab.sessionName)
  ));
}

export function shouldAutoRefreshTmuxPicker(input: {
  open: boolean;
  relayDirectoryTarget: boolean;
  target: Pick<BridgeTarget, 'bridgeHost' | 'authToken' | 'daemonHostId' | 'relayHostId' | 'relayTmuxSessions'>;
}) {
  if (!input.open) {
    return false;
  }
  const bridgeHost = input.target.bridgeHost.trim();
  const authToken = input.target.authToken?.trim() || '';
  const relayHostId = input.target.relayHostId?.trim() || input.target.daemonHostId?.trim() || '';
  if (input.relayDirectoryTarget && !relayHostId) {
    return false;
  }
  if (input.relayDirectoryTarget && (input.target.relayTmuxSessions || []).length > 0) {
    return true;
  }
  return Boolean((bridgeHost && authToken) || input.relayDirectoryTarget);
}

export function getSelectableTmuxSessionNames(rows: TmuxSessionPickerRow[], includeOpenTabs: boolean) {
  return new Set(
    rows
      .filter((row) => row.remotePresent && (!includeOpenTabs || !row.openTab))
      .map((row) => row.sessionName),
  );
}

export function filterActionableTmuxSelections(
  selectedSessions: string[],
  rows: TmuxSessionPickerRow[],
  includeOpenTabs: boolean,
) {
  const selectableSessionNames = getSelectableTmuxSessionNames(rows, includeOpenTabs);
  return selectedSessions.filter((sessionName) => selectableSessionNames.has(sessionName));
}
