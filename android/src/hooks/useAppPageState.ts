import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import {
  openConnectionPropertiesPage,
  openConnectionsPage,
  openSettingsPage,
  openTerminalPage,
  resolvePersistedPageStateTruth,
  type AppPageState,
} from '../lib/page-state';
import { STORAGE_KEYS, type Host, type Session } from '../lib/types';

function readPersistedPageState(options?: { allowTerminal?: boolean }): AppPageState {
  if (typeof window === 'undefined') {
    return openConnectionsPage();
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE);
    if (!raw) {
      return openConnectionsPage();
    }
    const parsed = JSON.parse(raw) as Partial<AppPageState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return openConnectionsPage();
    }
    if (parsed.kind === 'terminal' && options?.allowTerminal) {
      return openTerminalPage();
    }
    if (parsed.kind === 'settings') {
      return openSettingsPage();
    }
    if (parsed.kind === 'connection-properties') {
      return openConnectionPropertiesPage({
        hostId: typeof parsed.hostId === 'string' ? parsed.hostId : undefined,
        draft: parsed.draft && typeof parsed.draft === 'object' ? parsed.draft : undefined,
      });
    }
  } catch (error) {
    console.error('[App] Failed to restore page state:', error);
  }

  return openConnectionsPage();
}

function hasPersistedOpenTabRestoreCandidate(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    // Legacy persistence (ACTIVE_SESSION / SAVED_TAB_LISTS) is cleared on
    // cold start by open-tab-persistence; it must NOT count as a terminal
    // restore candidate, otherwise the first paint would jump into a terminal
    // shell that is about to be cleaned back to connections.
    if (localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)) {
      return false;
    }
    const rawTabs = localStorage.getItem(STORAGE_KEYS.OPEN_TABS);
    if (!rawTabs) {
      return false;
    }
    const parsedTabs = JSON.parse(rawTabs) as unknown;
    return Array.isArray(parsedTabs) && parsedTabs.length > 0;
  } catch (error) {
    console.error('[App] Failed to inspect persisted open-tab restore truth:', error);
    return false;
  }
}

function hasPersistedTerminalRouteIntent(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_PAGE);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as Partial<AppPageState> | null;
    return Boolean(parsed && typeof parsed === 'object' && parsed.kind === 'terminal');
  } catch (error) {
    console.error('[App] Failed to inspect persisted terminal route intent:', error);
    return false;
  }
}

interface UseAppPageStateOptions {
  hosts: Host[];
  sessions: Session[];
  runtimeActiveSessionId: string | null;
  addHost: (host: Omit<Host, 'id' | 'createdAt'>) => Host;
  updateHost: (id: string, updates: Omit<Host, 'id' | 'createdAt'>) => void;
  deleteHost: (id: string) => void;
  ensureTerminalPageVisible: () => void;
  syncSavedHostToServerPreset?: (host: Omit<Host, 'id' | 'createdAt'>) => void;
}

export interface AppPageStateResult {
  pageState: AppPageState;
  setPageState: Dispatch<SetStateAction<AppPageState>>;
  editingHost: Host | undefined;
  editingDraft: Partial<Omit<Host, 'id' | 'createdAt'>> | undefined;
  handleEdit: (host: Host) => void;
  handleSaveHost: (hostData: Omit<Host, 'id' | 'createdAt'>) => void;
  handleCancelHostForm: () => void;
  handleDelete: (host: Host) => void;
  handleOpenConnectionsPage: () => void;
  handleOpenSettingsPage: () => void;
}

