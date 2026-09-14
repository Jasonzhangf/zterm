import { useLayoutEffect, useRef } from 'react';

export const useRemoteWindowLockedPortal = (embedded: boolean, active: boolean, fullscreen: boolean, onRelocated?: () => void) => {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lastParentRef = useRef<HTMLElement | null>(null);
  const onRelocatedRef = useRef(onRelocated);
  onRelocatedRef.current = onRelocated;
  if (embedded && typeof document !== 'undefined' && !hostRef.current) {
    const host = document.createElement('div');
    host.dataset.testid = 'remote-window-locked-portal-host';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.minHeight = '0';
    hostRef.current = host;
  }
  useLayoutEffect(() => {
    if (!embedded || typeof document === 'undefined') return;
    const host = hostRef.current;
    const parent = fullscreen ? document.body : anchorRef.current;
    if (!host || !parent) return;
    const relocated = lastParentRef.current !== null && lastParentRef.current !== parent;
    parent.appendChild(host);
    lastParentRef.current = parent;
    if (relocated) onRelocatedRef.current?.();
    return () => {
      if (host.parentNode === parent) parent.removeChild(host);
    };
  }, [active, embedded, fullscreen]);
  return [anchorRef, hostRef.current] as const;
};
