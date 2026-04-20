import { mobileTheme } from '../../lib/mobile-ui';

interface ConnectionFabProps {
  onClick?: () => void;
}

export function ConnectionFab({ onClick }: ConnectionFabProps) {
  return (
    <button
      onClick={onClick}
      aria-label="新建连接"
      style={{
        position: 'fixed',
        right: '22px',
        bottom: 'calc(116px + env(safe-area-inset-bottom, 0px))',
        width: '68px',
        height: '68px',
        borderRadius: '24px',
        border: 'none',
        backgroundColor: mobileTheme.colors.shell,
        color: mobileTheme.colors.textPrimary,
        fontSize: '34px',
        boxShadow: mobileTheme.shadow.strong,
        cursor: 'pointer',
      }}
    >
      +
    </button>
  );
}
