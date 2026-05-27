import * as React from "react";
import { getBrowserStorage } from "../lib/browser-storage";
import { runtimeDebug } from "../lib/runtime-debug";
import { STORAGE_KEYS, type PersistedOpenTab, type SavedTabList } from "../lib/types";
import { normalizeSavedTabList } from "./terminal-page-persisted-tabs";

interface ImportSavedTabListsResult {
  ok: boolean;
  message: string;
}

export interface UseTerminalPageSavedTabRuntimeOptions {
  currentPersistedTabs: PersistedOpenTab[];
  activeSessionId: string | null;
  onLoadSavedTabList: (
    tabs: PersistedOpenTab[],
    activeSessionId?: string,
  ) => void;
}

export interface UseTerminalPageSavedTabRuntimeResult {
  savedTabLists: SavedTabList[];
  saveCurrentTabList: (name: string) => void;
  exportCurrentTabList: () => string;
  exportSavedTabList: (listId: string) => string;
  deleteSavedTabList: (listId: string) => void;
  loadSavedTabList: (listId: string) => void;
  importSavedTabLists: (raw: string) => ImportSavedTabListsResult;
}

export function useTerminalPageSavedTabRuntime(
  options: UseTerminalPageSavedTabRuntimeOptions,
): UseTerminalPageSavedTabRuntimeResult {
  const { currentPersistedTabs, activeSessionId, onLoadSavedTabList } = options;
  const [savedTabLists, setSavedTabLists] = React.useState<SavedTabList[]>([]);

  React.useEffect(() => {
    const storage = getBrowserStorage();
    if (!storage) {
      return;
    }

    try {
      const raw = storage.getItem(STORAGE_KEYS.SAVED_TAB_LISTS);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      setSavedTabLists(
        parsed
          .map(normalizeSavedTabList)
          .filter((item): item is SavedTabList => item !== null),
      );
    } catch (error) {
      console.error("[TerminalPage] Failed to load saved tab lists:", error);
    }
  }, []);

  const persistSavedTabLists = React.useCallback((nextLists: SavedTabList[]) => {
    setSavedTabLists(nextLists);
    const storage = getBrowserStorage();
    if (!storage) {
      return;
    }
    try {
      storage.setItem(STORAGE_KEYS.SAVED_TAB_LISTS, JSON.stringify(nextLists));
    } catch (error) {
      console.error("[TerminalPage] Failed to persist saved tab lists:", error);
    }
  }, []);

  const saveCurrentTabList = React.useCallback((name: string) => {
    const now = Date.now();
    const nextList: SavedTabList = {
      id: `tab-list-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      tabs: currentPersistedTabs,
      activeSessionId: activeSessionId || undefined,
      createdAt: now,
      updatedAt: now,
    };
    const deduped = [
      nextList,
      ...savedTabLists.filter((item) => item.name !== name),
    ];
    persistSavedTabLists(deduped);
  }, [activeSessionId, currentPersistedTabs, persistSavedTabLists, savedTabLists]);

  const exportCurrentTabList = React.useCallback(
    () => JSON.stringify(
      {
        name: `current-${new Date().toISOString()}`,
        tabs: currentPersistedTabs,
        activeSessionId: activeSessionId || undefined,
        exportedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    [activeSessionId, currentPersistedTabs],
  );

  const exportSavedTabList = React.useCallback((listId: string) => {
    const target = savedTabLists.find((item) => item.id === listId);
    return JSON.stringify(target || null, null, 2);
  }, [savedTabLists]);

  const deleteSavedTabList = React.useCallback((listId: string) => {
    persistSavedTabLists(savedTabLists.filter((item) => item.id !== listId));
  }, [persistSavedTabLists, savedTabLists]);

  const loadSavedTabList = React.useCallback((listId: string) => {
    const target = savedTabLists.find((item) => item.id === listId);
    if (!target) {
      return;
    }
    onLoadSavedTabList(target.tabs, target.activeSessionId);
    runtimeDebug("terminal.tab.restore", {
      listId,
      tabCount: target.tabs.length,
      activeSessionId: target.activeSessionId,
    });
  }, [onLoadSavedTabList, savedTabLists]);

  const importSavedTabLists = React.useCallback((raw: string): ImportSavedTabListsResult => {
    try {
      const parsed = JSON.parse(raw);
      const incoming = Array.isArray(parsed)
        ? parsed
            .map(normalizeSavedTabList)
            .filter((item): item is SavedTabList => item !== null)
        : [normalizeSavedTabList(parsed)].filter(
            (item): item is SavedTabList => item !== null,
          );
      if (incoming.length === 0) {
        return { ok: false, message: "没有解析到有效的 tab 列表。" };
      }
      const merged = [...incoming];
      for (const existing of savedTabLists) {
        if (
          !merged.some(
            (item) => item.id === existing.id || item.name === existing.name,
          )
        ) {
          merged.push(existing);
        }
      }
      persistSavedTabLists(merged);
      return { ok: true, message: `已导入 ${incoming.length} 个 tab 列表。` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "导入失败",
      };
    }
  }, [persistSavedTabLists, savedTabLists]);

  return {
    savedTabLists,
    saveCurrentTabList,
    exportCurrentTabList,
    exportSavedTabList,
    deleteSavedTabList,
    loadSavedTabList,
    importSavedTabLists,
  };
}
