import { useState } from 'react';
import { TERMINAL_THEME_OPTIONS, getTerminalThemePreset } from '@zterm/shared';
import { mobileTheme } from '../../lib/mobile-ui';
import type { BridgeSettings } from '../../lib/bridge-settings';
import { SettingsSectionTitle, settingsSectionStyle } from './SettingsSection';

interface TerminalThemeSectionProps {
  terminalThemeId: BridgeSettings['terminalThemeId'];
  onSelectTheme: (themeId: BridgeSettings['terminalThemeId']) => void;
}

export function TerminalThemeSection({
  terminalThemeId,
  onSelectTheme,
}: TerminalThemeSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const selectedTerminalTheme = getTerminalThemePreset(terminalThemeId);

  return (
    <div style={settingsSectionStyle()}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          textAlign: 'left',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <SettingsSectionTitle>Terminal Theme</SettingsSectionTitle>
        <span style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, fontWeight: 700, flexShrink: 0 }}>
          {expanded ? '收起 ▴' : `${selectedTerminalTheme.name} · 展开 ▾`}
        </span>
      </button>
      {expanded ? (
        <>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            这里会改终端 ANSI 16 色映射和默认前景/背景色。当前：{selectedTerminalTheme.name}。点主题卡会即时生效并持久化。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '12px' }}>
            {TERMINAL_THEME_OPTIONS.map((theme) => {
              const active = terminalThemeId === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => onSelectTheme(theme.id)}
                  style={{
                    borderRadius: '20px',
                    border: active ? `2px solid ${mobileTheme.colors.accent}` : `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: 'var(--zterm-settings-surface, #ffffff)',
                    color: 'var(--zterm-settings-text)',
                    padding: '14px',
                    cursor: 'pointer',
                    boxShadow: active ? '0 12px 26px rgba(31,214,122,0.14)' : mobileTheme.shadow.soft,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 800 }}>{theme.name}</div>
                      <div style={{ marginTop: '4px', fontSize: '11px', color: mobileTheme.colors.lightMuted }}>{theme.family}</div>
                    </div>
                    <div style={{ fontSize: '11px', color: active ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted, fontWeight: 800 }}>
                      {active ? 'ACTIVE' : 'USE'}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: '12px',
                      borderRadius: '14px',
                      overflow: 'hidden',
                      border: `1px solid ${mobileTheme.colors.lightBorder}`,
                      backgroundColor: theme.background,
                    }}
                  >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))' }}>
                  {theme.colors.map((color, index) => (
                    <div
                      key={`${theme.id}-${index}`}
                      style={{
                        height: '16px',
                        backgroundColor: color,
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    padding: '10px 12px',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: theme.foreground,
                    backgroundColor: theme.background,
                  }}
                >
                  <span style={{ color: theme.colors[2] }}>ls</span>
                  <span> </span>
                  <span style={{ color: theme.colors[4] }}>~/workspace</span>
                  <span style={{ color: theme.colors[3] }}> $</span>
                </div>
              </div>

              <div style={{ marginTop: '10px', fontSize: '12px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
                {theme.description}
              </div>
            </button>
          );
        })}
          </div>
        </>
      ) : null}
    </div>
  );
}
