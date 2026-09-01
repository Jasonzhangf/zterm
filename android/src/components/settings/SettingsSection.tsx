import type { CSSProperties, ReactNode } from 'react';

export const settingsViewportPadding = 'clamp(16px, 4vw, 40px)';
export const settingsCardPadding = 'clamp(16px, 4vw, 36px)';
export const settingsInputPadding = '0 clamp(12px, 3vw, 22px)';

export function settingsSectionStyle(): CSSProperties {
  return {
    borderRadius: '28px',
    padding: settingsCardPadding,
    backgroundColor: 'var(--zterm-settings-surface, #ffffff)',
    boxShadow: 'var(--zterm-settings-shadow, 0 18px 40px rgba(14, 19, 33, 0.12))',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    width: '100%',
    boxSizing: 'border-box',
    minWidth: 0,
  };
}

export function settingsInputStyle(): CSSProperties {
  return {
    width: '100%',
    minHeight: '56px',
    borderRadius: '20px',
    border: '1px solid var(--zterm-settings-border, #d5dde6)',
    backgroundColor: 'var(--zterm-settings-field, #ffffff)',
    color: 'var(--zterm-settings-text, #171b2d)',
    fontSize: '18px',
    padding: settingsInputPadding,
    boxSizing: 'border-box',
    minWidth: 0,
  };
}

export function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: '24px', fontWeight: 800 }}>{children}</div>;
}
