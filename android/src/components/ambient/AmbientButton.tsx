import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent,
} from 'react';

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
  border: '1px solid var(--zterm-skeu-edge-dark)',
  backgroundColor: 'var(--zterm-skeu-material)',
  color: 'var(--zterm-skeu-text)',
  textShadow: 'var(--zterm-skeu-text-shadow, none)',
  boxShadow: [
    'inset 1px 1px 0 var(--zterm-skeu-edge-light)',
    'inset -1px -1px 0 color-mix(in srgb, var(--zterm-skeu-edge-dark) 58%, transparent)',
    '0 4px 10px var(--zterm-skeu-shadow-soft)',
  ].join(', '),
  transition:
    'box-shadow 160ms cubic-bezier(0.2, 0, 0, 1), background-color 160ms cubic-bezier(0.2, 0, 0, 1), color 160ms cubic-bezier(0.2, 0, 0, 1), transform 160ms cubic-bezier(0.2, 0, 0, 1)',
};

const accentButtonStyle: CSSProperties = {
  border: '1px solid var(--zterm-settings-accent-border)',
  backgroundColor: 'var(--zterm-skeu-material)',
  color: 'var(--zterm-settings-accent)',
  boxShadow: [
    'inset 1px 1px 0 var(--zterm-skeu-edge-light)',
    'inset -1px -1px 0 var(--zterm-skeu-edge-light)',
    '0 4px 10px var(--zterm-skeu-shadow-soft)',
  ].join(', '),
};

function hasFlatMaterial(variant: AmbientButtonVariant, style: CSSProperties | undefined) {
  return (
    variant === 'saved-open'
    || style?.background === 'transparent'
    || style?.background === 'none'
    || style?.backgroundColor === 'transparent'
    || style?.backgroundColor === 'none'
  );
}

