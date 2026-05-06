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

function clampHue(input: number) {
  const normalized = input % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

function hsla(hue: number, saturation: number, lightness: number, alpha: number) {
  return `hsla(${Math.round(clampHue(hue))}, ${saturation}%, ${lightness}%, ${alpha})`;
}

function hsl(hue: number, saturation: number, lightness: number) {
  return `hsl(${Math.round(clampHue(hue))}, ${saturation}%, ${lightness}%)`;
}

export function getServerColorTone(target: { bridgeHost: string; bridgePort: number }): ServerColorTone {
  const key = `${target.bridgeHost.trim()}:${target.bridgePort}`;
  const hash = hashString(key);
  const hue = clampHue((hash % 300) + 24);
  const accent = hsl(hue, 84, 66);

  return {
    key,
    accent,
    accentSoft: hsla(hue, 86, 64, 0.18),
    accentMuted: hsla(hue, 76, 60, 0.12),
    tabActiveBackground: hsla(hue, 88, 68, 0.42),
    tabIdleBackground: hsla(hue, 72, 58, 0.14),
    previewBackground: `linear-gradient(135deg, ${hsla(hue, 85, 66, 0.22)} 0%, rgba(17, 20, 32, 0.96) 100%)`,
    previewText: hsl(hue, 92, 76),
    lightCardBorder: hsla(hue, 66, 54, 0.24),
  };
}
