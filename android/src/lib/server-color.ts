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

const SERVER_COLOR_PALETTE = [
  210, // blue
  142, // green
  45,  // yellow
  12,  // red-orange
  188, // cyan
  96,  // lime
  28,  // orange
  4,   // red
  224, // royal blue
  158, // emerald
  54,  // amber
  18,  // warm red
  198, // teal-blue
  118, // leaf green
  36,  // gold-orange
  0,   // red
];

export function getServerColorTone(target: { bridgeHost: string; bridgePort: number }): ServerColorTone {
  const key = `${target.bridgeHost.trim()}:${target.bridgePort}`;
  return getServerColorToneByKey(key);
}

export function getServerColorToneByKey(key: string): ServerColorTone {
  const hash = hashString(key);
  const hue = SERVER_COLOR_PALETTE[hash % SERVER_COLOR_PALETTE.length] ?? SERVER_COLOR_PALETTE[0];
  const accent = hsl(hue, 82, 62);

  return {
    key,
    accent,
    accentSoft: hsla(hue, 78, 58, 0.18),
    accentMuted: hsla(hue, 70, 54, 0.12),
    tabActiveBackground: hsla(hue, 76, 58, 0.34),
    tabIdleBackground: hsla(hue, 62, 50, 0.12),
    previewBackground: `linear-gradient(135deg, ${hsla(hue, 78, 58, 0.20)} 0%, rgba(17, 20, 32, 0.96) 100%)`,
    previewText: hsl(hue, 84, 72),
    lightCardBorder: hsla(hue, 62, 48, 0.28),
  };
}
