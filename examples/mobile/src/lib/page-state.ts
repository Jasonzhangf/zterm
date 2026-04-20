import type { Host } from './types';

export type HostDraft = Partial<Omit<Host, 'id' | 'createdAt'>>;

export type AppPageState =
  | { kind: 'connections' }
  | { kind: 'connection-properties'; hostId?: string; draft?: HostDraft }
  | { kind: 'settings' }
  | { kind: 'terminal'; focusSessionId?: string };

export const openConnectionsPage = (): AppPageState => ({ kind: 'connections' });

export const openConnectionPropertiesPage = (options?: { hostId?: string; draft?: HostDraft }): AppPageState => ({
  kind: 'connection-properties',
  hostId: options?.hostId,
  draft: options?.draft,
});

export const openSettingsPage = (): AppPageState => ({
  kind: 'settings',
});

export const openTerminalPage = (focusSessionId?: string): AppPageState => ({
  kind: 'terminal',
  focusSessionId,
});
