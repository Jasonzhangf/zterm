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
  REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS,
} from './remote-window-overlay-constants';

interface RemoteWindowCatalogProjectionSnapshot {
  sessionId: string;
  payload: RemoteWindowStreamTargetsResponsePayload;
}

// A transient transport/session failure must not leave the active catalog
// unsynchronized for the whole stream, but the client still must not poll the
// daemon. Retry only after a real failure and stop after this many attempts.
const MAX_ACTIVE_SNAPSHOT_RETRY_COUNT = 2;
const ACTIVE_SNAPSHOT_RETRY_DELAY_MS = 1_000;

export interface UseRemoteWindowCatalogOptions {
  activeSessionId: string | null | undefined;
  state: RemoteWindowOverlayState;
  setState: Dispatch<SetStateAction<RemoteWindowOverlayState>>;
  requestTargets?: (
    sessionId: string,
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
  const lastActiveSnapshotSessionRef = useRef<string | null>(null);
  const activeSnapshotRetrySessionRef = useRef<string | null>(null);
  const activeSnapshotRetryCountRef = useRef(0);
  const [activeSnapshotRetryEpoch, setActiveSnapshotRetryEpoch] = useState(0);

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
    lastCatalogPayloadRef.current = { sessionId, payload: cachedPayload };
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
    };
  }, []);

  // The daemon owns the catalog snapshot and refreshes it on its own cadence.
  // Clients only read that snapshot; they never drive a trusted enumeration.
  const requestFreshTargets = useCallback(async (sessionId: string) => {
    if (!requestTargets) {
      throw new Error('当前连接不支持远程窗口列表刷新');
    }
    return rememberPayload(sessionId, await requestTargets(sessionId));
  }, [rememberPayload, requestTargets]);
  const requestFreshTargetsRef = useRef(requestFreshTargets);
  requestFreshTargetsRef.current = requestFreshTargets;

  const applyActivePayload = useCallback((payload: RemoteWindowStreamTargetsResponsePayload) => {
    setActiveCatalogSyncError(null);
    setState((current) => applyRemoteWindowTargetCatalogSnapshot(current, payload));
  }, [setState]);

  const openPicker = useCallback(() => {
    clearWatchdog();
    onOpenPicker();
    setActiveCatalogSyncError(null);
    const started = beginRemoteWindowTargetEnumeration(state);
    const targetSessionId = activeSessionId?.trim() || '';
    const cachedSnapshot = lastCatalogPayloadRef.current;
    const canProjectCachedCatalog = Boolean(cachedSnapshot && cachedSnapshot.sessionId === targetSessionId);
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

    const requestPromise = requestFreshTargets(targetSessionId);
    void requestPromise.then((payload) => {
      clearWatchdog(started.requestEpoch);
      setCatalogRefreshing(false);
      setState((current) => applyRemoteWindowTargetCatalog(
        current,
        started.requestEpoch,
        payload,
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
  }, [activeSessionId, clearWatchdog, onOpenPicker, rememberPayload, requestFreshTargets, requestTargets, setState, state]);

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
    if (lastActiveSnapshotSessionRef.current === targetSessionId) {
      return;
    }
    if (activeSnapshotRetrySessionRef.current !== targetSessionId) {
      activeSnapshotRetrySessionRef.current = targetSessionId;
      activeSnapshotRetryCountRef.current = 0;
    }
    lastActiveSnapshotSessionRef.current = targetSessionId;
    let disposed = false;
    let retryTimer: number | null = null;
    // The active stream only projects the daemon-owned snapshot once on
    // entry. The daemon owns ongoing refresh, so the client never polls.
    void requestFreshTargetsRef.current(targetSessionId).then((payload) => {
      if (!disposed) {
        activeSnapshotRetryCountRef.current = 0;
        applyActivePayload(payload);
      }
    }).catch((error) => {
      if (disposed) {
        return;
      }
      setActiveCatalogSyncError(error instanceof Error ? error.message : String(error));
      console.warn('[useRemoteWindowCatalog] active remote window catalog snapshot read failed:', error);
      if (activeSnapshotRetryCountRef.current >= MAX_ACTIVE_SNAPSHOT_RETRY_COUNT) {
        return;
      }
      activeSnapshotRetryCountRef.current += 1;
      retryTimer = window.setTimeout(() => {
        lastActiveSnapshotSessionRef.current = null;
        setActiveSnapshotRetryEpoch((current) => current + 1);
      }, ACTIVE_SNAPSHOT_RETRY_DELAY_MS);
    });
    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [activeSessionId, activeStreamReady, activeSnapshotRetryEpoch, applyActivePayload, requestTargets, suspendActiveRefresh]);

  useEffect(() => {
    if (!activeStreamReady || !activeSessionId) {
      lastActiveSnapshotSessionRef.current = null;
      activeSnapshotRetryCountRef.current = 0;
    }
  }, [activeSessionId, activeStreamReady]);

  useEffect(() => () => clearWatchdog(), [clearWatchdog]);

  return {
    activeCatalogSyncError,
    catalogRefreshing,
    openPicker,
    requestFreshTargets,
    rememberTarget,
    resetCatalog,
  };
}