function resolveVariantStyle(
  variant: AmbientButtonVariant,
  selected: boolean,
): CSSProperties {
  switch (variant) {
    case 'settings':
      return {
        minWidth: '44px',
        height: '40px',
        padding: '0 10px',
        borderRadius: '12px',
        fontSize: '14px',
        fontWeight: 900,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      };
    case 'settings-back':
      return {
        width: '44px',
        height: '44px',
        borderRadius: '14px',
        fontSize: '22px',
        cursor: 'pointer',
      };
    case 'settings-save':
      return {
        ...accentButtonStyle,
        minWidth: 'clamp(84px, 18vw, 96px)',
        height: '44px',
        borderRadius: '14px',
        fontWeight: 800,
        fontSize: '14px',
        padding: '0 14px',
        cursor: 'pointer',
      };
    case 'settings-segment':
      return {
        flex: 1,
        minHeight: '40px',
        borderRadius: '12px',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        fontWeight: 800,
        cursor: 'pointer',
      };
    case 'settings-toggle':
      return {
        minHeight: '40px',
        width: '100%',
        borderRadius: '12px',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        fontWeight: 800,
        fontSize: '15px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      };
    case 'settings-skin-option':
      return {
        minHeight: '64px',
        borderRadius: '14px',
        border: selected
          ? '1px solid var(--zterm-settings-accent-border)'
          : '1px solid var(--zterm-skeu-edge-dark)',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '10px 12px',
      };
    case 'terminal-pane-menu':
      return {
        minHeight: '34px',
        borderRadius: '10px',
        border: `1px solid ${
          selected ? 'var(--zterm-settings-accent-border)' : 'var(--zterm-skeu-edge-dark)'
        }`,
        backgroundColor: selected
          ? 'var(--zterm-skeu-material-active)'
          : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
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
        ...accentButtonStyle,
        width: '40px',
        height: '40px',
        borderRadius: '12px',
        lineHeight: 1,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      };
    case 'accent-wide':
      return {
        ...accentButtonStyle,
        marginTop: '6px',
        minHeight: '40px',
        padding: '0 14px',
        borderRadius: '12px',
        fontSize: '14px',
        fontWeight: 800,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
      };
    case 'active-session':
      return {
        width: '100%',
        minHeight: '68px',
        padding: '10px 12px',
        border: `1px solid ${
          selected ? 'var(--zterm-settings-accent-border)' : 'var(--zterm-skeu-edge-dark)'
        }`,
        borderRadius: '16px',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: '12px',
        textAlign: 'left',
        minWidth: 0,
      };
    case 'saved-open':
      return {
        width: '100%',
        minHeight: '72px',
        padding: '10px 12px',
        border: '1px solid transparent',
        backgroundColor: 'transparent',
        color: 'inherit',
        boxShadow: 'none',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: '12px',
        textAlign: 'left',
        minWidth: 0,
      };
    case 'back':
      return {
        width: '44px',
        height: '44px',
        borderRadius: '14px',
        fontSize: '22px',
        cursor: 'pointer',
      };
    case 'save':
      return {
        ...accentButtonStyle,
        minWidth: '84px',
        height: '44px',
        borderRadius: '14px',
        fontWeight: 800,
        fontSize: '14px',
        padding: '0 14px',
        cursor: 'pointer',
      };
    case 'compact-accent':
      return {
        ...accentButtonStyle,
        borderRadius: '12px',
        minHeight: '38px',
        padding: '0 12px',
        fontWeight: 900,
        fontSize: '14px',
        cursor: 'pointer',
      };
    case 'compact-accent-shadow':
      return {
        ...accentButtonStyle,
        borderRadius: '12px',
        minHeight: '38px',
        padding: '0 14px',
        fontWeight: 800,
        fontSize: '14px',
        cursor: 'pointer',
      };
    case 'option':
      return {
        borderRadius: '12px',
        padding: '10px 12px',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        cursor: 'pointer',
        textAlign: 'left',
      };
    case 'option-strong':
      return {
        borderRadius: '12px',
        padding: '10px 12px',
        backgroundColor: selected ? 'var(--zterm-skeu-material-active)' : 'var(--zterm-skeu-material)',
        color: selected ? 'var(--zterm-settings-accent)' : 'var(--zterm-skeu-text)',
        cursor: 'pointer',
        fontWeight: 700,
      };
    case 'discover':
      return {
        ...accentButtonStyle,
        minWidth: '120px',
        minHeight: '38px',
        borderRadius: '12px',
        fontWeight: 800,
        cursor: 'pointer',
      };
    case 'outline':
      return {
        minHeight: '38px',
        borderRadius: '12px',
        border: '1px solid var(--zterm-skeu-edge-dark)',
        backgroundColor: 'var(--zterm-skeu-material)',
        color: 'var(--zterm-skeu-text)',
        fontWeight: 800,
        padding: '0 14px',
        cursor: 'pointer',
      };
  }
}

export const AmbientButton = forwardRef<HTMLButtonElement, AmbientButtonProps>(
  function AmbientButton(
    {
      variant = 'settings',
      selected = false,
      style,
      type = 'button',
      disabled,
      className,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      ...props
    },
    ref,
  ) {
    const ambientClass = ['ambient', 'ambient-control', 'amb-button', 'ambx-control', 'amb-chamfer', className].filter(Boolean).join(' ');
    const flatMaterial = hasFlatMaterial(variant, style);
    const [pressed, setPressed] = useState(false);
    // An explicit caller geometry is authoritative: variant minimums must not
    // inflate a checkbox, close button or icon button that asked for an exact size.
    const geometryOverride: CSSProperties = {};
    if (style?.width !== undefined && style?.minWidth === undefined) {
      geometryOverride.minWidth = 0;
    }
    if (style?.height !== undefined && style?.minHeight === undefined) {
      geometryOverride.minHeight = 0;
    }
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        data-selected={selected ? 'true' : undefined}
        data-amb-flat={flatMaterial ? 'true' : undefined}
        data-amb-pressed={pressed && !flatMaterial ? 'true' : undefined}
        className={ambientClass}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          if (!disabled && !flatMaterial) setPressed(true);
          if (!disabled && !flatMaterial) event.currentTarget.setPointerCapture?.(event.pointerId);
          onPointerDown?.(event);
        }}
        onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
          setPressed(false);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }
          onPointerUp?.(event);
        }}
        onPointerCancel={(event: PointerEvent<HTMLButtonElement>) => {
          setPressed(false);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }
          onPointerCancel?.(event);
        }}
        onLostPointerCapture={() => setPressed(false)}
        style={{
          ...commonButtonStyle,
          ...resolveVariantStyle(variant, selected),
          ...geometryOverride,
          ...(variant === 'settings-save' && disabled ? { opacity: 0.72 } : null),
          ...style,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
        {...props}
      />
    );
  },
);
