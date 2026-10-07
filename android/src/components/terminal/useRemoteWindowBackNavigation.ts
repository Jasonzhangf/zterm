import { useCallback, useEffect, type RefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';

export interface UseRemoteWindowBackNavigationOptions {
  active: boolean;
  lockedToolbarRef: RefObject<HTMLDivElement | null>;
  streamStatusOpen: boolean;
  appSwitchOpen: boolean;
  fullscreen: boolean;
  closeStreamStatus: () => void;
  closeAppSwitch: () => void;
  shrinkFullscreen: () => void;
  exitLocalStream: () => void;
}

function focusLockedToolbarControl(
  lockedToolbarRef: RefObject<HTMLDivElement | null>,
  testId: string,
) {
  const node = lockedToolbarRef.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  node?.focus?.();
}

export function useRemoteWindowBackNavigation({
  active,
  lockedToolbarRef,
  streamStatusOpen,
  appSwitchOpen,
  fullscreen,
  closeStreamStatus,
  closeAppSwitch,
  shrinkFullscreen,
  exitLocalStream,
}: UseRemoteWindowBackNavigationOptions): () => boolean {
  const handleBack = useCallback((): boolean => {
    if (streamStatusOpen) {
      closeStreamStatus();
      focusLockedToolbarControl(lockedToolbarRef, 'remote-window-more-toggle');
      return true;
    }
    if (appSwitchOpen) {
      closeAppSwitch();
      focusLockedToolbarControl(lockedToolbarRef, 'remote-window-active-app-switch-button');
      return true;
    }
    if (fullscreen) {
      shrinkFullscreen();
      return true;
    }
    exitLocalStream();
    return true;
  }, [
    appSwitchOpen,
    closeAppSwitch,
    closeStreamStatus,
    exitLocalStream,
    fullscreen,
    lockedToolbarRef,
    shrinkFullscreen,
    streamStatusOpen,
  ]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (handleBack()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, handleBack]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let disposed = false;
    let listenerHandle: { remove: () => Promise<void> | void } | null = null;
    void Promise.resolve(CapacitorApp.addListener('backButton', handleBack))
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        listenerHandle = handle;
      })
      .catch((error) => {
        if (!disposed) {
          console.error('[RemoteWindowOverlay] backButton listener failed:', error);
        }
      });
    return () => {
      disposed = true;
      if (listenerHandle) {
        void listenerHandle.remove();
      }
    };
  }, [active, handleBack]);

  return handleBack;
}
