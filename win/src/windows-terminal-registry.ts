import { createWindowsTerminalSession, type WindowsTerminalSession } from './windows-terminal-session';
import type { WindowsWorkspaceTab } from './windows-workspace';

export interface WindowsTerminalRegistry {
  ensure: (tab: WindowsWorkspaceTab) => WindowsTerminalSession | null;
  get: (tabId: string) => WindowsTerminalSession | null;
  release: (tabId: string) => void;
  retain: (tabIds: Set<string>) => void;
  dispose: () => void;
}

export function createWindowsTerminalRegistry(
  sessionFactory: () => WindowsTerminalSession = createWindowsTerminalSession,
): WindowsTerminalRegistry {
  const sessions = new Map<string, WindowsTerminalSession>();
  return {
    ensure(tab) {
      if (!tab.target) return null;
      const existing = sessions.get(tab.id);
      if (existing) return existing;
      const session = sessionFactory();
      sessions.set(tab.id, session);
      session.connect(tab.target);
      return session;
    },
    get: (tabId) => sessions.get(tabId) ?? null,
    release(tabId) {
      const session = sessions.get(tabId);
      if (!session) return;
      sessions.delete(tabId);
      session.dispose();
    },
    retain(tabIds) {
      for (const tabId of sessions.keys()) {
        if (!tabIds.has(tabId)) this.release(tabId);
      }
    },
    dispose() {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}
