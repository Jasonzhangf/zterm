import { useEffect, useState } from 'react';
import { useTraversalRelayAccount } from '../../hooks/useTraversalRelayAccount';
import type { TraversalRelayClientSettings } from '../../lib/bridge-settings';
import { mobileTheme } from '../../lib/mobile-ui';
import { getDefaultTraversalRelayBaseUrl } from '../../lib/traversal-relay-client';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

interface RelayAccountSettingsSectionProps {
  relaySettings?: TraversalRelayClientSettings;
  onRelaySettingsChange: (settings: TraversalRelayClientSettings | undefined) => void;
}

export function RelayAccountSettingsSection({
  relaySettings,
  onRelaySettingsChange,
}: RelayAccountSettingsSectionProps) {
  const {
    account,
    relayDevices,
    relayStatus,
    relayBusy,
    syncRelay,
    logoutRelay,
  } = useTraversalRelayAccount(relaySettings);
  const [username, setUsername] = useState(() => account?.username || relaySettings?.username || '');
  const [password, setPassword] = useState('');
  const relayHost = new URL(getDefaultTraversalRelayBaseUrl()).hostname;
  const loggedIn = Boolean(account?.accessToken || relaySettings?.accessToken);
  const accountName = account?.user?.username || account?.username || relaySettings?.username || username || 'Unknown';
  const deviceCount = relayDevices.length;
  const deviceSummary = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  const deviceId = account?.deviceId || relaySettings?.deviceId || 'zterm-android';
  const busy = relayBusy !== null;

  useEffect(() => {
    if (account?.username) {
      setUsername(account.username);
    }
  }, [account?.username]);

  const handleLogin = async () => {
    const result = await syncRelay('login', {
      relayBaseUrl: '',
      username,
      password,
    }, relaySettings);
    if (!result) {
      return;
    }
    setPassword('');
    onRelaySettingsChange(result.relaySettings);
  };

  const handleLogout = () => {
    logoutRelay();
    setPassword('');
    onRelaySettingsChange(undefined);
  };

  return (
    <div style={settingsSectionStyle()}>
      <SettingsSectionTitle>Relay Account</SettingsSectionTitle>
      <div
        style={{
          border: `1px solid ${mobileTheme.colors.lightBorder}`,
          borderRadius: '8px',
          backgroundColor: '#fff',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
          }}
        >
          <div>
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>Service</div>
            <div data-testid="settings-relay-fixed-host" style={{ marginTop: '3px', fontSize: '14px', fontWeight: 800 }}>
              {relayHost}
            </div>
          </div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: loggedIn ? '#087a46' : mobileTheme.colors.lightMuted }}>
            {loggedIn ? 'SIGNED IN' : 'OPTIONAL'}
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleLogin();
          }}
          style={{ padding: '16px', display: 'grid', gap: '14px' }}
        >
          {loggedIn ? (
            <div
              data-testid="settings-relay-signed-in-panel"
              style={{
                padding: '12px 14px',
                borderRadius: '8px',
                backgroundColor: 'rgba(8, 122, 70, 0.08)',
                border: '1px solid rgba(8, 122, 70, 0.24)',
                display: 'grid',
                gap: '5px',
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 850, color: '#087a46', textTransform: 'uppercase' }}>
                Signed in
              </div>
              <div style={{ fontSize: '15px', fontWeight: 850, color: mobileTheme.colors.lightText }}>
                {accountName}
              </div>
              <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                {deviceSummary} · device={deviceId}
              </div>
            </div>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '88px minmax(0, 1fr)',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <label htmlFor="relay-account" style={{ fontSize: '13px', fontWeight: 700 }}>
              Account
            </label>
            <input
              id="relay-account"
              aria-label="Relay account"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
              style={{ ...settingsInputStyle(), minWidth: 0 }}
            />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '88px minmax(0, 1fr)',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <label htmlFor="relay-password" style={{ fontSize: '13px', fontWeight: 700 }}>
              Password
            </label>
            <input
              id="relay-password"
              aria-label="Relay password"
              type="password"
              autoComplete="current-password"
              placeholder={loggedIn ? 'Enter password to sign in again' : ''}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              style={{ ...settingsInputStyle(), minWidth: 0 }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'stretch', gap: '10px' }}>
            <button
              type="submit"
              disabled={busy || !username.trim() || !password}
              style={{
                minHeight: '48px',
                minWidth: 0,
                flex: 1,
                border: 'none',
                borderRadius: '7px',
                backgroundColor: '#111820',
                color: '#fff',
                fontSize: '15px',
                fontWeight: 800,
                opacity: busy || !username.trim() || !password ? 0.55 : 1,
              }}
            >
              {relayBusy === 'login' ? 'Signing in...' : loggedIn ? 'Sign in again' : 'Sign in'}
            </button>
            {loggedIn ? (
              <button
                type="button"
                onClick={handleLogout}
                disabled={busy}
                style={{
                  minHeight: '48px',
                  padding: '0 16px',
                  borderRadius: '7px',
                  border: `1px solid ${mobileTheme.colors.lightBorder}`,
                  backgroundColor: '#fff',
                  color: '#a22c3f',
                  fontWeight: 800,
                }}
              >
                Sign out
              </button>
            ) : null}
          </div>

          <div
            role={relayStatus && !relayStatus.includes('已登录') ? 'alert' : 'status'}
            style={{
              minHeight: '20px',
              fontSize: '12px',
              lineHeight: 1.5,
              color: relayStatus && !relayStatus.includes('已登录') ? '#a22c3f' : mobileTheme.colors.lightMuted,
            }}
          >
            {relayStatus || (loggedIn
              ? `Signed in as ${account?.user?.username || account?.username || username} · ${relayDevices.length} device${relayDevices.length === 1 ? '' : 's'}`
              : 'Credentials are sent only to the fixed relay service.')}
          </div>
        </form>
      </div>
    </div>
  );
}
