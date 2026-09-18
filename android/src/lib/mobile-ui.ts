export const mobileTheme = {
  colors: {
    shell: 'var(--zterm-settings-background, #f0f2f4)',
    shellMuted: 'var(--zterm-settings-field, #eef0f2)',
    canvas: 'var(--zterm-settings-background, #f0f2f4)',
    card: 'var(--zterm-settings-surface, #ffffff)',
    cardBorder: 'var(--zterm-settings-border, rgba(17, 19, 21, 0.14))',
    cardSoft: 'var(--zterm-settings-field, #eef0f2)',
    accent: 'var(--zterm-settings-accent, #128354)',
    accentSoft: 'color-mix(in srgb, var(--zterm-settings-accent, #128354) 16%, transparent)',
    textPrimary: 'var(--zterm-settings-text, #111315)',
    textSecondary: 'var(--zterm-settings-muted, #62676f)',
    textMuted: 'var(--zterm-settings-muted, #62676f)',
    danger: 'var(--zterm-settings-danger, #b4233a)',
    lightBg: 'var(--zterm-settings-background, #edf2f6)',
    lightCard: 'var(--zterm-settings-surface, #ffffff)',
    lightBorder: 'var(--zterm-settings-border, #d5dde6)',
    lightText: 'var(--zterm-settings-text, #111315)',
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
  danger: string;
  shadow: string;
  isDark: boolean;
}

export function resolveSettingsTheme(shellSkin: string | undefined): SettingsTheme {
  if (shellSkin === 'black' || shellSkin === 'blue') {
    return {
      background: '#16191f',
      surface: '#20252d',
      field: '#1b1f26',
      text: '#f2f5fa',
      muted: '#a7afbc',
      border: 'rgba(255,255,255,0.12)',
      accent: '#f2f5fa',
      accentText: '#111315',
      danger: '#ff7a86',
      shadow: '0 14px 30px rgba(0,0,0,0.46)',
      isDark: true,
    };
  }
  return {
    background: '#f0f2f4',
    surface: '#ffffff',
    field: '#eef0f2',
    text: '#111315',
    muted: '#62676f',
    border: 'rgba(17,19,21,0.14)',
    accent: '#111315',
    accentText: '#ffffff',
    danger: '#b4233a',
    shadow: '0 12px 30px rgba(17,19,21,0.10)',
    isDark: false,
  };
}
