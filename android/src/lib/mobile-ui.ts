export const mobileTheme = {
  colors: {
    shell: '#171b2d',
    shellMuted: '#242a41',
    canvas: '#111420',
    card: '#1a2033',
    cardBorder: 'rgba(255, 255, 255, 0.08)',
    cardSoft: '#2b3149',
    accent: '#1fd67a',
    accentSoft: 'rgba(31, 214, 122, 0.18)',
    textPrimary: '#ffffff',
    textSecondary: '#97a2ba',
    textMuted: '#667089',
    danger: '#ff7c92',
    lightBg: 'var(--zterm-settings-background, #edf2f6)',
    lightCard: 'var(--zterm-settings-surface, #ffffff)',
    lightBorder: 'var(--zterm-settings-border, #d5dde6)',
    lightText: 'var(--zterm-settings-text, #171b2d)',
    lightMuted: 'var(--zterm-settings-muted, #7b8aa1)',
    lightAccent: 'var(--zterm-settings-field, #b8d8fb)',
  },
  safeArea: {
    top: 'calc(16px + env(safe-area-inset-top, 0px))',
    bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
  },
  radius: {
    page: 28,
    card: 24,
    pill: 22,
    button: 20,
  },
  shadow: {
    soft: '0 18px 40px rgba(14, 19, 33, 0.12)',
    strong: '0 22px 40px rgba(0, 0, 0, 0.28)',
  },
};

export interface SettingsTheme {
  background: string;
  surface: string;
  field: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  shadow: string;
}

export function resolveSettingsTheme(shellSkin: string | undefined): SettingsTheme {
  if (shellSkin === 'blue' || shellSkin === 'black') {
    return {
      background: shellSkin === 'black' ? '#101114' : '#111420',
      surface: shellSkin === 'black' ? '#1a1b1f' : '#20283a',
      field: shellSkin === 'black' ? '#24252a' : '#252d40',
      text: '#f1f5fb',
      muted: shellSkin === 'black' ? '#a4a8b2' : '#97a2ba',
      border: shellSkin === 'black' ? 'rgba(255,255,255,.14)' : 'rgba(190,212,244,.16)',
      accent: shellSkin === 'black' ? '#7dd3fc' : '#7ddfff',
      accentText: '#081018',
      shadow: '0 18px 40px rgba(0,0,0,.28)',
    };
  }
  return {
    background: '#edf2f6',
    surface: '#ffffff',
    field: '#f7f9fc',
    text: '#171b2d',
    muted: '#7b8aa1',
    border: '#d5dde6',
    accent: '#128354',
    accentText: '#ffffff',
    shadow: mobileTheme.shadow.soft,
  };
}
