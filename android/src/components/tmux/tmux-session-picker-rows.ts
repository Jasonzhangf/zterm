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
  const openTabBySessionName = new Map<string, PickerOpenTab>();
  openTabsForTarget.forEach((tab) => {
    if (!openTabBySessionName.has(tab.sessionName)) {
      openTabBySessionName.set(tab.sessionName, tab);
    }
  });

  const remoteNames = new Set(input.availableSessions);
  const daemonRows = input.availableSessions.map((sessionName) => {
    const openTab = openTabBySessionName.get(sessionName) || null;
    return {
      key: `daemon:${sessionName}`,
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
