import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';

export type AmbientButtonVariant =
  | 'settings'
  | 'settings-back'
  | 'settings-save'
  | 'settings-segment'
  | 'settings-toggle'
  | 'settings-skin-option'
  | 'terminal-pane-menu'
  | 'terminal-route-badge'
  | 'accent'
  | 'accent-wide'
  | 'active-session'
  | 'saved-open'
  | 'back'
  | 'save'
  | 'compact-accent'
  | 'compact-accent-shadow'
  | 'option'
  | 'option-strong'
  | 'discover'
  | 'outline';

export interface AmbientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AmbientButtonVariant;
  selected?: boolean;
}

const commonButtonStyle: CSSProperties = {
  cursor: 'pointer',
};

function resolveVariantStyle(
  variant: AmbientButtonVariant,
  selected: boolean,
): CSSProperties {
  switch (variant) {
    case 'settings':
      return {
        minWidth: '78px',
        height: '48px',
        padding: '0 12px',
        borderRadius: '16px',
        border: `1px solid ${mobileTheme.colors.lightBorder}`,
        backgroundColor: 'var(--zterm-settings-surface)',
        color: mobileTheme.colors.lightText,
        fontSize: '14px',
        fontWeight: 900,
        boxShadow: mobileTheme.shadow.soft,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      };
    case 'settings-back':
      return {
        width: '56px',
        height: '56px',
        borderRadius: '20px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-surface)',
        color: 'var(--zterm-settings-text)',
        fontSize: '26px',
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
      };
    case 'settings-save':
      return {
        minWidth: 'clamp(84px, 22vw, 112px)',
        height: '56px',
        borderRadius: '20px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontWeight: 800,
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
      };
    case 'settings-segment':
      return {
        flex: 1,
        minHeight: '48px',
        borderRadius: '16px',
        border: 'none',
        backgroundColor: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-field)',
        color: selected ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
        fontWeight: 800,
        cursor: 'pointer',
      };
    case 'settings-toggle':
      return {
        minHeight: '48px',
        width: '100%',
        borderRadius: '16px',
        border: 'none',
        backgroundColor: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-field)',
        color: selected ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
        fontWeight: 800,
        fontSize: '16px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      };
    case 'settings-skin-option':
      return {
        minHeight: '76px',
        borderRadius: '18px',
        border: selected
          ? '2px solid var(--zterm-settings-accent)'
          : '1px solid var(--zterm-settings-border)',
        backgroundColor: selected ? 'var(--zterm-settings-surface)' : 'var(--zterm-settings-field)',
        color: 'var(--zterm-settings-text)',
        boxShadow: selected ? '0 12px 26px rgba(31,214,122,0.14)' : 'none',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '12px',
      };
    case 'terminal-pane-menu':
      return {
        minHeight: '34px',
        borderRadius: '10px',
        border: `1px solid ${
          selected ? 'rgba(113, 164, 255, 0.28)' : 'rgba(255,255,255,0.08)'
        }`,
        backgroundColor: selected ? 'rgba(113, 164, 255, 0.16)' : 'rgba(31, 38, 53, 0.82)',
        color: selected ? '#8db7ff' : '#fff',
        fontSize: '12px',
        fontWeight: 700,
        textAlign: 'left',
        padding: '0 12px',
      };
    case 'terminal-route-badge':
      return {
        position: 'absolute',
        right: '32px',
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 2,
        minHeight: '18px',
        padding: '2px 6px',
        borderRadius: '999px',
        fontSize: '9px',
        fontWeight: 900,
        lineHeight: 1.2,
        cursor: 'pointer',
      };
    case 'accent':
      return {
        width: '44px',
        height: '44px',
        borderRadius: '14px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        lineHeight: 1,
        boxShadow: mobileTheme.shadow.soft,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      };
    case 'accent-wide':
      return {
        marginTop: '6px',
        minHeight: '44px',
        padding: '0 18px',
        borderRadius: '16px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontSize: '14px',
        fontWeight: 800,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
      };
    case 'active-session':
      return {
        width: '100%',
        minHeight: '76px',
        padding: '12px',
        border: `1px solid ${
          selected ? 'rgba(8, 122, 70, 0.34)' : mobileTheme.colors.lightBorder
        }`,
        borderRadius: '20px',
        backgroundColor: 'var(--zterm-settings-surface)',
        color: mobileTheme.colors.lightText,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: '12px',
        textAlign: 'left',
        boxShadow: mobileTheme.shadow.soft,
      };
    case 'saved-open':
      return {
        width: '100%',
        minHeight: '82px',
        padding: '13px 12px',
        border: 'none',
        backgroundColor: 'transparent',
        color: 'inherit',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: '12px',
        textAlign: 'left',
        minWidth: 0,
      };
    case 'back':
      return {
        width: '56px',
        height: '56px',
        borderRadius: '20px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-surface)',
        color: 'var(--zterm-settings-text)',
        fontSize: '26px',
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
      };
    case 'save':
      return {
        minWidth: '92px',
        height: '56px',
        borderRadius: '20px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontWeight: 800,
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
      };
    case 'compact-accent':
      return {
        border: 'none',
        borderRadius: '16px',
        minHeight: '42px',
        padding: '0 14px',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontWeight: 900,
        cursor: 'pointer',
      };
    case 'compact-accent-shadow':
      return {
        border: 'none',
        borderRadius: '14px',
        minHeight: '42px',
        padding: '0 16px',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontWeight: 800,
        cursor: 'pointer',
        boxShadow: mobileTheme.shadow.soft,
      };
    case 'option':
      return {
        border: 'none',
        borderRadius: '16px',
        padding: '12px 14px',
        backgroundColor: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-field)',
        color: selected ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
        textAlign: 'left',
      };
    case 'option-strong':
      return {
        border: 'none',
        borderRadius: '16px',
        padding: '12px 14px',
        backgroundColor: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-field)',
        color: selected ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
        boxShadow: mobileTheme.shadow.soft,
        cursor: 'pointer',
        fontWeight: 700,
      };
    case 'discover':
      return {
        minWidth: '132px',
        minHeight: '42px',
        borderRadius: '14px',
        border: 'none',
        backgroundColor: 'var(--zterm-settings-accent)',
        color: 'var(--zterm-settings-accent-text)',
        fontWeight: 800,
        cursor: 'pointer',
        boxShadow: mobileTheme.shadow.soft,
      };
    case 'outline':
      return {
        minHeight: '42px',
        borderRadius: '14px',
        border: '1px solid var(--zterm-settings-border)',
        backgroundColor: 'var(--zterm-settings-field)',
        color: 'var(--zterm-settings-text)',
        fontWeight: 800,
        padding: '0 16px',
        cursor: 'pointer',
      };
  }
}

export const AmbientButton = forwardRef<HTMLButtonElement, AmbientButtonProps>(
  function AmbientButton(
    { variant = 'settings', selected = false, style, type = 'button', disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        style={{
          ...commonButtonStyle,
          ...resolveVariantStyle(variant, selected),
          ...(variant === 'settings-save' && disabled ? { opacity: 0.72 } : null),
          ...style,
        }}
        {...props}
      />
    );
  },
);
