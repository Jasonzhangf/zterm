export interface ServerColorTone {
  key: string;
  accent: string;
  accentSoft: string;
  accentMuted: string;
  tabActiveBackground: string;
  tabIdleBackground: string;
  previewBackground: string;
  previewText: string;
  lightCardBorder: string;
}

export function getServerColorTone(target: { bridgeHost: string; bridgePort: number }): ServerColorTone {
  const key = `${target.bridgeHost.trim()}:${target.bridgePort}`;
  return getServerColorToneByKey(key);
}

export function getServerColorToneByKey(key: string): ServerColorTone {
  return {
    key,
    accent: 'var(--zterm-panel-accent)',
    accentSoft: 'var(--zterm-panel-accent-soft)',
    accentMuted: 'color-mix(in srgb, var(--zterm-panel-accent) 9%, transparent)',
    tabActiveBackground: 'var(--zterm-panel-accent-soft)',
    tabIdleBackground: 'var(--zterm-panel-surface)',
    previewBackground: 'var(--zterm-panel-surface)',
    previewText: 'var(--zterm-panel-muted)',
    lightCardBorder: 'var(--zterm-panel-border)',
  };
}
