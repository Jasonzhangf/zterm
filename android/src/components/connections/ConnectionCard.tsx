import { mobileTheme } from '../../lib/mobile-ui';
import type { ServerColorTone } from '../../lib/server-color';

interface ConnectionCardProps {
  title: string;
  subtitle: string;
  preview?: string;
  accentLabel?: string;
  icon?: string;
  actionLabel?: string;
  secondaryLabel?: string;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  onTertiaryAction?: () => void;
  tertiaryLabel?: string;
  onLongPress?: () => void;
  tone?: ServerColorTone;
}

export function ConnectionCard({
  title,
  subtitle,
  preview,
  accentLabel,
  icon = '⌘',
  actionLabel = 'Open',
  secondaryLabel,
  tertiaryLabel,
  onPrimaryAction,
  onSecondaryAction,
  onTertiaryAction,
  onLongPress,
  tone,
}: ConnectionCardProps) {
  const hasPreview = Boolean(preview?.trim());
  let longPressTimer: number | null = null;

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const startLongPress = () => {
    if (!onLongPress) {
      return;
    }
    clearLongPress();
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      onLongPress();
    }, 380);
  };

  return (
    <div
      onContextMenu={(event) => {
        if (!onLongPress) {
          return;
        }
        event.preventDefault();
        onLongPress();
      }}
      onTouchStart={startLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
      onMouseDown={startLongPress}
      onMouseUp={clearLongPress}
      onMouseLeave={clearLongPress}
      style={{
        borderRadius: '20px',
        backgroundColor: mobileTheme.colors.shell,
        color: mobileTheme.colors.textPrimary,
        overflow: 'hidden',
        boxShadow: mobileTheme.shadow.strong,
        border: tone ? `1px solid ${tone.lightCardBorder}` : '1px solid transparent',
      }}
    >
      {hasPreview && (
        <div
          style={{
            minHeight: '44px',
            maxHeight: '56px',
            padding: '10px 12px 8px',
            fontSize: '12px',
            lineHeight: 1.35,
            color: tone?.previewText || mobileTheme.colors.accent,
            display: 'flex',
            alignItems: 'flex-start',
            background: tone?.previewBackground || mobileTheme.colors.canvas,
            whiteSpace: 'pre-wrap',
            overflow: 'hidden',
          }}
        >
          {preview}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: hasPreview ? '0 12px 12px' : '10px 12px',
        }}
      >
        <div
          style={{
            width: '42px',
            height: '42px',
            borderRadius: '14px',
            backgroundColor: tone?.accentMuted || mobileTheme.colors.shellMuted,
            display: 'grid',
            placeItems: 'center',
            color: tone?.accent || mobileTheme.colors.accent,
            fontSize: '20px',
            flexShrink: 0,
          }}
        >
          {icon}
        </div>

        <button
          onClick={onPrimaryAction}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: '4px',
            padding: 0,
            textAlign: 'left',
            cursor: onPrimaryAction ? 'pointer' : 'default',
          }}
        >
          <div style={{ fontSize: '16px', fontWeight: 700, lineHeight: 1.05 }}>{title}</div>
          <div style={{ fontSize: '13px', color: mobileTheme.colors.accent }}>{subtitle}</div>
          {accentLabel && (
            <div
              style={{
                marginTop: '4px',
                borderRadius: '999px',
                padding: '3px 9px',
                backgroundColor: tone?.accentSoft || mobileTheme.colors.accentSoft,
                color: tone?.accent || mobileTheme.colors.accent,
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              {accentLabel}
            </div>
          )}
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={onPrimaryAction}
            style={{
              minWidth: '54px',
              height: '38px',
              border: 'none',
              borderRadius: '12px',
              backgroundColor: tone?.accentSoft || mobileTheme.colors.accentSoft,
              color: tone?.accent || mobileTheme.colors.accent,
              padding: '0 12px',
              fontWeight: 700,
              fontSize: '12px',
              cursor: onPrimaryAction ? 'pointer' : 'default',
            }}
          >
            {actionLabel}
          </button>
          {(secondaryLabel || tertiaryLabel) && (
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              {secondaryLabel && (
                <button
                  onClick={onSecondaryAction}
                  style={{
                    width: '38px',
                    height: '38px',
                    border: 'none',
                    borderRadius: '12px',
                    backgroundColor: mobileTheme.colors.shellMuted,
                    color: '#c5cee0',
                    fontSize: '10px',
                    cursor: onSecondaryAction ? 'pointer' : 'default',
                  }}
                >
                  {secondaryLabel}
                </button>
              )}
              {tertiaryLabel && (
                <button
                  onClick={onTertiaryAction}
                  style={{
                    width: '38px',
                    height: '38px',
                    border: 'none',
                    borderRadius: '12px',
                    backgroundColor: 'rgba(255,124,146,0.16)',
                    color: mobileTheme.colors.danger,
                    fontSize: '10px',
                    cursor: onTertiaryAction ? 'pointer' : 'default',
                  }}
                >
                  {tertiaryLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
