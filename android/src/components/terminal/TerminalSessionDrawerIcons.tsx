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

export function DrawerChevronIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <path d="m9 6 6 6-6 6" />
    </DrawerIconFrame>
  );
}

export function DrawerFolderIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </DrawerIconFrame>
  );
}

export function DrawerMoreIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </DrawerIconFrame>
  );
}

export function DrawerRestoreIcon({ size }: DrawerIconProps) {
  return (
    <DrawerIconFrame size={size}>
      <path d="M4 9a8 8 0 1 1 2 8" />
      <path d="M4 4v5h5" />
    </DrawerIconFrame>
  );
}
