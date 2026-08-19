import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '../../lib/types';
import {
  applyRemoteWindowTargetCatalog,
  applyRemoteWindowTargetCatalogSnapshot,
  beginRemoteWindowTargetEnumeration,
  failRemoteWindowTargetCatalog,
  upsertRemoteWindowCatalogTarget,
  type RemoteWindowOverlayState,
} from '../../lib/remote-window-overlay-runtime';
import { cloneRemoteWindowCatalogPayload } from './remote-window-overlay-helpers';
import {
  REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS,
  REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS,
  REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS,
} from './remote-window-overlay-constants';

interface RemoteWindowCatalogProjectionSnapshot {
  sessionId: string;
  payload: RemoteWindowStreamTargetsResponsePayload;
  updatedAt: number;
}

export interface UseRemoteWindowCatalogOptions {
  activeSessionId: string | null | undefined;
  state: RemoteWindowOverlayState;
  setState: Dispatch<SetStateAction<RemoteWindowOverlayState>>;
  requestTargets?: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  activeStreamReady: boolean;
  suspendActiveRefresh: boolean;
  onOpenPicker: () => void;
}

export function useRemoteWindowCatalog({
  activeSessionId,
  state,
  setState,
  requestTargets,
  activeStreamReady,
  suspendActiveRefresh,
  onOpenPicker,
}: UseRemoteWindowCatalogOptions) {
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [activeCatalogSyncError, setActiveCatalogSyncError] = useState<string | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const watchdogEpochRef = useRef<number | null>(null);
  const lastCatalogPayloadRef = useRef<RemoteWindowCatalogProjectionSnapshot | null>(null);

  const clearWatchdog = useCallback((requestEpoch?: number) => {
    if (typeof requestEpoch === 'number' && watchdogEpochRef.current !== requestEpoch) {
      return;
    }
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    watchdogEpochRef.current = null;
  }, []);

  const rememberPayload = useCallback((sessionId: string, payload: RemoteWindowStreamTargetsResponsePayload) => {
    const cachedPayload = cloneRemoteWindowCatalogPayload(payload);
    lastCatalogPayloadRef.current = { sessionId, payload: cachedPayload, updatedAt: Date.now() };
    return cachedPayload;
  }, []);

  const rememberTarget = useCallback((sessionId: string, target: RemoteWindowStreamTargetManifest) => {
    const current = lastCatalogPayloadRef.current;
    const basePayload = current && current.sessionId === sessionId
      ? current.payload
      : { requestId: `rw-local-target-${Date.now()}`, targets: [] };
    lastCatalogPayloadRef.current = {
      sessionId,
      payload: upsertRemoteWindowCatalogTarget(basePayload, target),
      updatedAt: Date.now(),
    };
  }, []);

  const applyActivePayload = useCallback((sessionId: string, payload: RemoteWindowStreamTargetsResponsePayload) => {
    const cachedPayload = rememberPayload(sessionId, payload);
    setActiveCatalogSyncError(null);
    setState((current) => applyRemoteWindowTargetCatalogSnapshot(current, cachedPayload));
  }, [rememberPayload, setState]);

  const openPicker = useCallback((options?: { forceRefresh?: boolean }) => {
    clearWatchdog();
    onOpenPicker();
    setActiveCatalogSyncError(null);
    const started = beginRemoteWindowTargetEnumeration(state);
    const targetSessionId = activeSessionId?.trim() || '';
    const cachedSnapshot = lastCatalogPayloadRef.current;
    const canProjectCachedCatalog = Boolean(cachedSnapshot && cachedSnapshot.sessionId === targetSessionId);
    const forceRefresh = options?.forceRefresh === true;
    if (canProjectCachedCatalog && cachedSnapshot) {
      setState(applyRemoteWindowTargetCatalog(
        started.state,
        started.requestEpoch,
        cloneRemoteWindowCatalogPayload(cachedSnapshot.payload),
      ));
    } else {
      setState(started.state);
    }
    if (!targetSessionId || !requestTargets) {
      console.log(`[remote-window-picker] open skipped: targetSessionId=${targetSessionId ? 'ok' : 'EMPTY'} requestTargets=${requestTargets ? 'ok' : 'MISSING'}`);
      setCatalogRefreshing(false);
      setState((current) => failRemoteWindowTargetCatalog(
        current,
        started.requestEpoch,
        new Error('当前没有可用的 daemon session'),
      ));
      return;
    }
    const cacheAgeMs = canProjectCachedCatalog && cachedSnapshot
      ? Date.now() - cachedSnapshot.updatedAt
      : Number.POSITIVE_INFINITY;
    if (
      canProjectCachedCatalog
      && cachedSnapshot
      && !forceRefresh
      && cacheAgeMs >= 0
      && cacheAgeMs < REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS
    ) {
      setCatalogRefreshing(false);
      return;
    }

    setCatalogRefreshing(canProjectCachedCatalog);
    watchdogEpochRef.current = started.requestEpoch;
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      watchdogEpochRef.current = null;
      setCatalogRefreshing(false);
      setState((current) => (
        canProjectCachedCatalog
        && current.phase === 'pickerOpen'
        && current.requestEpoch === started.requestEpoch
          ? { ...current, errorMessage: '远程窗口列表读取超时，请检查 daemon 窗口枚举能力' }
          : failRemoteWindowTargetCatalog(
              current,
              started.requestEpoch,
              new Error('远程窗口列表读取超时，请检查 daemon 窗口枚举能力'),
            )
      ));
    }, REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS);

    const requestPromise = forceRefresh
      ? requestTargets(targetSessionId, { forceRefresh: true })
      : requestTargets(targetSessionId);
    void requestPromise.then((payload) => {
      clearWatchdog(started.requestEpoch);
      setCatalogRefreshing(false);
      setState((current) => applyRemoteWindowTargetCatalog(
        current,
        started.requestEpoch,
        rememberPayload(targetSessionId, payload),
      ));
    }).catch((error) => {
      console.log(`[remote-window-picker] catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
      clearWatchdog(started.requestEpoch);
      setCatalogRefreshing(false);
      setState((current) => (
        canProjectCachedCatalog
        && current.phase === 'pickerOpen'
        && current.requestEpoch === started.requestEpoch
          ? { ...current, errorMessage: error instanceof Error ? error.message : String(error) }
          : failRemoteWindowTargetCatalog(current, started.requestEpoch, error)
      ));
    });
  }, [activeSessionId, clearWatchdog, onOpenPicker, rememberPayload, requestTargets, setState, state]);

  const resetCatalog = useCallback(() => {
    clearWatchdog();
    setActiveCatalogSyncError(null);
    setCatalogRefreshing(false);
  }, [clearWatchdog]);

  useEffect(() => {
    if (!activeStreamReady || suspendActiveRefresh || !activeSessionId || !requestTargets) {
      return;
    }
    const targetSessionId = activeSessionId.trim();
    let disposed = false;
    let inFlight = false;
    const refresh = () => {
      if (disposed || inFlight) {
        return;
      }
      inFlight = true;
      void requestTargets(targetSessionId, { forceRefresh: true }).then((payload) => {
        if (!disposed) {
          applyActivePayload(targetSessionId, payload);
        }
      }).catch((error) => {
        if (!disposed) {
          setActiveCatalogSyncError(error instanceof Error ? error.message : String(error));
          console.warn('[useRemoteWindowCatalog] active remote window catalog sync failed:', error);
        }
      }).finally(() => {
        inFlight = false;
      });
    };
    refresh();
    const intervalId = window.setInterval(refresh, REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [activeSessionId, activeStreamReady, applyActivePayload, requestTargets, suspendActiveRefresh]);

  useEffect(() => () => clearWatchdog(), [clearWatchdog]);

  return {
    activeCatalogSyncError,
    catalogRefreshing,
    openPicker,
    rememberTarget,
    resetCatalog,
  };
}
