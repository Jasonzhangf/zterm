import { mobileTheme } from '../../lib/mobile-ui';

interface ConnectionsHeaderProps {
  title?: string;
  subtitle?: string;
}

export function ConnectionsHeader({
  title = 'Connections',
  subtitle = 'Your remote terminal bridges and active sessions',
}: ConnectionsHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div
          style={{
            color: mobileTheme.colors.lightText,
            fontSize: '18px',
            fontWeight: 800,
            lineHeight: 1.1,
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: mobileTheme.colors.lightMuted,
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          {subtitle}
        </div>
      </div>
    </div>
  );
}
