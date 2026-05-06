import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  openConnectionPropertiesPage,
  openConnectionsPage,
  openSettingsPage,
  openTerminalPage,
  resolvePersistedPageStateTruth,
  type AppPageState,
} from '../lib/page-state';
import { STORAGE_KEYS, type Host, type Session } from '../lib/types';

function readPersistedPageState(): AppPageState {
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
    if (parsed.kind === 'terminal') {
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

interface UseAppPageStateOptions {
  hosts: Host[];
  sessions: Session[];
  runtimeActiveSessionId: string | null;
  addHost: (host: Omit<Host, 'id' | 'createdAt'>) => Host;
  updateHost: (id: string, updates: Omit<Host, 'id' | 'createdAt'>) => void;
  deleteHost: (id: string) => void;
  ensureTerminalPageVisible: () => void;
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
  } = options;

  const [pageState, setPageState] = useState<AppPageState>(() => readPersistedPageState());
  const restoredRouteHandledRef = useRef(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === runtimeActiveSessionId) || null,
    [runtimeActiveSessionId, sessions],
  );

  useEffect(() => {
    if (restoredRouteHandledRef.current || sessions.length === 0) {
      return;
    }

    restoredRouteHandledRef.current = true;
    const persistedPage = readPersistedPageState();
    if (persistedPage.kind === 'terminal') {
      ensureTerminalPageVisible();
      return;
    }
    setPageState(persistedPage);
  }, [activeSession?.id, ensureTerminalPageVisible, runtimeActiveSessionId, sessions]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.ACTIVE_PAGE,
        JSON.stringify(resolvePersistedPageStateTruth(pageState, runtimeActiveSessionId)),
      );
    } catch (error) {
      console.error('[App] Failed to persist page state:', error);
    }
  }, [pageState, runtimeActiveSessionId]);

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
    setPageState(openConnectionsPage());
  }, [addHost, editingHost, updateHost]);

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
