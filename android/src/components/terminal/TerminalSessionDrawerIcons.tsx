import type { ReactNode } from 'react';

interface DrawerIconProps {
  size?: number;
}

function DrawerIconFrame({ size = 16, children }: DrawerIconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function DrawerCloseIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </DrawerIconFrame>
  );
}

export function DrawerHideIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <path d="m3 3 18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c2.7 0 7.2 3.1 9 7a14 14 0 0 1-2.2 3.5" />
      <path d="M6.7 6.7C5 7.9 3.7 9.5 3 12c1.8 3.9 6.3 7 9 7 1.4 0 3-.6 4.4-1.5" />
    </DrawerIconFrame>
  );
}
