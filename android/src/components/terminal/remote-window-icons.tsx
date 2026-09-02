import type { CSSProperties } from 'react';

const iconStyle: CSSProperties = {
  width: 20,
  height: 20,
  display: 'block',
  pointerEvents: 'none',
};

export type RemoteWindowIconName =
  | 'minimize'
  | 'fullscreen'
  | 'close'
  | 'close-window'
  | 'screenshot'
  | 'keyboard'
  | 'more';

export function RemoteWindowIcon({ name }: { name: RemoteWindowIconName }) {
  const path = name === 'minimize'
    ? <path d="M5 12h14" />
    : name === 'fullscreen'
      ? <path d="M8 4H4v4m12-4h4v4M8 20H4v-4m12 4h4v-4" />
      : name === 'close'
        ? <path d="m6 6 12 12M18 6 6 18" />
        : name === 'close-window'
          ? <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="m9 10 6 6m0-6-6 6" /></>
        : name === 'screenshot'
          ? <><path d="M4 8h3l2-3h6l2 3h3v11H4Z" /><circle cx="12" cy="13" r="3" /></>
          : name === 'keyboard'
            ? <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M6 10h1m3 0h1m3 0h1m3 0h1M6 14h8m2 0h3" /></>
            : <><circle cx="6" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="18" cy="12" r="1" fill="currentColor" /></>;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={iconStyle}>
      {path}
    </svg>
  );
}
