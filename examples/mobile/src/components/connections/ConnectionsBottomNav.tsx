import { mobileTheme } from '../../lib/mobile-ui';

const items = [
  { label: 'Vaults', icon: '◧', page: 'vaults' as const },
  { label: 'Connections', icon: '⌘', page: 'connections' as const },
  { label: 'Settings', icon: '⚙', page: 'settings' as const },
];

interface ConnectionsBottomNavProps {
  activePage: 'connections' | 'settings';
  onOpenConnections: () => void;
  onOpenSettings: () => void;
}

export function ConnectionsBottomNav({ activePage, onOpenConnections, onOpenSettings }: ConnectionsBottomNavProps) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        marginTop: 'auto',
        padding: `18px 22px ${mobileTheme.safeArea.bottom}`,
        background: 'linear-gradient(180deg, rgba(237,242,246,0) 0%, rgba(237,242,246,0.92) 18%, rgba(237,242,246,1) 100%)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        {items.map((item) => {
          const active = item.page === activePage;

          return (
            <button
              key={item.label}
              onClick={() => (item.page === 'settings' ? onOpenSettings() : onOpenConnections())}
              style={{
                border: 'none',
                background: 'transparent',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '10px',
                color: active ? mobileTheme.colors.lightText : mobileTheme.colors.lightMuted,
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              <div
                style={{
                  minWidth: '88px',
                  height: '56px',
                  borderRadius: '24px',
                  backgroundColor: active ? mobileTheme.colors.lightAccent : 'transparent',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: '24px',
                }}
              >
                {item.icon}
              </div>
              <span style={{ fontSize: '14px' }}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
