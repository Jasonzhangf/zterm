import type { CSSProperties, ReactNode } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';

export function settingsSectionStyle(): CSSProperties {
  return {
    borderRadius: '28px',
    padding: '24px',
    backgroundColor: '#ffffff',
    boxShadow: mobileTheme.shadow.soft,
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  };
}

export function settingsInputStyle(): CSSProperties {
  return {
    width: '100%',
    minHeight: '56px',
    borderRadius: '20px',
    border: `1px solid ${mobileTheme.colors.lightBorder}`,
    backgroundColor: '#ffffff',
    color: mobileTheme.colors.lightText,
    fontSize: '18px',
    padding: '0 18px',
  };
}

export function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: '24px', fontWeight: 800 }}>{children}</div>;
}