export function useAppPageState(options: UseAppPageStateOptions): AppPageStateResult {
  const {
    hosts,
    sessions,
    runtimeActiveSessionId,
    addHost,
    updateHost,
    deleteHost,
    ensureTerminalPageVisible,
    syncSavedHostToServerPreset,
  } = options;

  const initialActiveSessionOwnsTerminal = sessions.some((session) => session.id === runtimeActiveSessionId);
  const pendingTerminalRestoreIntentRef = useRef(
    !initialActiveSessionOwnsTerminal
    && hasPersistedTerminalRouteIntent()
    && hasPersistedOpenTabRestoreCandidate(),
  );
  const [pageState, setPageState] = useState<AppPageState>(() => {
    // Pending terminal restore: open the terminal shell on the very first
    // paint so the first frame is the dark terminal surface, not the light
    // Connections page (which flashed as a white screen until the runtime
    // session hydrated and the restore effect switched pages).
    if (pendingTerminalRestoreIntentRef.current) {
      return openTerminalPage();
    }
    return readPersistedPageState({ allowTerminal: initialActiveSessionOwnsTerminal });
  });
  const restoredRouteHandledRef = useRef(false);
  const pageStateRef = useRef(pageState);

  useEffect(() => {
    pageStateRef.current = pageState;
  }, [pageState]);

  useEffect(() => {
    let removed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    void Promise.resolve(CapacitorApp.addListener('backButton', () => {
      const currentPage = pageStateRef.current;
      if (currentPage.kind === 'settings' || currentPage.kind === 'connection-properties') {
        setPageState(openConnectionsPage());
        return;
      }
      if (currentPage.kind === 'terminal') {
        return;
      }
      void CapacitorApp.exitApp();
    })).then((registered) => {
      if (removed) {
        void registered.remove();
        return;
      }
      listener = registered;
    });
    return () => {
      removed = true;
      if (listener) {
        void listener.remove();
      }
    };
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === runtimeActiveSessionId) || null,
    [runtimeActiveSessionId, sessions],
  );

  useEffect(() => {
    if (restoredRouteHandledRef.current || !activeSession) {
      return;
    }

    restoredRouteHandledRef.current = true;
    const persistedPage = readPersistedPageState({ allowTerminal: true });
    if (persistedPage.kind === 'terminal') {
      setPageState(openTerminalPage());
      ensureTerminalPageVisible();
      return;
    }
    setPageState(persistedPage);
  }, [activeSession?.id, ensureTerminalPageVisible, runtimeActiveSessionId, sessions]);

  useEffect(() => {
    if (
      pendingTerminalRestoreIntentRef.current
      && pageState.kind === 'terminal'
      && hasPersistedOpenTabRestoreCandidate()
    ) {
      // Pending terminal restore: the first paint is already the dark
      // terminal shell; keep the persisted intent (do not rewrite ACTIVE_PAGE
      // or clear the pending flag) until the runtime session hydrates.
      return;
    }
    pendingTerminalRestoreIntentRef.current = false;
    try {
      localStorage.setItem(
        STORAGE_KEYS.ACTIVE_PAGE,
        JSON.stringify(resolvePersistedPageStateTruth(pageState, runtimeActiveSessionId)),
      );
    } catch (error) {
      console.error('[App] Failed to persist page state:', error);
    }
  }, [activeSession, pageState, runtimeActiveSessionId]);

  const editingHost = useMemo(() => {
    if (pageState.kind !== 'connection-properties' || !pageState.hostId) {
      return undefined;
    }
    return hosts.find((host) => host.id === pageState.hostId);
  }, [hosts, pageState]);

  const editingDraft = useMemo(() => {
    if (pageState.kind !== 'connection-properties') {
      return undefined;
    }
    return pageState.draft;
  }, [pageState]);

  const handleEdit = useCallback((host: Host) => {
    setPageState(openConnectionPropertiesPage({ hostId: host.id }));
  }, []);

  const handleSaveHost = useCallback((hostData: Omit<Host, 'id' | 'createdAt'>) => {
    if (editingHost) {
      updateHost(editingHost.id, hostData);
    } else {
      addHost(hostData);
    }
    syncSavedHostToServerPreset?.(hostData);
    setPageState(openConnectionsPage());
  }, [addHost, editingHost, syncSavedHostToServerPreset, updateHost]);

  const handleCancelHostForm = useCallback(() => {
    setPageState(openConnectionsPage());
  }, []);

  const handleDelete = useCallback((host: Host) => {
    deleteHost(host.id);
  }, [deleteHost]);

  const handleOpenConnectionsPage = useCallback(() => {
    setPageState(openConnectionsPage());
  }, []);

  const handleOpenSettingsPage = useCallback(() => {
    setPageState(openSettingsPage());
  }, []);

  return {
    pageState,
    setPageState,
    editingHost,
    editingDraft,
    handleEdit,
    handleSaveHost,
    handleCancelHostForm,
    handleDelete,
    handleOpenConnectionsPage,
    handleOpenSettingsPage,
  };
}
