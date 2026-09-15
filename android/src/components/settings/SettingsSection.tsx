import type { CSSProperties, ReactNode } from 'react';

export const settingsViewportPadding = 'clamp(12px, 2.8vw, 24px)';
export const settingsCardPadding = 'clamp(12px, 3vw, 22px)';
export const settingsInputPadding = '0 clamp(10px, 2.4vw, 16px)';

export function settingsSectionStyle(): CSSProperties {
  return {
    borderRadius: '18px',
    padding: settingsCardPadding,
    backgroundColor: 'var(--zterm-settings-surface, #ffffff)',
    boxShadow: 'var(--zterm-settings-shadow, 0 18px 40px rgba(14, 19, 33, 0.12))',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    width: '100%',
    boxSizing: 'border-box',
    minWidth: 0,
  };
}

export function settingsInputStyle(): CSSProperties {
  return {
    width: '100%',
    minHeight: '44px',
    borderRadius: '12px',
    border: '1px solid var(--zterm-settings-border, #d5dde6)',
    backgroundColor: 'var(--zterm-settings-field, #ffffff)',
    color: 'var(--zterm-settings-text)',
    fontSize: '15px',
    padding: settingsInputPadding,
    boxSizing: 'border-box',
    minWidth: 0,
  };
}

export function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: '20px', fontWeight: 800 }}>{children}</div>;
}
