import { ConnectionSection } from './ConnectionSection';
import { mobileTheme } from '../../lib/mobile-ui';

interface AppearanceSectionProps {
  pinned: boolean;
  onPinnedChange: (value: boolean) => void;
}

export function AppearanceSection({ pinned, onPinnedChange }: AppearanceSectionProps) {
  return (
    <ConnectionSection title="Appearance" description="Visual emphasis and card placement preferences.">
      <button
        type="button"
        onClick={() => onPinnedChange(!pinned)}
        style={{
          width: '100%',
          minHeight: '58px',
          padding: '0 16px',
          borderRadius: '20px',
          border: `1px solid ${mobileTheme.colors.lightBorder}`,
          backgroundColor: pinned ? 'var(--zterm-settings-accent)' : 'var(--zterm-settings-field)',
          color: pinned ? 'var(--zterm-settings-accent-text)' : 'var(--zterm-settings-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        <span>Pin this connection to the top</span>
        <span>{pinned ? 'ON' : 'OFF'}</span>
      </button>

      <div
        style={{
          borderRadius: '20px',
          padding: '14px 16px',
          backgroundColor: 'var(--zterm-settings-field)',
          color: 'var(--zterm-settings-muted)',
          fontSize: '13px',
          lineHeight: 1.5,
        }}
      >
        Icon theme, terminal preview style, and card artwork stay as future extension fields. For now this section locks the
        mobile information architecture and keeps pinned state in the new layout.
      </div>
    </ConnectionSection>
  );
}
