import type { Host } from './types';

export type HostDraft = Partial<Omit<Host, 'id' | 'createdAt'>>;

export type AppPageState =
  | { kind: 'connections' }
  | { kind: 'connection-properties'; hostId?: string; draft?: HostDraft }
  | { kind: 'settings' }
  | { kind: 'terminal' };

export const openConnectionsPage = (): AppPageState => ({ kind: 'connections' });

export const openConnectionPropertiesPage = (options?: { hostId?: string; draft?: HostDraft }): AppPageState => ({
  kind: 'connection-properties',
  hostId: options?.hostId,
  draft: options?.draft,
});

export const openSettingsPage = (): AppPageState => ({
  kind: 'settings',
});

export const openTerminalPage = (): AppPageState => ({
  kind: 'terminal',
});

// Persisted ACTIVE_PAGE may only express the current page kind
// (2026-04-28 terminal transport/session lifecycle truth). Restore eligibility
// is decided by the read guard in useAppPageState, not by rewriting the live
// kind here; that keeps the empty TerminalPage state durable.
export const resolvePersistedPageStateTruth = (pageState: AppPageState): AppPageState => {
  if (pageState.kind !== 'terminal') {
    return pageState;
  }
  return openTerminalPage();
};
