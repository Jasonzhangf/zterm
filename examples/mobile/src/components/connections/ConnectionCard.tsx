import { mobileTheme } from '../../lib/mobile-ui';

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
}: ConnectionCardProps) {
  const hasPreview = Boolean(preview?.trim());

  return (
    <div
      style={{
        borderRadius: '20px',
        backgroundColor: mobileTheme.colors.shell,
        color: mobileTheme.colors.textPrimary,
        overflow: 'hidden',
        boxShadow: mobileTheme.shadow.strong,
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
            color: mobileTheme.colors.accent,
            display: 'flex',
            alignItems: 'flex-start',
            background: mobileTheme.colors.canvas,
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
            backgroundColor: mobileTheme.colors.shellMuted,
            display: 'grid',
            placeItems: 'center',
            color: mobileTheme.colors.accent,
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
                backgroundColor: mobileTheme.colors.accentSoft,
                color: mobileTheme.colors.accent,
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
              backgroundColor: mobileTheme.colors.accentSoft,
              color: mobileTheme.colors.accent,
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
