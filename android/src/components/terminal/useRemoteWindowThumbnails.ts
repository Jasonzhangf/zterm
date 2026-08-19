import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import type { RemoteWindowAppTargetGroup } from './remote-window-overlay-helpers';
import {
  REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK,
  REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS,
} from './remote-window-overlay-constants';

export interface RemoteWindowScreenshotSaveResult {
  fileName: string;
  savedPath: string;
  dataUrl?: string;
}

export type RemoteWindowThumbnailStatus =
  | { phase: 'loading'; requestId: string; sessionId: string; targetId: string; updatedAt: number }
  | { phase: 'ready'; dataUrl: string; fileName: string; updatedAt: number }
  | { phase: 'failed'; message: string; updatedAt: number };

interface RemoteWindowThumbnailRequestToken {
  requestId: string;
  sessionId: string;
  targetId: string;
  startedAt: number;
}

export function useRemoteWindowThumbnails(options: {
  activeSessionId: string | null | undefined;
  activeTargetId: string | null;
  lockedAppWindowGroup: RemoteWindowAppTargetGroup | null;
  requestScreenshot?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    options?: { persist?: boolean },
  ) => Promise<RemoteWindowScreenshotSaveResult>;
}) {
  const [windowThumbnails, setWindowThumbnailsState] = useState<Record<string, RemoteWindowThumbnailStatus>>({});
  const windowThumbnailsRef = useRef(windowThumbnails);
  const inFlightTargetIdsRef = useRef<Map<string, RemoteWindowThumbnailRequestToken>>(new Map());

  const setWindowThumbnails = useCallback((
    next: Record<string, RemoteWindowThumbnailStatus>
      | ((current: Record<string, RemoteWindowThumbnailStatus>) => Record<string, RemoteWindowThumbnailStatus>),
  ) => {
    setWindowThumbnailsState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      windowThumbnailsRef.current = resolved;
      return resolved;
    });
  }, []);

  useEffect(() => {
    const { activeSessionId, activeTargetId, lockedAppWindowGroup, requestScreenshot } = options;
    if (!lockedAppWindowGroup || !activeSessionId || !activeTargetId || !requestScreenshot) {
      return;
    }
    const groupTargetIds = new Set(lockedAppWindowGroup.targets.map((target) => target.streamTargetId));
    const siblingTargets = lockedAppWindowGroup.targets
      .filter((target) => target.streamTargetId !== activeTargetId);

    const refreshThumbnails = () => {
      const now = Date.now();
      const currentSnapshots = windowThumbnailsRef.current;
      if (inFlightTargetIdsRef.current.size > 0) {
        return;
      }
      const targetsToLoad = siblingTargets
        .map((target) => {
          const snapshot = currentSnapshots[target.streamTargetId];
          if (!snapshot) {
            return { target, priority: 0 };
          }
          if (snapshot.phase === 'loading' || snapshot.phase === 'failed') {
            return null;
          }
          return now - snapshot.updatedAt >= REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS
            ? { target, priority: 1 }
            : null;
        })
        .filter((entry): entry is { target: RemoteWindowStreamTargetManifest; priority: number } => Boolean(entry))
        .sort((left, right) => left.priority - right.priority)
        .slice(0, REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK)
        .map((entry) => entry.target);
      const requests = targetsToLoad.map((target) => ({
        target,
        token: {
          requestId: `rw-thumb-${now}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: activeSessionId,
          targetId: target.streamTargetId,
          startedAt: now,
        } satisfies RemoteWindowThumbnailRequestToken,
      }));

      setWindowThumbnails((current) => {
        let changed = false;
        const next: Record<string, RemoteWindowThumbnailStatus> = {};
        for (const [targetId, snapshot] of Object.entries(current)) {
          if (groupTargetIds.has(targetId)) {
            next[targetId] = snapshot;
          } else {
            changed = true;
          }
        }
        for (const { target, token } of requests) {
          next[target.streamTargetId] = {
            phase: 'loading',
            requestId: token.requestId,
            sessionId: token.sessionId,
            targetId: token.targetId,
            updatedAt: token.startedAt,
          };
          changed = true;
        }
        return changed ? next : current;
      });

      for (const { target, token } of requests) {
        inFlightTargetIdsRef.current.set(target.streamTargetId, token);
        void requestScreenshot(activeSessionId, target, { persist: false })
          .then((result) => {
            if (inFlightTargetIdsRef.current.get(target.streamTargetId)?.requestId === token.requestId) {
              inFlightTargetIdsRef.current.delete(target.streamTargetId);
            }
            setWindowThumbnails((current) => {
              const snapshot = current[target.streamTargetId];
              if (
                snapshot?.phase !== 'loading'
                || snapshot.requestId !== token.requestId
                || snapshot.sessionId !== token.sessionId
                || snapshot.targetId !== token.targetId
              ) {
                return current;
              }
              return {
                ...current,
                [target.streamTargetId]: result.dataUrl
                  ? { phase: 'ready', dataUrl: result.dataUrl, fileName: result.fileName, updatedAt: Date.now() }
                  : { phase: 'failed', message: 'remote window thumbnail did not return image data', updatedAt: Date.now() },
              };
            });
          })
          .catch((error) => {
            if (inFlightTargetIdsRef.current.get(target.streamTargetId)?.requestId === token.requestId) {
              inFlightTargetIdsRef.current.delete(target.streamTargetId);
            }
            setWindowThumbnails((current) => {
              const snapshot = current[target.streamTargetId];
              if (
                snapshot?.phase !== 'loading'
                || snapshot.requestId !== token.requestId
                || snapshot.sessionId !== token.sessionId
                || snapshot.targetId !== token.targetId
              ) {
                return current;
              }
              return {
                ...current,
                [target.streamTargetId]: {
                  phase: 'failed',
                  message: error instanceof Error ? error.message : String(error),
                  updatedAt: Date.now(),
                },
              };
            });
          });
      }
    };

    refreshThumbnails();
    const intervalId = window.setInterval(refreshThumbnails, REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [options.activeSessionId, options.activeTargetId, options.lockedAppWindowGroup, options.requestScreenshot, setWindowThumbnails]);

  useEffect(() => {
    if (options.lockedAppWindowGroup) {
      return;
    }
    inFlightTargetIdsRef.current.clear();
    setWindowThumbnails((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [options.lockedAppWindowGroup, setWindowThumbnails]);

  const resetWindowThumbnails = useCallback(() => {
    inFlightTargetIdsRef.current.clear();
    setWindowThumbnails({});
  }, [setWindowThumbnails]);

  return { windowThumbnails, resetWindowThumbnails };
}
